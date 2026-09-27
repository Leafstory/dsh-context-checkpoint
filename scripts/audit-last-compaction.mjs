/**
 * 核查最近的压缩尝试与插件行为（只读）。
 * 用法: node scripts/audit-last-compaction.mjs <session.v3.jsonl.zstd>
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

// 1) 真实压缩事件（带 error 的也要看）
const events = [];
for (const [idx, line] of lines.entries()) {
  let ev;
  try { ev = JSON.parse(line); } catch { continue; }
  if (ev?.type?.startsWith('compaction/')) events.push({ idx, type: ev.type, data: ev.data });
}

console.log(`事件行: ${lines.length}\n`);
console.log(`── compaction 事件（${events.length} 条）──`);
for (const e of events.slice(-12)) {
  const err = e.data?.error ? `  ERROR: ${String(e.data.error).slice(0, 90)}` : '';
  const id = e.data?.compactionId ? ` id=${String(e.data.compactionId).slice(0, 8)}` : '';
  const turn = e.data?.turn !== undefined ? ` turn=${e.data.turn}` : '';
  console.log(`  #${e.idx} ${e.type}${id}${turn}${err}`);
}
if (events.length === 0) console.log('  （无）');

// 2) 插件注入的消息（user/message 来自插件）
console.log('\n── 插件注入的消息 ──');
let injected = 0;
for (const [idx, line] of lines.entries()) {
  if (!line.includes('context-checkpoint')) continue;
  let ev;
  try { ev = JSON.parse(line); } catch { continue; }
  if (ev?.type !== 'user/message') continue;
  const src = ev.data?.source;
  if (src?.plugin !== '@dsh-external/context-checkpoint') continue;
  injected += 1;
  const text = (ev.data?.content ?? []).map((b) => b?.text ?? '').join(' ').slice(0, 110);
  console.log(`  #${idx} ${text}`);
}
if (injected === 0) console.log('  （无）');

// 3) 旧/新文案出场情况
console.log('\n── 版本特征字符串 ──');
for (const [label, needle] of [
  ['旧: 压缩失败', '【context-checkpoint】压缩失败'],
  ['旧: Compaction scheduled', 'Compaction scheduled (it runs after this turn ends'],
  ['新: Compaction scheduled', 'Compaction scheduled'],
  ['新: idle boundary', 'next idle boundary'],
  ['越线提醒', '【上下文占用】已过半']
]) {
  console.log(`  ${label}: ${(lines.join('\n').split(needle).length - 1)} 处`);
}

// 4) 真实用量是否已越过阈值
const THRESHOLD = 800_000;
let lastUsage = null;
for (const line of lines) {
  let ev;
  try { ev = JSON.parse(line); } catch { continue; }
  if (ev?.type !== 'assistant/message') continue;
  const u = ev.data?.usage;
  if (!u) continue;
  lastUsage = (u.inputTokens ?? 0) + (u.cacheReadTokens ?? 0) + (u.cacheWriteTokens ?? 0);
}
if (lastUsage !== null) {
  console.log(`\n最新请求总输入: ${lastUsage.toLocaleString('en-US')} / 阈值 ${THRESHOLD.toLocaleString('en-US')}` +
    (lastUsage < THRESHOLD ? `（还差 ${(THRESHOLD - lastUsage).toLocaleString('en-US')}）` : '（已达阈值）'));
}
