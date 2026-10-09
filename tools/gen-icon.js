// tools/gen-icon.js — 生成应用图标(512x512)
// 构图:两片青叶托起竖长圆角终端窗口(深蓝),窗口内是黄绿色玉米粒样式代码行 + ">_" 提示符
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZE = 512;

function hex(c) { return [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)]; }
const C = {
  window: hex('#16283A'),
  cyan: hex('#4DD8E2'),
  lime: hex('#C8E63C'),
  black: hex('#1A1A1A')
};

// 终端窗口(玉米棒)
const WIN = { x0: 186, y0: 90, x1: 326, y1: 420, r: 24 };
const TITLE_H = 42;
const WIN_STROKE = 8;

// 两片叶子(旋转椭圆)
const LEAFS = [
  { cx: 190, cy: 297, a: 124, b: 40, t: 251 * Math.PI / 180 },
  { cx: 322, cy: 297, a: 124, b: 40, t: -71 * Math.PI / 180 }
];
const LEAF_STROKE = 9;

// 玉米粒代码行(胶囊)
const CAPS = [
  [206, 156, 95], [206, 180, 65], [206, 204, 102], [206, 228, 78],
  [206, 252, 98], [206, 276, 58], [206, 300, 90], [206, 324, 72]
];
const CAP_H = 14, CAP_R = 7, CAP_STROKE = 3;

// ">_" 提示符(折线 + 下划线)
const PROMPT_SEGS = [
  [206, 356, 228, 372], [228, 372, 206, 388], [238, 388, 276, 388]
];
const PROMPT_W = 12;

// 标题栏三个圆点
const DOTS = [206, 228, 250];
const DOT_Y = 111, DOT_R = 6;

function inRoundedRect(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  const dx = x - cx, dy = y - cy;
  return dx * dx + dy * dy <= r * r || (x >= x0 + r && x <= x1 - r) || (y >= y0 + r && y <= y1 - r);
}

function inTopRect(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  if (y >= y0 + r) return true;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const dx = x - cx, dy = y - (y0 + r);
  return dx * dx + dy * dy <= r * r || (x >= x0 + r && x <= x1 - r);
}

function inEllipse(x, y, cx, cy, a, b, t) {
  const cos = Math.cos(t), sin = Math.sin(t);
  const dx = x - cx, dy = y - cy;
  const u = dx * cos + dy * sin, v = -dx * sin + dy * cos;
  return (u * u) / (a * a) + (v * v) / (b * b) <= 1;
}

function segDist(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1, len2 = dx * dx + dy * dy;
  let t = len2 ? ((px - x1) * dx + (py - y1) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

function colorAt(x, y) {
  for (const s of PROMPT_SEGS) {
    if (segDist(x, y, s[0], s[1], s[2], s[3]) <= PROMPT_W / 2) return C.lime;
  }
  for (const cx of DOTS) {
    if (Math.hypot(x - cx, y - DOT_Y) <= DOT_R) return C.window;
  }
  for (const [cx, cy, w] of CAPS) {
    if (inRoundedRect(x, y, cx, cy, cx + w, cy + CAP_H, CAP_R)) {
      return inRoundedRect(x, y, cx + CAP_STROKE, cy + CAP_STROKE, cx + w - CAP_STROKE, cy + CAP_H - CAP_STROKE, CAP_R) ? C.lime : C.black;
    }
  }
  if (inTopRect(x, y, WIN.x0, WIN.y0, WIN.x1, WIN.y0 + TITLE_H, WIN.r)) return C.cyan;
  const s = WIN_STROKE;
  if (inRoundedRect(x, y, WIN.x0 - s, WIN.y0 - s, WIN.x1 + s, WIN.y1 + s, WIN.r + s)) {
    return inRoundedRect(x, y, WIN.x0, WIN.y0, WIN.x1, WIN.y1, WIN.r) ? C.window : C.black;
  }
  for (const L of LEAFS) {
    if (inEllipse(x, y, L.cx, L.cy, L.a + LEAF_STROKE, L.b + LEAF_STROKE, L.t)) {
      return inEllipse(x, y, L.cx, L.cy, L.a, L.b, L.t) ? C.cyan : C.black;
    }
  }
  return null;
}

const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
for (let y = 0; y < SIZE; y++) {
  const rowStart = y * (SIZE * 4 + 1);
  raw[rowStart] = 0;
  for (let x = 0; x < SIZE; x++) {
    const c = colorAt(x, y);
    const off = rowStart + 1 + x * 4;
    if (c) { raw[off] = c[0]; raw[off + 1] = c[1]; raw[off + 2] = c[2]; raw[off + 3] = 255; }
    else { raw[off] = 0; raw[off + 1] = 0; raw[off + 2] = 0; raw[off + 3] = 0; }
  }
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4); crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8;
ihdr[9] = 6;

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0))
]);

const targets = [
  path.join(__dirname, '..', 'build', 'icon.png'),
  path.join(__dirname, '..', 'public', 'icon.png')
];
for (const out of targets) {
  fs.writeFileSync(out, png);
  console.log('图标已生成:', out, png.length, 'bytes');
}
