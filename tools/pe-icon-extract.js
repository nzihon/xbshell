// tools/pe-icon-extract.js — 从 PE(exe) 中提取 RT_ICON 资源,用于核对打包图标是否为新 logo
'use strict';
const fs = require('fs');
const path = require('path');

const exe = process.argv[2];
if (!exe) { console.error('用法: node pe-icon-extract.js <exe>'); process.exit(1); }
const buf = fs.readFileSync(exe);
if (buf.toString('ascii', 0, 2) !== 'MZ') { console.error('非 PE 文件'); process.exit(1); }

const e_lfanew = buf.readUInt32LE(0x3C);
const peOff = e_lfanew;
if (buf.toString('ascii', peOff, peOff + 4) !== 'PE\0\0') { console.error('无 PE 签名'); process.exit(1); }
const coff = peOff + 4;
const numSections = buf.readUInt16LE(coff + 2);
const sizeOfOptionalHeader = buf.readUInt16LE(coff + 16);
const optOff = coff + 20;
const magic = buf.readUInt16LE(optOff);
const dirOff = magic === 0x20b ? optOff + 112 : optOff + 96;
const resRva = buf.readUInt32LE(dirOff + 2 * 8);
const resSize = buf.readUInt32LE(dirOff + 2 * 8 + 4);
if (!resRva) { console.error('无资源表'); process.exit(1); }

const sectOff = optOff + sizeOfOptionalHeader;
const sections = [];
for (let i = 0; i < numSections; i++) {
  const s = sectOff + i * 40;
  sections.push({
    name: buf.toString('ascii', s, s + 8).replace(/\0/g, ''),
    vsize: buf.readUInt32LE(s + 8),
    vaddr: buf.readUInt32LE(s + 12),
    rawsize: buf.readUInt32LE(s + 16),
    rawptr: buf.readUInt32LE(s + 20)
  });
}
function rvaToOffset(rva) {
  for (const s of sections) {
    const end = s.vaddr + Math.max(s.vsize, s.rawsize);
    if (rva >= s.vaddr && rva < end) return rva - s.vaddr + s.rawptr;
  }
  return -1;
}

const resBase = rvaToOffset(resRva);
if (resBase < 0) { console.error('无法定位资源区段'); process.exit(1); }

// 收集所有 RT_ICON (type 3) 的资源数据
const icons = [];
function parseDir(off, level) {
  const numNamed = buf.readUInt16LE(off + 12);
  const numId = buf.readUInt16LE(off + 14);
  const total = numNamed + numId;
  for (let i = 0; i < total; i++) {
    const e = off + 16 + i * 8;
    const nameOrId = buf.readUInt32LE(e);
    const offset = buf.readUInt32LE(e + 4);
    const isDir = (offset & 0x80000000) !== 0;
    const target = resBase + (offset & 0x7FFFFFFF);
    if (level === 0) {
      const typeId = nameOrId & 0xFFFF;
      if (isDir && typeId === 3) parseDir(target, 1); // RT_ICON 子树
    } else if (level === 1) {
      if (isDir) parseDir(target, 2);
    } else if (level === 2) {
      if (!isDir) {
        // 数据入口
        const dataRva = buf.readUInt32LE(target);
        const dataSize = buf.readUInt32LE(target + 4);
        const dataOff = rvaToOffset(dataRva);
        if (dataOff >= 0) icons.push(buf.slice(dataOff, dataOff + dataSize));
      }
    }
  }
}
parseDir(resBase, 0);
console.log('找到 RT_ICON 资源数量:', icons.length);

// 按大小排序,取最大
icons.sort((a, b) => b.length - a.length);
const outDir = path.dirname(exe);
icons.forEach((ic, i) => {
  const isPng = ic.length > 8 && ic[0] === 0x89 && ic[1] === 0x50;
  const isBmp = ic.length > 2 && ic[0] === 0x42 && ic[1] === 0x4D;
  const ext = isPng ? 'png' : isBmp ? 'bmp' : 'bin';
  const fn = path.join(outDir, `_extract_${i}.${ext}`);
  fs.writeFileSync(fn, ic);
  console.log(`  #${i} ${ic.length} bytes -> ${fn} ${isPng ? '(PNG)' : isBmp ? '(BMP)' : '(未知)'}`);
});
