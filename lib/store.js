/**
 * store.js — 会话持久化 + 密码加密 + 密钥/日志文件管理
 *
 * 会话保存在 config/sessions.json
 * SSH 私钥保存在 config/keys/
 * 会话日志保存在 config/logs/
 * 密码使用 AES-256-CBC 加密,密钥保存在本机 config/.secret(首次运行自动生成)
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// 数据目录可配置:默认在项目 config/;桌面端(Electron)运行时指向用户数据目录,
// 因为打包后的 asar 归档只读,不能往里写文件。
let CONFIG_DIR = process.env.XTERMINAL_CONFIG_DIR || path.join(__dirname, '..', 'config');
let SESSIONS_FILE = path.join(CONFIG_DIR, 'sessions.json');
let SETTINGS_FILE = path.join(CONFIG_DIR, 'settings.json');
let KEYS_DIR = path.join(CONFIG_DIR, 'keys');
let LOGS_DIR = path.join(CONFIG_DIR, 'logs');
let SECRET_FILE = path.join(CONFIG_DIR, '.secret');

function setConfigDir(dir) {
  if (!dir) return;
  CONFIG_DIR = dir;
  SESSIONS_FILE = path.join(CONFIG_DIR, 'sessions.json');
  SETTINGS_FILE = path.join(CONFIG_DIR, 'settings.json');
  KEYS_DIR = path.join(CONFIG_DIR, 'keys');
  LOGS_DIR = path.join(CONFIG_DIR, 'logs');
  SECRET_FILE = path.join(CONFIG_DIR, '.secret');
  ensureDirs();
}

const AES_ALGO = 'aes-256-cbc';

function ensureDirs() {
  for (const d of [CONFIG_DIR, KEYS_DIR, LOGS_DIR]) {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  }
}

function getSecret() {
  ensureDirs();
  if (fs.existsSync(SECRET_FILE)) {
    return fs.readFileSync(SECRET_FILE, 'utf8').trim();
  }
  // 首次运行生成随机密钥(仅本机可解)
  const secret = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(SECRET_FILE, secret, { mode: 0o600 });
  return secret;
}

function encrypt(text) {
  if (!text) return '';
  const key = crypto.createHash('sha256').update(getSecret()).digest();
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(AES_ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(String(text), 'utf8'), cipher.final()]);
  return iv.toString('hex') + ':' + enc.toString('hex');
}

function decrypt(payload) {
  if (!payload) return '';
  try {
    const [ivHex, dataHex] = String(payload).split(':');
    if (!dataHex) return payload; // 明文兼容
    const key = crypto.createHash('sha256').update(getSecret()).digest();
    const decipher = crypto.createDecipheriv(AES_ALGO, key, Buffer.from(ivHex, 'hex'));
    const dec = Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]);
    return dec.toString('utf8');
  } catch (e) {
    return '';
  }
}

// ---------- 会话 ----------
function loadSessions() {
  ensureDirs();
  if (!fs.existsSync(SESSIONS_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
  } catch (e) {
    return [];
  }
}

function saveSessions(sessions) {
  ensureDirs();
  fs.writeFileSync(SESSIONS_FILE, JSON.stringify(sessions, null, 2), 'utf8');
}

// 对外返回时把密码解密,便于前端回显编辑(可选);默认返回 true 表示"已保存密码"
function sanitizeSession(s, { includeSecret = false } = {}) {
  const out = Object.assign({}, s);
  if (out.password) {
    out.hasPassword = true;
    if (includeSecret) out.password = decrypt(out.password);
    delete out.password;
  }
  return out;
}

// ---------- 设置 ----------
function loadSettings() {
  ensureDirs();
  if (!fs.existsSync(SETTINGS_FILE)) {
    return { theme: 'dark', fontSize: 14, fontFamily: 'monospace', defaultDirectory: '~' };
  }
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
  } catch (e) {
    return { theme: 'dark', fontSize: 14, fontFamily: 'monospace' };
  }
}

function saveSettings(settings) {
  ensureDirs();
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2), 'utf8');
}

// ---------- 密钥 ----------
function listKeys() {
  ensureDirs();
  if (!fs.existsSync(KEYS_DIR)) return [];
  return fs.readdirSync(KEYS_DIR)
    .filter(f => !f.startsWith('.'))
    .map(f => ({ name: f, path: path.join(KEYS_DIR, f) }));
}

function saveKey(name, content) {
  ensureDirs();
  const safe = name.replace(/[\\/:*?"<>|]/g, '_');
  const p = path.join(KEYS_DIR, safe);
  fs.writeFileSync(p, content, { mode: 0o600 });
  return { name: safe, path: p };
}

function deleteKey(name) {
  const safe = name.replace(/[\\/:*?"<>|]/g, '_');
  const p = path.join(KEYS_DIR, safe);
  if (fs.existsSync(p)) fs.unlinkSync(p);
}

// ---------- 日志 ----------
function logPath(sessionId) {
  ensureDirs();
  const safe = String(sessionId).replace(/[\\/:*?"<>|]/g, '_');
  return path.join(LOGS_DIR, safe + '.log');
}

function appendLog(sessionId, chunk) {
  try {
    fs.appendFileSync(logPath(sessionId), chunk);
  } catch (e) { /* 忽略日志写入失败 */ }
}

module.exports = {
  get CONFIG_DIR() { return CONFIG_DIR; },
  get KEYS_DIR() { return KEYS_DIR; },
  get LOGS_DIR() { return LOGS_DIR; },
  setConfigDir,
  encrypt, decrypt,
  loadSessions, saveSessions, sanitizeSession,
  loadSettings, saveSettings,
  listKeys, saveKey, deleteKey,
  logPath, appendLog
};
