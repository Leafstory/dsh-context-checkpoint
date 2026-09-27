#!/usr/bin/env node
/**
 * 读一个会话的前几条事件，确认它的起点（只读）。
 * 用法: node scripts/peek-session-head.mjs <session.v3.jsonl.zstd> [headLines]
 */
import { readFileSync } from 'node:fs';
import { zstdDecompressSync } from 'node:zlib';

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const file = process.argv[2];
const headLines = Number(process.argv[3] ?? 6);

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
const text = Buffer.concat(parts).toString('utf8');
const lines = text.split('\n').filter((l) => l.trim().length > 0);

console.log(`文件: ${file}`);
console.log(`事件行数: ${lines.length}\n`);

/** 打印一条事件的摘要，避免刷屏。 */
function summarize(line, index) {
  try {
    const ev = JSON.parse(line);
    const t = ev.type ?? ev.event ?? '?';
    const seq = ev.seq ?? ev.seqNo ?? '';
    let extra = '';
    if (t === 'session/start' || t === 'session/header') extra = JSON.stringify(ev.data ?? ev).slice(0, 260);
    else if (t === 'turn/start') extra = `turn=${ev.data?.turn ?? ''}`;
    else if (t === 'step/start') extra = `step=${ev.data?.step ?? ''}`;
    else if (t === 'user/message') extra = JSON.stringify(ev.data?.content ?? '').slice(0, 160);
    return `#${index} seq=${seq} ${t}  ${extra}`;
  } catch {
    return `#${index} (非 JSON) ${line.slice(0, 120)}`;
  }
}

console.log('── 头部事件 ──');
lines.slice(0, headLines).forEach((l, idx) => console.log('  ' + summarize(l, idx)));

console.log('\n── 尾部事件 ──');
const tail = lines.slice(-Math.min(4, lines.length));
tail.forEach((l, idx) => console.log('  ' + summarize(l, lines.length - tail.length + idx)));

// 插件痕迹的时间分布
const strikes = [];
for (const needle of ['上下文占用（由 context-checkpoint', 'context-checkpoint ready', 'context_compact']) {
  const first = text.indexOf(needle);
  const count = text.split(needle).length - 1;
  strikes.push(`  ${needle}: 首次偏移=${first === -1 ? '未出现' : first}  出现 ${count} 次`);
}
console.log('\n── 插件痕迹 ──');
console.log(strikes.join('\n'));

// 压缩事件
const compactHits = text.split('compaction/summary').length - 1;
console.log(`\n  compaction/summary 事件: ${compactHits} 次`);
