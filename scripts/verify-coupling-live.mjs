/**
 * 取证：②③ 连用是否真的执行成功（只读）。
 * 用法: node scripts/verify-coupling-live.mjs [sessionsDir]
 *
 * 判据（按重要性）：
 *   1. 出现 compaction/start + compaction/end 且 end 无 error  → 压缩真的成功
 *   2. surface.replaceGeneration 前进                          → 表层确实被替换
 *   3. 出现插件的续读消息（"检查点已落盘，历史已压缩"）           → followup 生效
 *   4. 系统提示词段换成新检查点正文                             → 第 ④ 步闭环
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

const { file, mtime } = sessions[0];
const lines = decompress(file).split('\n').filter((l) => l.trim());
console.log(`会话: ${join(file).split(/[\\/]/).slice(-2)[0]}`);
console.log(`写入时间: ${new Date(mtime).toLocaleString()}`);
console.log(`事件行: ${lines.length}\n`);

// 压缩事件
const starts = [];
const ends = [];
const parsed = [];
for (const [idx, line] of lines.entries()) {
  let ev;
  try { ev = JSON.parse(line); } catch { continue; }
  parsed.push({ idx, type: ev?.type, data: ev?.data ?? {} });
  if (ev?.type === 'compaction/start') starts.push({ idx, ...ev.data });
  if (ev?.type === 'compaction/end') ends.push({ idx, ...ev.data });
}

// ── 归属权：这次压缩是**插件上膛**触发的，还是 DSH 原生兜底触发的？──────────
// 判据（`compaction/start` 事件本身没有 trigger 字段，所以只能靠前后文推断）：
//   A. 之前出现 `context_compact` 的工具调用，且其后没有请求失败 → 插件上膛路径
//   B. 之前出现 `assistant/attempt`（请求被服务端拒绝）  → DSH 的 overflow 重试路径
//   C. 都不是 → 归因不明（可能是 DSH 的 pressure 阈值路径，需要占用真的到 800k）
// 顺带打印 start 之前的最后一次请求输入量 —— 用它佐证"不可能撞到 DSH 阈值"。
const compactCallIdxs = parsed
  .filter((e) => e.type === 'tool/call' && e.data?.name === 'context_compact')
  .map((e) => e.idx);
const attemptIdxs = parsed.filter((e) => e.type === 'assistant/attempt').map((e) => e.idx);

function inputBefore(idx) {
  for (let i = parsed.length - 1; i >= 0; i -= 1) {
    const e = parsed[i];
    if (e.idx >= idx) continue;
    if (e.type === 'assistant/message' && e.data?.usage) {
      const u = e.data.usage;
      return (u.inputTokens ?? 0) + (u.cacheReadTokens ?? 0) + (u.cacheWriteTokens ?? 0);
    }
  }
  return null;
}

function attribute(idx) {
  const arm = compactCallIdxs.filter((i) => i < idx && i > idx - 400).pop();
  const attempt = attemptIdxs.filter((i) => i < idx && i > idx - 400).pop();
  if (arm !== undefined && (attempt === undefined || arm > attempt)) {
    return `插件上膛（#${arm} 调用 context_compact，间隔 ${idx - arm} 个事件）`;
  }
  if (attempt !== undefined) return `DSH 原生 overflow 重试（此前有请求被拒 #${attempt}）`;
  if (arm !== undefined) return `插件上膛（#${arm}，但期间另有请求被拒 #${attempt}）`;
  return '归因不明（无工具调用、无请求失败 → 若是 DSH pressure 路径，占用应已达 800k）';
}

console.log(`── 压缩事件: start=${starts.length} end=${ends.length} ──`);
for (const s of starts.slice(-5)) {
  const end = ends.find((e) => e.compactionId === s.compactionId);
  const err = end?.error ? `  ✗ ERROR: ${String(end.error).slice(0, 90)}` : '  ✓ 无 error';
  const inTok = inputBefore(s.idx);
  console.log(`  #${s.idx} id=${String(s.compactionId).slice(0, 8)} turn=${s.turn ?? '?'}`);
  console.log(`      end=${end ? `#${end.idx}` : '缺失'}${err}`);
  console.log(`      归因: ${attribute(s.idx)}`);
  console.log(`      压缩前请求输入: ${inTok === null ? '未知' : inTok.toLocaleString('en-US')}（DSH 自带阈值 800,000）`);
}

// 插件续读消息
console.log('\n── 插件注入的消息（最近 6 条）──');
let n = 0;
const injected = [];
for (const [idx, line] of lines.entries()) {
  if (!line.includes('context-checkpoint')) continue;
  let ev;
  try { ev = JSON.parse(line); } catch { continue; }
  if (ev?.type !== 'user/message' || ev.data?.source?.plugin !== '@dsh-external/context-checkpoint') continue;
  const text = (ev.data?.content ?? []).map((b) => b?.text ?? '').join(' ');
  injected.push({ idx, text });
}
for (const m of injected.slice(-6)) {
  console.log(`  #${m.idx} ${m.text.slice(0, 120)}`);
}
if (injected.length === 0) console.log('  （无）');

// 静态段是否换新（看 surface 代际相关的检查点文本出现次数）
const text = lines.join('\n');
console.log('\n── 版本与闭环特征 ──');
const marks = [
  ['新工具文案 Compaction is armed', 'Compaction is armed'],
  ['续读消息（压缩后）', '检查点已落盘，历史已压缩'],
  ['旧续读消息', '压缩失败'],
  ['检查点正文注入标志', '跨压缩/跨会话的权威副本']
];
for (const [label, needle] of marks) {
  console.log(`  ${label}: ${text.split(needle).length - 1} 处`);
}

// 最新用量与阈值
let last = null;
for (const line of lines) {
  let ev;
  try { ev = JSON.parse(line); } catch { continue; }
  if (ev?.type !== 'assistant/message' || !ev.data?.usage) continue;
  const u = ev.data.usage;
  last = (u.inputTokens ?? 0) + (u.cacheReadTokens ?? 0) + (u.cacheWriteTokens ?? 0);
}
if (last !== null) console.log(`\n最新请求总输入: ${last.toLocaleString('en-US')} / 阈值 800,000`);
