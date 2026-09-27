/**
 * 现场取证：按**事件类型**列出会话事件（只读）。默认只看本工作目录的最新会话。
 *
 * 为什么单独写一个：`tail-session.mjs` 的过滤参数是对原始 JSONL 行做字面子串匹配，
 * 想精确匹配 `"type":"system/message"` 就得把双引号传进去 —— 而经 PowerShell 传参会
 * 把引号吃掉（ps 把空串塞进来 → 过滤条件退化成"匹配所有行"）。这里改成解析后按
 * `ev.type` 精确比较，彻底绕开 shell 引号。
 *
 * 用法:
 *   node scripts/list-events.mjs system/message                 # 列出全部 system/message
 *   node scripts/list-events.mjs system/message --last 6        # 只列最后 6 条
 *   node scripts/list-events.mjs system/message --grep "generation: 6"   # 逐条标注命中
 *   node scripts/list-events.mjs compaction/start --all         # 跨全部项目
 *   node scripts/list-events.mjs system/message --session 57d4c0ff
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { zstdDecompressSync } from 'node:zlib';
import { join } from 'node:path';
import { resolveProjectSessions, resolveSessionsRoot } from './paths.mjs';

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const PROJECT_SESSIONS = resolveProjectSessions();

const argv = process.argv.slice(2);
const allProjects = argv.includes('--all');
const flag = (name, fallback) => {
  const i = argv.indexOf(name);
  return i === -1 ? fallback : argv[i + 1];
};
const type = argv.find((a) => !a.startsWith('--') && argv[argv.indexOf(a) - 1] !== '--last'
  && argv[argv.indexOf(a) - 1] !== '--grep' && argv[argv.indexOf(a) - 1] !== '--session');
const last = Number(flag('--last', 0));
const grep = flag('--grep', null);
const sessionFilter = flag('--session', null);

if (!type) {
  console.error('用法: node scripts/list-events.mjs <event-type> [--last N] [--grep 文本] [--session 子串] [--all]');
  process.exit(2);
}

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

const root = allProjects ? resolveSessionsRoot() : PROJECT_SESSIONS;
const sessions = [];
const walk = (p) => {
  for (const entry of readdirSync(p, { withFileTypes: true })) {
    const full = join(p, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (/\.jsonl\.zstd$/.test(entry.name)) sessions.push({ file: full, mtime: statSync(full).mtimeMs });
  }
};
walk(root);
sessions.sort((a, b) => b.mtime - a.mtime);
const pool = sessionFilter ? sessions.filter((s) => s.file.includes(sessionFilter)) : sessions;
if (!pool.length) { console.error('没有匹配的会话文件'); process.exit(1); }

const target = pool[0];
const lines = decompress(target.file).split('\n').filter((l) => l.trim());
console.log(`== ${target.file} (${lines.length} 行) ==`);
console.log(`筛选: type=${type}${grep ? ` grep="${grep}"` : ''}${last ? ` last=${last}` : ''}\n`);

const hits = [];
for (let idx = 0; idx < lines.length; idx += 1) {
  if (!lines[idx].includes(type)) continue; // 便宜的前置过滤（真正判定在下面）
  let ev = null;
  try { ev = JSON.parse(lines[idx]); } catch { continue; }
  if (ev.type !== type) continue;
  hits.push({ idx, ev, raw: lines[idx] });
}

const shown = last > 0 ? hits.slice(-last) : hits;
console.log(`共 ${hits.length} 条 ${type} 事件${last ? `（显示最后 ${shown.length} 条）` : ''}\n`);

for (const { idx, ev, raw } of shown) {
  const d = ev.data ?? {};
  let brief = '';
  if (type === 'system/message' || type === 'user/message') {
    const text = (d.message?.content ?? d.content ?? []).map((b) => b?.text ?? '').join('');
    const gen = /generation:\s*(\d+)/.exec(text);
    brief = `src=${d.source?.plugin ?? d.source?.kind ?? (type === 'system/message' ? 'system' : '?')} bytes=${Buffer.byteLength(text)}${gen ? ` generation=${gen[1]}` : ''} :: ${text.slice(0, 80).replace(/\s+/g, ' ')}`;
  } else if (type === 'compaction/start') brief = `id=${String(d.compactionId).slice(0, 8)} turn=${d.turn ?? '?'}`;
  else if (type === 'compaction/end') brief = `id=${String(d.compactionId).slice(0, 8)} error=${d.error ? String(d.error).slice(0, 120) : 'none'}`;
  else brief = JSON.stringify(d).slice(0, 160);

  const mark = grep === null ? '' : (raw.includes(grep) ? ` [grep:命中]` : ` [grep:无]`);
  console.log(`#${idx} ${brief}${mark}`);
}
