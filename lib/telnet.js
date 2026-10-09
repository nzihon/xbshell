/**
 * telnet.js — Telnet 与 Rlogin 连接(纯 JS,基于 net)
 *
 * 与 SshConnection 保持相同接口(connect/write/resize/close/onData/onClose/onError/state),
 * 供 ConnectionManager 按协议统一调度,复用同一套 WebSocket 数据通道。
 */
'use strict';

const net = require('net');
const store = require('./store');

// Telnet RFC854 常量
const IAC = 255, DONT = 254, DO = 253, WONT = 252, WILL = 251, SB = 250, SE = 240;
const OPT_ECHO = 1, OPT_SGA = 3, OPT_TTYPE = 24, OPT_NAWS = 31;

class TelnetConnection {
  constructor(id, cfg) {
    this.id = id;
    this.cfg = cfg;
    this.socket = null;
    this.state = 'disconnected';
    this.onData = null;
    this.onClose = null;
    this.onError = null;
    this.logging = !!cfg.logSession;
    this._cols = parseInt(cfg.cols, 10) || 80;
    this._rows = parseInt(cfg.rows, 10) || 24;
    this._buf = Buffer.alloc(0);
  }

  connect() {
    return new Promise((resolve, reject) => {
      const port = parseInt(this.cfg.port, 10) || 23;
      const sock = net.connect({ host: this.cfg.host, port });
      this.socket = sock;
      this.state = 'connecting';

      sock.setNoDelay(true);
      sock.on('connect', () => {
        this.state = 'ready';
        this._sendRaw([IAC, WILL, OPT_TTYPE]); // 声明终端类型
        this._sendRaw([IAC, WILL, OPT_NAWS]);  // 声明窗口大小
        resolve();
      });
      sock.on('data', (d) => {
        const out = this._decode(d);
        if (out.length) {
          if (this.logging) store.appendLog(this.cfg.id || this.id, out);
          if (this.onData) this.onData(out);
        }
      });
      sock.on('error', (err) => {
        const msg = err.message || String(err);
        if (this.onError) this.onError(msg);
        if (this.state === 'connecting') reject(err);
        else this._cleanup('error:' + msg);
      });
      sock.on('close', () => this._cleanup('connection-closed'));
    });
  }

  write(data) {
    if (!this.socket || this.socket.destroyed) return;
    // 输出转义:0xFF → 0xFF 0xFF
    const buf = Buffer.from(data);
    const parts = [];
    let start = 0;
    for (let i = 0; i < buf.length; i++) {
      if (buf[i] === IAC) {
        if (i > start) parts.push(buf.slice(start, i));
        parts.push(Buffer.from([IAC, IAC]));
        start = i + 1;
      }
    }
    if (start < buf.length) parts.push(buf.slice(start));
    this.socket.write(Buffer.concat(parts));
  }

  resize(cols, rows) {
    this._cols = cols; this._rows = rows;
    this._sendNaws();
  }

  close() { this._cleanup('user-disconnect'); }

  _cleanup(reason) {
    if (this.state === 'closed') return;
    this.state = 'closed';
    try { this.socket && this.socket.end(); } catch (e) {}
    try { this.socket && this.socket.destroy(); } catch (e) {}
    if (this.onClose) this.onClose(reason);
  }

  _sendRaw(bytes) {
    try { this.socket && this.socket.write(Buffer.from(bytes)); } catch (e) {}
  }

  _sendNaws() {
    this._sendRaw([IAC, SB, OPT_NAWS,
      (this._cols >> 8) & 0xff, this._cols & 0xff,
      (this._rows >> 8) & 0xff, this._rows & 0xff,
      IAC, SE]);
  }

  _sendTtype() {
    const term = (this.cfg.term || 'xterm-256color');
    this._sendRaw([IAC, SB, OPT_TTYPE, 0].concat([...Buffer.from(term)]).concat([IAC, SE]));
  }

  // 解码:剥离 IAC 协商序列,返回纯数据
  _decode(chunk) {
    this._buf = Buffer.concat([this._buf, chunk]);
    const buf = this._buf;
    const outParts = [];
    let outStart = 0, i = 0;
    const emit = () => { if (i > outStart) outParts.push(buf.slice(outStart, i)); };

    while (i < buf.length) {
      if (buf[i] !== IAC) { i++; continue; }
      if (i + 1 >= buf.length) break; // 不完整,等更多字节
      const cmd = buf[i + 1];
      if (cmd === IAC) { // 字面 0xFF
        emit();
        outParts.push(Buffer.from([IAC]));
        i += 2; outStart = i; continue;
      }
      if (cmd === WILL || cmd === WONT || cmd === DO || cmd === DONT) {
        if (i + 2 >= buf.length) break;
        const opt = buf[i + 2];
        this._negotiate(cmd, opt);
        emit();
        i += 3; outStart = i; continue;
      }
      if (cmd === SB) {
        const se = buf.indexOf(Buffer.from([IAC, SE]), i + 2);
        if (se === -1) break;
        this._subnegotiate(buf.slice(i + 2, se));
        emit();
        i = se + 2; outStart = i; continue;
      }
      // 其他 IAC 命令(NOP/GA/…),跳过
      emit();
      i += 2; outStart = i;
    }
    emit();
    this._buf = buf.slice(outStart);
    return Buffer.concat(outParts);
  }

  _negotiate(cmd, opt) {
    if (cmd === WILL) {
      // 接受 echo 与 SGA 可让输出更顺畅;其余拒绝
      if (opt === OPT_ECHO || opt === OPT_SGA) this._sendRaw([IAC, DO, opt]);
      else this._sendRaw([IAC, DONT, opt]);
    } else if (cmd === DO) {
      if (opt === OPT_NAWS) this._sendNaws();
      else if (opt === OPT_TTYPE) this._sendTtype();
      else this._sendRaw([IAC, WONT, opt]);
    }
    // WONT / DONT:忽略
  }

  _subnegotiate(sub) {
    if (sub[0] === OPT_TTYPE && sub[1] === 1) { // TTYPE SEND
      this._sendTtype();
    }
  }
}

// ---------- Rlogin ----------
class RloginConnection {
  constructor(id, cfg) {
    this.id = id;
    this.cfg = cfg;
    this.socket = null;
    this.state = 'disconnected';
    this.onData = null;
    this.onClose = null;
    this.onError = null;
    this.logging = !!cfg.logSession;
    this._cols = parseInt(cfg.cols, 10) || 80;
    this._rows = parseInt(cfg.rows, 10) || 24;
    this._buf = Buffer.alloc(0);
  }

  connect() {
    return new Promise((resolve, reject) => {
      const port = parseInt(this.cfg.port, 10) || 513;
      const sock = net.connect({ host: this.cfg.host, port });
      this.socket = sock;
      this.state = 'connecting';
      sock.setNoDelay(true);
      sock.on('connect', () => {
        // 握手: \0 客户端用户名 \0 服务器用户名 \0 终端类型/速度 \0
        const clientUser = this.cfg.username || 'root';
        const serverUser = this.cfg.rloginUser || this.cfg.username || 'root';
        const term = (this.cfg.term || 'xterm') + '/38400';
        sock.write('\0' + clientUser + '\0' + serverUser + '\0' + term + '\0');
        this.state = 'ready';
        resolve();
      });
      sock.on('data', (d) => {
        const out = this._decode(d);
        if (out.length) {
          if (this.logging) store.appendLog(this.cfg.id || this.id, out);
          if (this.onData) this.onData(out);
        }
      });
      sock.on('error', (err) => {
        const msg = err.message || String(err);
        if (this.onError) this.onError(msg);
        if (this.state === 'connecting') reject(err);
        else this._cleanup('error:' + msg);
      });
      sock.on('close', () => this._cleanup('connection-closed'));
    });
  }

  write(data) {
    if (!this.socket || this.socket.destroyed) return;
    const buf = Buffer.from(data);
    const parts = [];
    let start = 0;
    for (let i = 0; i < buf.length; i++) {
      if (buf[i] === 0xff) {
        if (i > start) parts.push(buf.slice(start, i));
        parts.push(Buffer.from([0xff, 0xff]));
        start = i + 1;
      }
    }
    if (start < buf.length) parts.push(buf.slice(start));
    this.socket.write(Buffer.concat(parts));
  }

  resize(cols, rows) {
    this._cols = cols; this._rows = rows;
    // Rlogin 窗口大小:0xFF 0x73 后跟 行/列 各 2 字节(小端)
    this._sendRaw([0xff, 0x73, this._rows & 0xff, (this._rows >> 8) & 0xff,
      this._cols & 0xff, (this._cols >> 8) & 0xff]);
  }

  close() { this._cleanup('user-disconnect'); }

  _cleanup(reason) {
    if (this.state === 'closed') return;
    this.state = 'closed';
    try { this.socket && this.socket.end(); } catch (e) {}
    try { this.socket && this.socket.destroy(); } catch (e) {}
    if (this.onClose) this.onClose(reason);
  }

  _sendRaw(bytes) {
    try { this.socket && this.socket.write(Buffer.from(bytes)); } catch (e) {}
  }

  // server→client:0xFF 后跟控制字节;0x73 表示窗口大小(4 字节),其余为流控
  _decode(chunk) {
    this._buf = Buffer.concat([this._buf, chunk]);
    const buf = this._buf;
    const outParts = [];
    let outStart = 0, i = 0;
    const emit = () => { if (i > outStart) outParts.push(buf.slice(outStart, i)); };
    while (i < buf.length) {
      if (buf[i] !== 0xff) { i++; continue; }
      if (i + 1 >= buf.length) break;
      const cmd = buf[i + 1];
      if (cmd === 0xff) { emit(); outParts.push(Buffer.from([0xff])); i += 2; outStart = i; continue; }
      if (cmd === 0x73) { // 窗口大小
        if (i + 6 >= buf.length) break;
        emit(); i += 6; outStart = i; continue;
      }
      // 其他控制字节(流控等),丢弃
      emit(); i += 2; outStart = i;
    }
    emit();
    this._buf = buf.slice(outStart);
    return Buffer.concat(outParts);
  }
}

module.exports = { TelnetConnection, RloginConnection };
