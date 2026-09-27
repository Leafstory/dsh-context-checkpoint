/**
 * 现场取证：打印最新会话日志的尾部事件（只读）。默认只看本工作目录的会话。
 * 用法:
 *   node scripts/tail-session.mjs             # 本工作目录最新会话的最后 30 行
 *   node scripts/tail-session.mjs 60          # 最后 60 行
 *   node scripts/tail-session.mjs 200 compaction   # 最后 200 行中匹配 compaction 的
 *   node scripts/tail-session.mjs 200 user/message context-checkpoint
 *   node scripts/tail-session.mjs 40 --all    # 跨全部项目扫描（默认只看本项目）
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { zstdDecompressSync } from 'node:zlib';
import { join } from 'node:path';
import { resolveProjectSessions, resolveSessionsRoot } from './paths.mjs';

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
/**
 * 默认只看**本工作目录**的会话。
 * 踩过的坑：原来扫全部项目再按 mtime 取最新，别的项目一写入这里就跟着切过去 ——
 * 行号对得上、内容却是别人的会话。要跨项目看时显式加 `--all`。
 */
const PROJECT_SESSIONS = resolveProjectSessions();
const allProjects = process.argv.includes('--all');
const sessionsRoot = allProjects ? resolveSessionsRoot() : PROJECT_SESSIONS;
const limit = Number(process.argv[2] ?? 30);
const filters = process.argv.slice(3).filter((a) => a !== '--all');

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
    else if (/\.jsonl\.zstd$/.test(entry.name)) sessions.push({ file: full, mtime: statSync(full).mtimeMs, size: statSync(full).size });
  }
};
walk(sessionsRoot);
sessions.sort((a, b) => b.mtime - a.mtime);

console.log('最近 5 个会话文件:');
for (const s of sessions.slice(0, 5)) {
  console.log(`  ${new Date(s.mtime).toLocaleString()}  ${(s.size / 1024).toFixed(0)}KB  ${s.file.replace(sessionsRoot, '')}`);
}

const target = sessions[0];
const lines = decompress(target.file).split('\n').filter((l) => l.trim());
console.log(`\n== ${target.file} (${lines.length} 行) ==\n`);

const pick = filters.length
  ? lines.map((l, idx) => ({ l, idx })).filter(({ l }) => filters.every((f) => l.includes(f))).slice(-limit)
  : lines.map((l, idx) => ({ l, idx })).slice(-limit);

for (const { l, idx } of pick) {
  let ev = null;
  try { ev = JSON.parse(l); } catch { /* raw */ }
  if (!ev) { console.log(`#${idx} [raw] ${l.slice(0, 300)}`); continue; }
  const type = ev.type ?? '?';
  const d = ev.data ?? {};
  let brief = '';
  if (type === 'compaction/start') brief = `id=${String(d.compactionId).slice(0, 8)} turn=${d.turn ?? '?'}`;
  else if (type === 'compaction/end') brief = `id=${String(d.compactionId).slice(0, 8)} error=${d.error ? String(d.error).slice(0, 120) : 'none'}`;
  else if (type === 'user/message') {
    const text = (d.content ?? []).map((b) => b?.text ?? '').join(' ');
    brief = `src=${d.source?.plugin ?? d.source?.kind ?? 'user'} :: ${text.slice(0, 200).replace(/\s+/g, ' ')}`;
  } else if (type === 'assistant/message') {
    const text = (d.content ?? []).map((b) => b?.text ?? b?.name ?? '').join(' ');
    const u = d.usage;
    brief = `${u ? `in=${((u.inputTokens ?? 0) + (u.cacheReadTokens ?? 0) + (u.cacheWriteTokens ?? 0)).toLocaleString('en-US')} out=${u.outputTokens ?? 0} :: ` : ''}${text.slice(0, 160).replace(/\s+/g, ' ')}`;
  } else if (type === 'assistant/attempt') brief = JSON.stringify(d).slice(0, 1500);
  else brief = JSON.stringify(d).slice(0, 200);

  console.log(`#${idx} ${type} ${brief}`);
}
