/**
 * ssh.js — SSH 连接管理器
 *
 * 每个 SshConnection 封装一条 ssh2 连接 + 一个 shell 通道,
 * 通过回调把终端数据流转发给 WebSocket 层。
 * 同时支持 SFTP 子会话与端口转发。
 */
'use strict';

const { Client } = require('ssh2');
const store = require('./store');
const { TelnetConnection, RloginConnection } = require('./telnet');

class SshConnection {
  constructor(id, cfg) {
    this.id = id;
    this.cfg = cfg;               // 完整会话配置(含明文密码/私钥路径)
    this.client = null;
    this.stream = null;           // shell stream
    this.state = 'disconnected';  // connecting | ready | closed
    this.onData = null;           // (data) => {}
    this.onClose = null;          // (reason) => {}
    this.onError = null;          // (msg) => {}
    this.logging = !!cfg.logSession;
  }

  connect() {
    return new Promise((resolve, reject) => {
      const c = new Client();
      this.client = c;
      this.state = 'connecting';

      const connectOpts = {
        host: this.cfg.host,
        port: parseInt(this.cfg.port, 10) || 22,
        username: this.cfg.username,
        readyTimeout: parseInt(this.cfg.connectTimeout, 10) || 20000,
        // 保活:默认开启(除非会话显式关闭 keepalive)。否则连接空闲几分钟后
        // 会被服务端 ClientAliveInterval 或中间 NAT/防火墙的空闲超时断开。
        keepaliveInterval: this.cfg.keepalive === false ? 0 : 10000,
        keepaliveCountMax: 3,
        algorithms: {
          kex: this._split(this.cfg.kex),
          cipher: this._split(this.cfg.cipher)
        }
      };

      const authType = this.cfg.authType || 'password';
      if (authType === 'password') {
        connectOpts.password = this.cfg.password || '';
      } else if (authType === 'key') {
        connectOpts.privateKey = this._loadKey(this.cfg.keyPath, this.cfg.keyName);
        connectOpts.passphrase = this.cfg.passphrase || undefined;
      } else if (authType === 'keyboard-interactive') {
        connectOpts.tryKeyboard = true;
        connectOpts.password = this.cfg.password || '';
      }

      c.on('ready', () => {
        this.state = 'ready';
        // 打开 shell 通道
        c.shell({ term: this.cfg.term || 'xterm-256color', cols: this.cfg.cols || 80, rows: this.cfg.rows || 24 }, (err, stream) => {
          if (err) return reject(err);
          this.stream = stream;
          stream.on('data', (d) => {
            if (this.logging) store.appendLog(this.cfg.id || this.id, d);
            if (this.onData) this.onData(d);
          });
          stream.on('close', () => this._cleanup('shell-closed'));
          stream.stderr && stream.stderr.on('data', (d) => {
            if (this.onData) this.onData(d);
          });
          resolve();
        });
      });

      c.on('error', (err) => {
        this.state = 'closed';
        const msg = err.message || String(err);
        if (this.onError) this.onError(msg);
        if (this.state === 'connecting') reject(err);
        else this._cleanup('error:' + msg);
      });

      c.on('close', () => {
        this._cleanup('connection-closed');
      });

      try {
        c.connect(connectOpts);
      } catch (e) {
        reject(e);
      }
    });
  }

  _split(v) {
    return (v || '').split(',').map(s => s.trim()).filter(Boolean);
  }

  _loadKey(keyPath, keyName) {
    const fs = require('fs');
    const path = require('path');
    if (keyPath && fs.existsSync(keyPath)) {
      return fs.readFileSync(keyPath);
    }
    if (keyName) {
      const p = path.join(store.KEYS_DIR, keyName.replace(/[\\/:*?"<>|]/g, '_'));
      if (fs.existsSync(p)) return fs.readFileSync(p);
    }
    throw new Error('私钥文件不存在: ' + (keyName || keyPath));
  }

  write(data) {
    if (this.stream && this.stream.writable) {
      this.stream.write(data);
    }
  }

  resize(cols, rows) {
    if (this.stream && this.stream.setWindow) {
      try { this.stream.setWindow(rows, cols, 0, 0); } catch (e) {}
    }
  }

  close() {
    this._cleanup('user-disconnect');
  }

  _cleanup(reason) {
    if (this.state === 'closed') return;
    this.state = 'closed';
    try { this.stream && this.stream.end(); } catch (e) {}
    try { this.client && this.client.end(); } catch (e) {}
    if (this.onClose) this.onClose(reason);
  }

  // 返回 SFTP 客户端 Promise
  sftp() {
    return new Promise((resolve, reject) => {
      if (this.state !== 'ready' || !this.client) return reject(new Error('连接未就绪'));
      this.client.sftp((err, sftp) => {
        if (err) return reject(err);
        resolve(sftp);
      });
    });
  }

  // 在现有连接上执行单条命令(exec 通道,不影响交互 shell),返回 stdout/stderr
  exec(cmd) {
    return new Promise((resolve, reject) => {
      if (this.state !== 'ready' || !this.client) return reject(new Error('连接未就绪'));
      this.client.exec(cmd, (err, stream) => {
        if (err) return reject(err);
        let out = '', errOut = '';
        stream.on('data', (d) => { out += d.toString('utf8'); });
        if (stream.stderr) stream.stderr.on('data', (d) => { errOut += d.toString('utf8'); });
        stream.on('error', (e) => reject(e));
        stream.on('close', () => resolve({ stdout: out, stderr: errOut }));
      });
    });
  }
}

class ConnectionManager {
  constructor() {
    this.conns = new Map(); // id -> SshConnection
    this.tunnels = new Map(); // id -> Tunnel
  }

  create(id, cfg) {
    const proto = (cfg.protocol || 'ssh').toLowerCase();
    let c;
    if (proto === 'telnet') c = new TelnetConnection(id, cfg);
    else if (proto === 'rlogin') c = new RloginConnection(id, cfg);
    else c = new SshConnection(id, cfg);
    this.conns.set(id, c);
    return c;
  }

  get(id) {
    return this.conns.get(id);
  }

  remove(id) {
    const c = this.conns.get(id);
    if (c) c.close();
    this.conns.delete(id);
  }

  // 按 会话id 关闭该会话的所有连接(同一会话可能同时开了多个标签连接)
  removeBySession(sessionId) {
    for (const [id, c] of [...this.conns]) {
      if (c.cfg && c.cfg.id === sessionId) {
        c.close();
        this.conns.delete(id);
      }
    }
  }

  closeAll() {
    for (const id of this.conns.keys()) this.remove(id);
  }
}

module.exports = { SshConnection, ConnectionManager };
