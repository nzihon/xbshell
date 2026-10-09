/**
 * server.js — XBTerminal 主服务
 *
 *  - Express 静态服务 + REST API(会话/设置/密钥/日志)
 *  - WebSocket: /ws/terminal(终端会话)、/ws/sftp(SFTP 文件浏览器)
 *  - 支持协议: SSH / Telnet / Rlogin
 */
'use strict';

const path = require('path');
const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');
const crypto = require('crypto');

const store = require('./lib/store');
const { ConnectionManager } = require('./lib/ssh');
const { Tunnel } = require('./lib/tunnel');

const PORT = parseInt(process.env.PORT, 10) || 8080;
const app = express();
const server = http.createServer(app);
const manager = new ConnectionManager();

app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const uid = () => crypto.randomUUID().slice(0, 8);

// ---------- 会话 REST ----------
app.get('/api/sessions', (req, res) => {
  res.json(store.loadSessions().map(s => store.sanitizeSession(s)));
});

app.post('/api/sessions', (req, res) => {
  const sessions = store.loadSessions();
  const s = Object.assign({
    id: uid(), name: '', host: '', port: 22, username: '', protocol: 'ssh',
    authType: 'password', password: '', keyName: '', passphrase: '',
    term: 'xterm-256color', logSession: false, keepalive: true,
    quickCommands: [], group: ''
  }, req.body);
  if (s.password) s.password = store.encrypt(s.password);
  if (s.passphrase) s.passphrase = store.encrypt(s.passphrase);
  sessions.push(s);
  store.saveSessions(sessions);
  res.json(store.sanitizeSession(s));
});

app.put('/api/sessions/:id', (req, res) => {
  const sessions = store.loadSessions();
  const i = sessions.findIndex(x => x.id === req.params.id);
  if (i < 0) return res.status(404).json({ error: 'not found' });
  const body = req.body;
  const cur = sessions[i];
  const next = Object.assign({}, cur, body, { id: cur.id });
  // 密码/口令仅在有新值时更新
  if (body.password === '') next.password = '';
  else if (body.password) next.password = store.encrypt(body.password);
  if (body.passphrase === '') next.passphrase = '';
  else if (body.passphrase) next.passphrase = store.encrypt(body.passphrase);
  sessions[i] = next;
  store.saveSessions(sessions);
  res.json(store.sanitizeSession(next));
});

app.delete('/api/sessions/:id', (req, res) => {
  const sessions = store.loadSessions().filter(x => x.id !== req.params.id);
  store.saveSessions(sessions);
  manager.removeBySession(req.params.id); // 关闭该会话的所有连接(可能开了多个标签)
  res.json({ ok: true });
});

// ---------- 远程主机监控(通过 SSH exec 采集,当前支持 Linux) ----------
const _remoteCpuCache = new Map(); // sessionId -> { total, idle }
// 一条命令采集主机/系统/运行时间/负载/内存/CPU 统计,输出 KEY=value 行便于解析
const REMOTE_STATS_CMD = [
  'echo "HOST=$(hostname)"',
  'echo "SYS=$(uname -s -r -m)"',
  'echo "CORES=$(nproc)"',
  "echo \"UP=$(awk '{print int($1)}' /proc/uptime)\"",
  'echo "LOAD=$(cat /proc/loadavg)"',
  "echo \"MEM=$(awk '/^MemTotal:/{t=$2} /^MemAvailable:/{a=$2} END{print t, a}' /proc/meminfo)\"",
  "echo \"CPU=$(awk 'NR==1{print $2+$3+$4+$5+$6+$7+$8+$9, $5+$6}' /proc/stat)\""
].join('; ');

app.get('/api/remote-stats', async (req, res) => {
  const sessionId = req.query.sessionId;
  if (!sessionId) return res.status(400).json({ connected: false, error: '缺少 sessionId' });
  const conn = manager.get(sessionId);
  if (!conn || conn.state !== 'ready') {
    return res.json({ connected: false, error: '会话未连接,请先建立 SSH 连接' });
  }
  if (typeof conn.exec !== 'function') {
    return res.json({ connected: false, error: '当前协议不支持远程监控(仅 SSH)' });
  }
  try {
    const { stdout } = await conn.exec(REMOTE_STATS_CMD);
    const data = {};
    for (const line of stdout.split('\n')) {
      const m = line.match(/^(\w+)=(.*)$/);
      if (m) data[m[1]] = m[2].trim();
    }
    if (!data.CPU || !data.MEM) {
      return res.json({ connected: true, error: '远程系统不支持(需 Linux)' });
    }
    // CPU 使用率:两次采样差值
    const [total, idle] = data.CPU.split(/\s+/).map(Number);
    let cpu = 0;
    const prev = _remoteCpuCache.get(sessionId);
    if (prev && total > prev.total) {
      cpu = Math.max(0, Math.min(100, (1 - (idle - prev.idle) / (total - prev.total)) * 100));
    }
    _remoteCpuCache.set(sessionId, { total, idle });
    // 内存(KB)
    const [memTotal, memAvail] = data.MEM.split(/\s+/).map(Number);
    const memUsed = memTotal - memAvail;
    res.json({
      connected: true,
      hostname: data.HOST,
      platform: data.SYS,
      cpuCount: Number(data.CORES) || 0,
      uptime: Number(data.UP) || 0,
      loadavg: (data.LOAD || '').split(/\s+/).slice(0, 3).map(Number),
      cpu: Math.round(cpu),
      mem: {
        total: (memTotal || 0) * 1024,
        used: (memUsed > 0 ? memUsed : 0) * 1024,
        percent: memTotal ? Math.round((memUsed / memTotal) * 100) : 0
      }
    });
  } catch (e) {
    res.json({ connected: true, error: '采集失败: ' + e.message });
  }
});

// ---------- 设置 ----------
app.get('/api/settings', (req, res) => res.json(store.loadSettings()));
app.post('/api/settings', (req, res) => {
  const merged = Object.assign({}, store.loadSettings(), req.body);
  store.saveSettings(merged);
  res.json(merged);
});

// ---------- 密钥 ----------
app.get('/api/keys', (req, res) => res.json(store.listKeys()));
app.post('/api/keys', (req, res) => {
  const { name, content } = req.body || {};
  if (!name || !content) return res.status(400).json({ error: 'name/content required' });
  res.json(store.saveKey(name, content));
});
app.delete('/api/keys/:name', (req, res) => {
  store.deleteKey(req.params.name);
  res.json({ ok: true });
});

// ---------- 日志 ----------
app.get('/api/logs', (req, res) => {
  const fs = require('fs');
  const files = fs.existsSync(store.LOGS_DIR) ? fs.readdirSync(store.LOGS_DIR) : [];
  res.json(files.map(f => ({
    name: f,
    size: fs.statSync(path.join(store.LOGS_DIR, f)).size,
    mtime: fs.statSync(path.join(store.LOGS_DIR, f)).mtime
  })).sort((a, b) => b.mtime - a.mtime));
});
app.get('/api/logs/:name', (req, res) => {
  const p = path.join(store.LOGS_DIR, req.params.name.replace(/[\\/]/g, '_'));
  if (!require('fs').existsSync(p)) return res.status(404).json({ error: 'not found' });
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.sendFile(p);
});
app.delete('/api/logs/:name', (req, res) => {
  const p = path.join(store.LOGS_DIR, req.params.name.replace(/[\\/]/g, '_'));
  require('fs').existsSync(p) && require('fs').unlinkSync(p);
  res.json({ ok: true });
});

// ---------- 解析会话配置 ----------
function resolveConfig(msg) {
  // 已保存会话:从存储加载并解密
  if (msg.sessionId) {
    const full = store.loadSessions().find(x => x.id === msg.sessionId);
    if (!full) throw new Error('会话不存在: ' + msg.sessionId);
    const cfg = Object.assign({}, full);
    cfg.password = store.decrypt(cfg.password);
    cfg.passphrase = store.decrypt(cfg.passphrase);
    if (msg.override) Object.assign(cfg, msg.override);
    return cfg;
  }
  // 临时连接
  if (msg.session) {
    const proto = (msg.session.protocol || 'ssh').toLowerCase();
    if (!msg.session.host) throw new Error('缺少主机');
    if (proto === 'ssh' && !msg.session.username) throw new Error('缺少用户名');
    msg.session.protocol = proto;
    if (!msg.session.port) {
      msg.session.port = proto === 'telnet' ? 23 : proto === 'rlogin' ? 513 : 22;
    }
    return msg.session;
  }
  throw new Error('无效连接请求');
}

// ---------- 终端 WebSocket ----------
const wssTerminal = new WebSocketServer({ noServer: true });
const wssSftp = new WebSocketServer({ noServer: true });

wssTerminal.on('connection', (ws) => {
  let connId = null;
  let conn = null;

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch (e) { return; }

    if (msg.type === 'connect') {
      try {
        const cfg = resolveConfig(msg);
        // 用前端当前终端尺寸打开 PTY(否则默认 80x24,vi/vim 等全屏程序显示不全)
        if (msg.cols) cfg.cols = msg.cols;
        if (msg.rows) cfg.rows = msg.rows;
        // 每个连接使用独立随机 key:同一会话可同时开多个连接(多标签),
        // 互不覆盖;前端监控按各标签自己的 connId 查找,删除其中一个不影响另一个
        connId = uid();
        conn = manager.create(connId, cfg);
        conn.onData = (d) => ws.send(JSON.stringify({ type: 'data', data: d.toString('utf8') }));
        conn.onClose = (reason) => ws.send(JSON.stringify({ type: 'close', reason }));
        conn.onError = (m) => ws.send(JSON.stringify({ type: 'error', message: m }));
        await conn.connect();
        ws.send(JSON.stringify({ type: 'ready', connId }));
      } catch (e) {
        ws.send(JSON.stringify({ type: 'error', message: e.message || String(e) }));
        ws.send(JSON.stringify({ type: 'close', reason: 'connect-failed' }));
      }
    } else if (msg.type === 'input' && conn) {
      conn.write(msg.data);
    } else if (msg.type === 'resize' && conn) {
      conn.resize(msg.cols, msg.rows);
    } else if (msg.type === 'disconnect') {
      if (conn) conn.close();
    }
  });

  ws.on('close', () => {
    if (conn) conn.close();
  });
  ws.on('error', () => {});
});

// ---------- SFTP WebSocket ----------
wssSftp.on('connection', (ws) => {
  let conn = null;
  let sftp = null;
  let cwd = '/';
  const uploads = new Map(); // uploadId -> { name, total, parts[] } 分块上传累积缓冲

  const fail = (m) => ws.send(JSON.stringify({ type: 'error', message: m }));

  const openSftp = async () => {
    if (sftp) return sftp;
    sftp = await conn.sftp();
    return sftp;
  };

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch (e) { return; }

    try {
      if (msg.type === 'sftp_connect') {
        const cfg = resolveConfig(msg);
        conn = manager.create('sftp-' + uid(), cfg);
        conn.onError = fail;
        await conn.connect();
        sftp = await openSftp();
        cwd = msg.path || '.';
        const real = await realpath(cwd);
        cwd = real;
        ws.send(JSON.stringify({ type: 'sftp_ready', cwd }));
        await sendList(real);
      } else if (msg.type === 'sftp_list') {
        const real = await realpath(msg.path);
        cwd = real;
        await sendList(real);
      } else if (msg.type === 'sftp_download') {
        const data = await readFile(msg.path);
        ws.send(JSON.stringify({ type: 'sftp_file', path: msg.path, name: base(msg.path), data: data.toString('base64') }));
      } else if (msg.type === 'sftp_upload_start') {
        uploads.set(msg.uploadId, { name: String(msg.name || '').replace(/[\\/]/g, '_'), total: msg.total, parts: [] });
      } else if (msg.type === 'sftp_upload_chunk') {
        const u = uploads.get(msg.uploadId);
        if (u) u.parts[msg.index] = Buffer.from(msg.data, 'base64');
      } else if (msg.type === 'sftp_upload_end') {
        const u = uploads.get(msg.uploadId);
        if (!u) return;
        uploads.delete(msg.uploadId);
        // 校验分块完整性,缺块直接报错
        for (let i = 0; i < u.total; i++) {
          if (!u.parts[i]) return fail('上传不完整,缺少分块 ' + i);
        }
        const buf = Buffer.concat(u.parts);
        const target = path.posix.join(cwd, u.name);
        sftp.writeFile(target, buf, (err) => {
          if (err) return fail('上传失败: ' + err.message);
          ws.send(JSON.stringify({ type: 'sftp_uploaded', uploadId: msg.uploadId, path: target, name: u.name }));
          sendList(cwd);
        });
      } else if (msg.type === 'sftp_mkdir') {
        sftp.mkdir(path.posix.join(cwd, msg.name), (err) => err ? fail(err.message) : sendList(cwd));
      } else if (msg.type === 'sftp_rm') {
        sftp.unlink(msg.path, (err) => err ? fail(err.message) : sendList(cwd));
      } else if (msg.type === 'sftp_rmdir') {
        sftp.rmdir(msg.path, (err) => err ? fail(err.message) : sendList(cwd));
      } else if (msg.type === 'sftp_rename') {
        sftp.rename(msg.path, msg.newPath, (err) => err ? fail(err.message) : sendList(cwd));
      }
    } catch (e) {
      fail(e.message || String(e));
    }
  });

  async function realpath(p) {
    return new Promise((resolve, reject) => {
      sftp.realpath(p, (err, r) => err ? reject(err) : resolve(r));
    });
  }

  async function sendList(dir) {
    const entries = await new Promise((resolve, reject) => {
      sftp.readdir(dir, (err, list) => err ? reject(err) : resolve(list));
    });
    ws.send(JSON.stringify({
      type: 'sftp_list',
      path: dir,
      entries: entries.map(e => ({
        name: e.filename,
        longname: e.longname,
        isDir: e.attrs && e.attrs.isDirectory(),
        size: e.attrs ? e.attrs.size : 0,
        mode: e.attrs ? e.attrs.mode : 0,
        mtime: e.attrs ? e.attrs.mtime * 1000 : 0
      }))
    }));
  }

  async function readFile(p) {
    return new Promise((resolve, reject) => {
      sftp.stat(p, (err, stat) => {
        if (err) return reject(err);
        if (stat.isDirectory()) return reject(new Error('是目录,无法下载'));
        if (stat.size > 25 * 1024 * 1024) return reject(new Error('文件超过 25MB 限制'));
        sftp.readFile(p, (e2, buf) => e2 ? reject(e2) : resolve(buf));
      });
    });
  }

  function base(p) { return p.split('/').filter(Boolean).pop() || p; }

  ws.on('close', () => { if (conn) conn.close(); });
  ws.on('error', () => {});
});

// ---------- 隧道 REST ----------
const tunnels = new Map(); // id -> Tunnel
app.post('/api/tunnels', async (req, res) => {
  try {
    const { sessionId, mode, listenHost, listenPort, targetHost, targetPort, override } = req.body;
    const cfg = resolveConfig({ sessionId, override });
    const conn = manager.create('tunnel-' + uid(), cfg);
    conn.onError = () => {};
    await conn.connect();
    const id = uid();
    const t = new Tunnel(id, { mode, listenHost, listenPort, targetHost, targetPort });
    await t.start(conn);
    tunnels.set(id, { tunnel: t, conn });
    res.json({ ok: true, id });
  } catch (e) {
    res.status(500).json({ error: e.message || String(e) });
  }
});
app.get('/api/tunnels', (req, res) => {
  res.json([...tunnels.entries()].map(([id, x]) => ({ id, cfg: x.tunnel.cfg })));
});
app.delete('/api/tunnels/:id', (req, res) => {
  const x = tunnels.get(req.params.id);
  if (x) { x.tunnel.close(); x.conn.close(); tunnels.delete(req.params.id); }
  res.json({ ok: true });
});

// ---------- WebSocket 升级路由 ----------
server.on('upgrade', (req, socket, head) => {
  const u = new URL(req.url, 'http://localhost');
  if (u.pathname === '/ws/terminal') {
    wssTerminal.handleUpgrade(req, socket, head, (ws) => wssTerminal.emit('connection', ws, req));
  } else if (u.pathname === '/ws/sftp') {
    wssSftp.handleUpgrade(req, socket, head, (ws) => wssSftp.emit('connection', ws, req));
  } else {
    socket.destroy();
  }
});

function banner(port) {
  return [
    '',
    '  ╔══════════════════════════════════════════════════╗',
    '  ║   XBTerminal 远程终端已启动                       ║',
    '  ║   本机访问:  http://127.0.0.1:' + port + '                ║',
    '  ╚══════════════════════════════════════════════════╝',
    ''
  ].join('\n');
}

// 启动服务,返回 Promise<{ server, port }>。port 传 0 表示随机端口(供 Electron 内嵌使用)。
function startServer(port = PORT) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      resolve({ server, port: server.address().port });
    });
  });
}

// 独立运行时(命令行)才自动启动
if (require.main === module) {
  startServer().then(({ port }) => console.log(banner(port)))
    .catch((e) => { console.error('启动失败:', e.message); process.exit(1); });
  process.on('SIGINT', () => { manager.closeAll(); process.exit(0); });
}

module.exports = { startServer, manager };
