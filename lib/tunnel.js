/**
 * tunnel.js — SSH 端口转发
 *
 * 支持三种模式(SSH 端口转发):
 *  - local   本地转发: 监听本地端口,经 SSH 转发到远端 host:port
 *  - remote  远程转发: 在远端监听端口,经 SSH 转发回本地 host:port
 *  - dynamic 动态转发: 本地 SOCKS5 代理(no-auth, CONNECT),可作系统代理上网
 */
'use strict';

const net = require('net');

class Tunnel {
  constructor(id, cfg) {
    this.id = id;
    this.cfg = cfg; // { mode, listenHost, listenPort, targetHost, targetPort }
    this.server = null;
    this.socksServer = null;
    this.closed = false;
  }

  async start(conn) {
    const { mode } = this.cfg;
    if (mode === 'local') return this._startLocal(conn);
    if (mode === 'remote') return this._startRemote(conn);
    if (mode === 'dynamic') return this._startDynamic(conn);
    throw new Error('未知转发模式: ' + mode);
  }

  // 本地转发
  _startLocal(conn) {
    return new Promise((resolve, reject) => {
      const srv = net.createServer((socket) => {
        conn.client.forwardOut(
          this.cfg.listenHost || '127.0.0.1',
          this.cfg.listenPort,
          this.cfg.targetHost,
          this.cfg.targetPort,
          (err, stream) => {
            if (err) { socket.destroy(); return; }
            socket.pipe(stream).pipe(socket);
          }
        );
      });
      srv.on('error', reject);
      srv.listen(this.cfg.listenPort, this.cfg.listenHost || '127.0.0.1', () => {
        this.server = srv;
        resolve();
      });
    });
  }

  // 远程转发
  _startRemote(conn) {
    return new Promise((resolve, reject) => {
      conn.client.forwardIn(
        this.cfg.listenHost || '127.0.0.1',
        this.cfg.listenPort,
        (err) => {
          if (err) return reject(err);
          resolve();
        }
      );
      conn.client.on('tcp connection', (info, accept, rejectCb) => {
        const socket = net.connect(this.cfg.targetPort, this.cfg.targetHost, () => {
          const stream = accept();
          socket.pipe(stream).pipe(socket);
        });
        socket.on('error', rejectCb);
      });
    });
  }

  // 动态转发(SOCKS5)
  _startDynamic(conn) {
    return new Promise((resolve, reject) => {
      const srv = net.createServer((socket) => this._handleSocks(socket, conn));
      srv.on('error', reject);
      srv.listen(this.cfg.listenPort, this.cfg.listenHost || '127.0.0.1', () => {
        this.server = srv;
        resolve();
      });
    });
  }

  _handleSocks(socket, conn) {
    socket.once('data', (buf) => {
      // RFC1928 握手
      if (buf[0] !== 0x05) return socket.destroy();
      const nmethods = buf[1];
      const methods = buf.slice(2, 2 + nmethods);
      if (methods.includes(0x00)) {
        socket.write(Buffer.from([0x05, 0x00])); // 无认证
      } else {
        socket.write(Buffer.from([0x05, 0xff]));
        return socket.destroy();
      }

      socket.once('data', (req) => {
        if (req[0] !== 0x05 || req[1] !== 0x01) return socket.destroy(); // 仅支持 CONNECT
        let host, port;
        const atyp = req[3];
        let rest;
        if (atyp === 0x01) { // IPv4
          host = req.slice(4, 8).join('.');
          port = req.readUInt16BE(8);
        } else if (atyp === 0x03) { // 域名
          const len = req[4];
          host = req.slice(5, 5 + len).toString('utf8');
          port = req.readUInt16BE(5 + len);
        } else if (atyp === 0x04) { // IPv6
          const parts = [];
          for (let i = 0; i < 8; i++) parts.push(req.readUInt16BE(4 + i * 2).toString(16));
          host = parts.join(':');
          port = req.readUInt16BE(20);
        } else {
          return socket.destroy();
        }

        conn.client.forwardOut('127.0.0.1', 0, host, port, (err, stream) => {
          if (err) {
            socket.write(Buffer.from([0x05, 0x01, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
            return socket.destroy();
          }
          socket.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
          socket.pipe(stream).pipe(socket);
        });
      });
    });
    socket.on('error', () => {});
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    try { this.server && this.server.close(); } catch (e) {}
  }
}

module.exports = { Tunnel };
