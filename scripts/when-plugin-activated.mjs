#!/usr/bin/env node
/**
 * 定位插件在会话中的生效时点（只读）。
 * 用法: node scripts/when-plugin-activated.mjs <session.v3.jsonl.zstd>
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

const BAR = '上下文占用（由 context-checkpoint';
let firstTools = -1;
let barCount = 0;
let firstBar = -1;
let lastBar = -1;
let compactSummaryEvents = 0;
let requestHeaders = 0;

const toolMarker = JSON.stringify('context_status');
for (const [idx, line] of lines.entries()) {
  if (line.includes('"request/header"')) {
    requestHeaders += 1;
    if (firstTools === -1 && line.includes(toolMarker)) firstTools = idx;
  }
  if (line.includes(BAR)) {
    barCount += 1;
    if (firstBar === -1) firstBar = idx;
    lastBar = idx;
  }
  if (line.includes('compaction/summary')) compactSummaryEvents += 1;
}

console.log(`文件: ${file}`);
console.log(`事件总数: ${lines.length}`);
console.log(`request/header 事件: ${requestHeaders}`);
console.log(`首个含本插件工具的 header 事件序号: ${firstTools === -1 ? '未出现' : firstTools}`);
console.log(`占用条出现: ${barCount} 次（首 ${firstBar}，末 ${lastBar}）`);
console.log(`compaction/summary 事件: ${compactSummaryEvents} 次`);
console.log('');
console.log(firstTools === -1
  ? '→ 插件工具**未**出现在协议里'
  : `→ 插件工具从第 ${firstTools} 条事件起进入协议（共 ${requestHeaders} 个 header）`);
console.log(compactSummaryEvents === 0
  ? '→ 本会话**没有**发生过真实压缩（replaceGeneration 的增长不代表压缩）'
  : `→ 本会话发生过 ${compactSummaryEvents} 次真实压缩`);
