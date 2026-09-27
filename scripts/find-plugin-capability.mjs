#!/usr/bin/env node
/**
 * 在会话里查找插件自报的能力行与工具 schema（只读）。
 * 用法: node scripts/find-plugin-capability.mjs <session.v3.jsonl.zstd>
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

// 1) 工具 schema：直接看 request/header 里 tools 数组是否含本插件的工具
const first = lines.find((l) => l.includes('"request/header"')) ?? lines.find((l) => l.includes('tools'));
let toolNames = [];
for (const line of lines) {
  if (!line.includes('context_checkpoint') && !line.includes('context_status')) continue;
  try {
    const ev = JSON.parse(line);
    const tools = ev.data?.header?.tools ?? ev.header?.tools;
    if (Array.isArray(tools)) { toolNames = tools.map((t) => t.name); break; }
  } catch { /* 继续找 */ }
}
if (toolNames.length > 0) {
  console.log(`该会话的 request/header 工具数: ${toolNames.length}`);
  console.log(`本插件工具是否在内: context_status=${toolNames.includes('context_status')}  context_compact=${toolNames.includes('context_compact')}`);
} else {
  console.log('未能从 request/header 提取工具名单');
}

// 2) 占用条：逐条列出，看计量基线与压缩计数
console.log('\n── 占用条出现情况 ──');
const title = '上下文占用（由 context-checkpoint';
let count = 0;
let cursor = 0;
for (;;) {
  const at = file === undefined ? -1 : 0; // 占位，实际用 text
  break;
}
const text = lines.join('\n');
cursor = 0;
for (;;) {
  const at = text.indexOf(title, cursor);
  if (at === -1) break;
  count += 1;
  const block = text.slice(at, at + 260).split('\\n').filter((s) => s.trim());
  console.log(`\n  [第 ${count} 处]`);
  for (const l of block.slice(0, 5)) console.log(`    ${l.replace(/^["'`,\s]+/, '').trim()}`);
  cursor = at + title.length;
}

// 3) 插件日志行（logger 输出可能落在 session 事件里）
console.log('\n── 插件 logger 痕迹 ──');
for (const needle of ['context-checkpoint ready', 'compact scheduled', 'compacted (attempt', 'compaction failed', 'no compactable history']) {
  const n = text.split(needle).length - 1;
  console.log(`  ${needle}: ${n} 次`);
  if (n > 0) {
    const at = text.indexOf(needle);
    console.log(`      → ${text.slice(at, at + 180).replace(/\s+/g, ' ')}`);
  }
}
