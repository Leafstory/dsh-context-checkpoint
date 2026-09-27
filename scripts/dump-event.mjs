/**
 * 现场取证：按行号 dump 最新会话日志中的事件**完整 JSON**（只读，不截断）。
 * 用法:
 *   node scripts/dump-event.mjs 4714              # dump 第 4714 行
 *   node scripts/dump-event.mjs 4704 4721         # 多个行号
 *   node scripts/dump-event.mjs 4704 --grep systemPrompt   # 只打印匹配该子串的字段树
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { zstdDecompressSync } from 'node:zlib';
import { join } from 'node:path';
import { resolveProjectSessions, resolveSessionsRoot } from './paths.mjs';

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
/**
 * 默认只看**本工作目录**的会话。
 * 踩过的坑：原来按 mtime 取"最新会话文件"，结果别的项目一写入，这里就跟着切过去 ——
 * 行号是对上了，内容却是别人的会话，取证结论直接作废。加 `--all` 才扫全部项目。
 */
const PROJECT_SESSIONS = resolveProjectSessions();
const sessionsRoot = process.argv.includes('--all') ? resolveSessionsRoot() : PROJECT_SESSIONS;

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
    else if (/\.jsonl\.zstd$/.test(entry.name)) sessions.push({ file: full, mtime: statSync(full).mtimeMs });
  }
};
walk(sessionsRoot);
sessions.sort((a, b) => b.mtime - a.mtime);

const lines = decompress(sessions[0].file).split('\n').filter((l) => l.trim());
console.log(`== ${sessions[0].file} (${lines.length} 行) ==`);

const argv = process.argv.slice(2);
const grepIdx = argv.indexOf('--grep');
const grep = grepIdx !== -1 ? argv[grepIdx + 1] : null;
const idxs = argv.filter((a) => /^\d+$/.test(a)).map(Number);

if (idxs.length === 0) {
  console.error('用法: node scripts/dump-event.mjs <行号> [更多行号] [--grep 子串]');
  process.exit(2);
}

/**
 * 命中处**上下文**（不是只有前 120 字节）。
 *
 * 为什么要改：原来命中只打印该字符串的**开头**，于是「同一子串出现在两处不同文本里」
 * 完全区分不出来 —— 例如 `22:47` 既出现在检查点正文，也出现在压缩摘要里，
 * 光看"命中了"会把摘要误当成"提示词段已跨代刷新"。现在打印命中点前后各一段，
 * 并标注 `命中@偏移`，是否真的来自目标段落可以当场判断。
 */
function snippet(value, at, label) {
  const from = Math.max(0, at - 160);
  const to = Math.min(value.length, at + grep.length + 240);
  const head = from > 0 ? '…' : '';
  const tail = to < value.length ? '…' : '';
  return `  @${label}  (长度 ${value.length} 字节, 命中@${at})\n      ${head}${value.slice(from, to).replace(/\s+/g, ' ')}${tail}`;
}

/** 深度遍历对象，打印命中子串的路径与命中处上下文。 */
function walkFind(node, path, hits) {
  if (node === null || typeof node !== 'object') return;
  for (const [key, value] of Object.entries(node)) {
    const p = `${path}.${key}`;
    if (typeof value === 'string') {
      const at = value.indexOf(grep);
      if (at !== -1) hits.push(`${p}\n${snippet(value, at, 'str')}`);
    } else if (Array.isArray(value)) {
      value.forEach((v, i) => {
        if (typeof v === 'string' && v.includes(grep)) hits.push(`${p}[${i}]\n${snippet(v, v.indexOf(grep), `arr[${i}]`)}`);
        else walkFind(v, `${p}[${i}]`, hits);
      });
    } else walkFind(value, p, hits);
  }
}

for (const idx of idxs) {
  const raw = lines[idx];
  if (!raw) { console.log(`\n#${idx} （不存在）`); continue; }
  let ev = null;
  try { ev = JSON.parse(raw); } catch { /* raw */ }
  console.log(`\n${'─'.repeat(70)}\n#${idx}  ${ev ? ev.type : '[raw]'}\n${'─'.repeat(70)}`);
  if (!ev) { console.log(raw.slice(0, 4000)); continue; }
  if (grep) {
    const hits = [];
    walkFind(ev, '', hits);
    console.log(hits.length ? hits.join('\n') : `（未命中 "${grep}"）`);
  } else {
    const json = JSON.stringify(ev, null, 2);
    console.log(json.length > 12000 ? `${json.slice(0, 12000)}\n…（截断，共 ${json.length} 字节）` : json);
  }
}
