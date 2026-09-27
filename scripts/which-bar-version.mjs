#!/usr/bin/env node
/**
 * 判断最近会话里渲染出的是哪一版占用条（只读）。
 * 用途：确认"运行中的 lib"是新版还是旧版 —— 源码模板命中不算，必须看**渲染后带数字的文本**。
 * 用法: node scripts/which-bar-version.mjs [sessionsDir]
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { zstdDecompressSync } from 'node:zlib';
import { join } from 'node:path';
import { resolveProjectSessions } from './paths.mjs';

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const dir = process.argv[2] ?? resolveProjectSessions();

function decompress(file) {
  const buf = readFileSync(file);
  const offsets = [];
  let i = buf.indexOf(MAGIC, 0);
  while (i !== -1) { offsets.push(i); i = buf.indexOf(MAGIC, i + 4); }
  const parts = [];
  for (let k = 0; k < offsets.length; k += 1) {
    const s = offsets[k];
    const e = k + 1 < offsets.length ? offsets[k + 1] : buf.length;
    try { parts.push(zstdDecompressSync(buf.subarray(s, e))); } catch { /* skip */ }
  }
  return Buffer.concat(parts).toString('utf8');
}

const sessions = [];
const walk = (p) => {
  for (const entry of readdirSync(p, { withFileTypes: true })) {
    const full = join(p, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (/session.*\.jsonl\.zstd$/.test(entry.name)) sessions.push({ file: full, mtime: statSync(full).mtimeMs });
  }
};
walk(dir);
sessions.sort((a, b) => b.mtime - a.mtime);

for (const { file, mtime } of sessions.slice(0, 3)) {
  let text;
  try { text = decompress(file); } catch { continue; }
  // 只认"渲染后"的形态：紧跟具体数字
  const oldRendered = (text.match(/本会话已压缩 \d+ 次/g) ?? []).length;
  const newRendered = (text.match(/表层已被替换（surface replace）\d+ 次/g) ?? []).length;
  const usedRendered = (text.match(/已用：[\d,]+ token/g) ?? []).length;
  console.log(`${new Date(mtime).toLocaleString()}  ${join(file).split(/[\\/]/).slice(-2)[0].slice(0, 30)}`);
  console.log(`    旧版占用条渲染: ${oldRendered} 处    新版占用条渲染: ${newRendered} 处    真实用量行: ${usedRendered} 处`);
  if (oldRendered > 0) {
    const at = text.search(/本会话已压缩 \d+ 次/);
    console.log(`    旧版样例: ${text.slice(at, at + 40)}`);
  }
  if (newRendered > 0) {
    const at = text.search(/表层已被替换（surface replace）\d+ 次/);
    console.log(`    新版样例: ${text.slice(at, at + 60)}`);
  }
}
