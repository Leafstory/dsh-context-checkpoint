#!/usr/bin/env node
/**
 * 用正确的压缩事件名取证（只读）。
 * 真实事件名来自 dsh-compaction-basic/lib/index.js：
 *   452  session.append('compaction/start', ...)
 *   467  session.append('compaction/end', ...)
 *   605  session.append('compaction/summary', ...)   ← 仅特定分支
 *   621  session.append('user/message', checkpointMessage, ...)  ← 压缩后注入的 checkpoint
 * 用法: node scripts/list-compaction-events.mjs <session.v3.jsonl.zstd>
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
const compact = [];
let hooks = 0;
for (const [idx, line] of lines.entries()) {
  let ev;
  try { ev = JSON.parse(line); } catch { continue; }
  const t = ev.type ?? '?';
  census.set(t, (census.get(t) ?? 0) + 1);
  if (/^compaction\//.test(t) || t === 'hook/invoked' || t === 'hook/result') {
    if (/^compaction\//.test(t)) compact.push({ idx, seq: ev.seq, type: t, data: ev.data });
    else hooks += 1;
  }
}

console.log(`文件: ${file}`);
console.log(`事件行: ${lines.length}\n`);

console.log('── 压缩相关事件 ──');
if (compact.length === 0) console.log('  （无）');
for (const e of compact.slice(0, 12)) {
  const d = e.data ?? {};
  console.log(`  #${e.idx} seq=${e.seq} ${e.type}`);
  console.log(`      ${JSON.stringify(d).slice(0, 220)}`);
}
console.log(`\n  hook/invoked|result 事件: ${hooks}`);
console.log(`  压缩后注入的 checkpoint user/message: ${
  lines.filter((l) => l.includes('compacted-summary')).length
} 处提及`);

console.log('\n── 出现过的所有事件类型（前 25）──');
for (const [t, n] of [...census.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25)) {
  console.log(`  ${String(n).padStart(5)}  ${t}`);
}

console.log(compact.length > 0
  ? `\n→ 结论：发生过 ${compact.filter((e) => e.type === 'compaction/start').length} 次真实压缩。`
  : '\n→ 结论：本会话没有发生过真实压缩。');
