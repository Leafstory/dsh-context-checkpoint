#!/usr/bin/env node
/**
 * 统计一个会话里的事件类型，并列出压缩相关事件（只读）。
 * 用法: node scripts/session-event-census.mjs <session.v3.jsonl.zstd>
 */
import { readFileSync } from 'node:fs';
import { zstdDecompressSync } from 'node:zlib';

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const file = process.argv[2];

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
const lines = Buffer.concat(parts).toString('utf8').split('\n').filter((l) => l.trim());

const census = new Map();
const compactish = [];
for (const [idx, line] of lines.entries()) {
  let ev;
  try { ev = JSON.parse(line); } catch { continue; }
  const t = ev.type ?? '?';
  census.set(t, (census.get(t) ?? 0) + 1);
  if (/compact|summary|surface|replace/i.test(t)) {
    compactish.push({ idx, seq: ev.seq, type: t, data: JSON.stringify(ev.data ?? {}).slice(0, 200) });
  }
}

console.log(`文件: ${file}`);
console.log(`事件总数: ${lines.length}\n`);
console.log('── 事件类型分布 ──');
for (const [t, n] of [...census.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(n).padStart(5)}  ${t}`);
}

console.log(`\n── 压缩/表层相关事件（${compactish.length} 条）──`);
for (const e of compactish.slice(0, 20)) {
  console.log(`  #${e.idx} seq=${e.seq} ${e.type}`);
  console.log(`      ${e.data}`);
}
if (compactish.length === 0) console.log('  （无）');

// 找 request/header 里记录的表层代际信息
console.log('\n── request/header 样本（看是否记录了表层替换代际）──');
let shown = 0;
for (const [idx, line] of lines.entries()) {
  if (shown >= 2) break;
  let ev;
  try { ev = JSON.parse(line); } catch { continue; }
  if (ev.type === 'request/header') {
    console.log(`  #${idx} ${JSON.stringify(ev.data ?? {}).slice(0, 400)}`);
    shown += 1;
  }
}
