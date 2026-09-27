#!/usr/bin/env node
/**
 * 定位压缩失败在会话中的位置，判定责任方（只读）。
 * 用法: node scripts/locate-compaction-failure.mjs <session.v3.jsonl.zstd>
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

const events = [];
for (const line of lines) {
  try { events.push(JSON.parse(line)); } catch { events.push(null); }
}

// 找到插件首次进入协议的序号（request/header 里含 context_status）
const toolMarker = JSON.stringify('context_status');
let pluginFirst = -1;
for (const [idx, ev] of events.entries()) {
  if (ev?.type === 'request/header' && JSON.stringify(ev).includes(toolMarker)) { pluginFirst = idx; break; }
}

// 列出所有压缩事件及其序号
const compactions = [];
for (const [idx, ev] of events.entries()) {
  if (ev?.type?.startsWith('compaction/')) compactions.push({ idx, type: ev.type, data: ev.data });
}

console.log(`文件: ${file}`);
console.log(`事件行: ${lines.length}`);
console.log(`插件首次进入协议的事件序号: ${pluginFirst === -1 ? '未出现' : pluginFirst}`);
console.log('');

const starts = compactions.filter((c) => c.type === 'compaction/start');
const ends = compactions.filter((c) => c.type === 'compaction/end');
console.log(`compaction/start: ${starts.length}   compaction/end: ${ends.length}   compaction/prune: ${compactions.filter((c) => c.type === 'compaction/prune').length}`);
console.log('');

for (const s of starts) {
  const end = ends.find((e) => e.data?.compactionId === s.data?.compactionId);
  const before = pluginFirst !== -1 && s.idx < pluginFirst;
  console.log(`  压缩 #${s.idx}  id=${String(s.data?.compactionId).slice(0, 8)}  turn=${s.data?.turn}`);
  console.log(`      结束事件: ${end ? `#${end.idx}` : '无'}`);
  console.log(`      error: ${end?.data?.error ?? '(无)'}`);
  console.log(`      位置: ${before ? '插件进入协议**之前**' : '插件进入协议**之后**'}`);
  console.log(`      → 责任方: ${before ? 'DSH 自身（与插件无关）' : '需进一步检查（可能是本插件的 context_compact）'}`);
}

// turn:7 附近有没有本插件的工具调用
console.log('\n── 该次压缩所在 turn 的工具调用（找 context_compact）──');
const target = starts[0];
if (target) {
  const turn = target.data?.turn;
  for (const [idx, ev] of events.entries()) {
    if (ev?.type === 'turn/start' && ev.data?.turn === turn) console.log(`  turn ${turn} 开始于事件 #${idx}`);
  }
  const calls = [];
  for (const [idx, ev] of events.entries()) {
    if (ev?.type !== 'tool/call') continue;
    const name = ev.data?.name ?? ev.data?.tool ?? '';
    if (String(name).includes('context_')) calls.push({ idx, name });
  }
  console.log(`  会话里 context_* 工具调用: ${calls.length} 次`);
  for (const c of calls.slice(0, 5)) console.log(`      #${c.idx} ${c.name}`);
}
