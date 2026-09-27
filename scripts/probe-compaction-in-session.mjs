#!/usr/bin/env node
/**
 * 在会话里找 context_compact 的实际返回，判别压缩服务是否可用（只读）。
 *
 * 判别依据（插件自身的两段文案）：
 *   - 可用：'Compaction scheduled (it runs after this turn ends'  → compaction 服务在
 *   - 降级：'this plane has NO compaction service'                → compaction 服务不在
 *
 * 用法: node scripts/probe-compaction-in-session.mjs <session.v3.jsonl.zstd>
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
const text = Buffer.concat(parts).toString('utf8');

const markers = {
  '可用（已预约）': 'Compaction scheduled (it runs after this turn ends',
  '降级（无压缩服务）': 'this plane has NO compaction service',
  '降级文案2': 'but this plane has NO compaction service',
  '状态工具已调用': '"capabilityProbe"',
  '续读消息（插件注入）': '【context-checkpoint】上下文压缩已完成',
  '压缩失败续读': '【context-checkpoint】压缩失败',
  '压缩观察日志': 'compaction observed on session',
  '预约日志': 'compact scheduled:'
};

console.log(`文件: ${file}`);
console.log(`解压后 ${text.length} 字符\n`);
for (const [label, needle] of Object.entries(markers)) {
  const n = text.split(needle).length - 1;
  console.log(`  ${n > 0 ? '✓' : '✗'} ${label}: ${n} 次`);
  if (n > 0) {
    const at = text.indexOf(needle);
    console.log(`      → ${text.slice(at, at + 200).replace(/\\n/g, ' ').replace(/\s+/g, ' ')}`);
  }
}
