/**
 * 从会话日志里读最近几次请求的真实用量，与 800k 阈值对照。
 * 用法: node scripts/usage-vs-threshold.mjs <session.v3.jsonl.zstd>
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

const WINDOW = 1_000_000;
const THRESHOLD = Math.floor(WINDOW * 0.8);

const usages = [];
for (const line of lines) {
  let ev;
  try { ev = JSON.parse(line); } catch { continue; }
  if (ev.type !== 'assistant/message') continue;
  const u = ev.data?.usage ?? ev.data?.message?.usage;
  if (!u) continue;
  usages.push({
    seq: ev.seq,
    input: u.inputTokens ?? u.input_tokens ?? 0,
    cacheRead: u.cacheReadTokens ?? u.cache_read_tokens ?? 0,
    cacheWrite: u.cacheWriteTokens ?? u.cache_write_tokens ?? 0
  });
}

if (usages.length === 0) {
  console.log('未找到带 usage 的 assistant/message');
} else {
  console.log(`样本数: ${usages.length}（最近 6 次）\n`);
  for (const u of usages.slice(-6)) {
    const total = u.input + u.cacheRead + u.cacheWrite;
    const pct = ((total / WINDOW) * 100).toFixed(1);
    const cacheRate = total > 0 ? ((u.cacheRead / total) * 100).toFixed(1) : '0.0';
    console.log(`  seq=${String(u.seq).padStart(5)}  总输入=${total.toLocaleString('en-US').padStart(10)}  (${pct.padStart(5)}% 窗口)  缓存命中=${cacheRate}%`);
  }
  const last = usages[usages.length - 1];
  const total = last.input + last.cacheRead + last.cacheWrite;
  console.log(`\n阈值: ${THRESHOLD.toLocaleString('en-US')} (窗口 80%)`);
  console.log(`最新: ${total.toLocaleString('en-US')}  →  ${total < THRESHOLD ? `未达阈值，还差 ${(THRESHOLD - total).toLocaleString('en-US')} token` : '已达阈值'}`);
  // 缓存命中率趋势（成本健康度）
  const recent = usages.slice(-10);
  const sumCache = recent.reduce((a, u) => a + u.cacheRead, 0);
  const sumAll = recent.reduce((a, u) => a + u.input + u.cacheRead + u.cacheWrite, 0);
  console.log(`\n最近 10 次请求缓存命中率: ${sumAll > 0 ? ((sumCache / sumAll) * 100).toFixed(1) : '0.0'}%  （健康值应 >80%）`);
}
