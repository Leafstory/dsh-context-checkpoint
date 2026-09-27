#!/usr/bin/env node
/**
 * context-checkpoint 辅助脚本：定位 / 预算核算 / 结构校验 / 代际归档 / slug。
 *
 * 只做机器能可靠判断的事；语义判断（相关性、摘要内容）留给模型。
 *
 * 用法:
 *   node checkpoint.mjs locate  --root <项目根> [--quiet]
 *   node checkpoint.mjs budget  --file <path>
 *   node checkpoint.mjs verify  --file <path>
 *   node checkpoint.mjs archive --file <path> [--root <项目根>]
 *   node checkpoint.mjs slug    --text "<任务描述>"
 *
 * 退出码契约:
 *   0 = 通过（budget 含「超软目标但仍可接受」）
 *   1 = 内容/结构问题（verify 结构不合格；budget 超硬上限）
 *   2 = 用法错误、IO 错误、未知子命令
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

/** 预算：软目标与硬上限（token）。中文按 1.7 字符/token，ASCII 按 4 字符/token。 */
const SOFT_TOKENS = 15_000;
const HARD_TOKENS = 50_000;
const CJK_CHARS_PER_TOKEN = 1.7;
const ASCII_CHARS_PER_TOKEN = 4;

/** canonical 文件名：important_view.<task>-<session>.md（无标识的 important_view.md 也接受）。
 *  字符集覆盖 Unicode 字母/数字，否则中文 task slug 生成的文件会被静默漏掉。 */
const CANONICAL_RE = /^important_view(?:\.[\p{L}\p{N}._-]+)?\.md$/u;
/** 归档文件名：important_view.<task>-<session>.gNNN.md */
const ARCHIVE_GEN_RE = (stem) => new RegExp(`^${stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.g(\\d{3,})\\.md$`);

/** frontmatter 必填键。 */
const REQUIRED_KEYS = [
  'schema_version', 'project_id', 'task_id', 'session_id', 'status',
  'created_at', 'updated_at', 'generation', 'project_root',
  'git_branch', 'git_head', 'working_tree', 'memory_reason'
];
const VALID_STATUS = new Set(['active', 'completed', 'superseded']);
const VALID_REASON = new Set(['milestone', 'context_pressure', 'post_compaction', 'emergency', 'manual']);
const VALID_WORKING_TREE = new Set(['clean', 'dirty', 'unknown']);

/** 必备小节：缺任一即判定结构不合格（防止"只写了一半"被当成写成功）。 */
const REQUIRED_SECTIONS = [
  '# Fast Resume',
  '## Current Goal',
  '## Current State',
  '## Next Action',
  '# Hard Constraints / Invariants',
  '# Decisions',
  '# Validation State',
  '# Recovery / Revalidation'
];
/** 文末哨兵：证明文件写到结尾而非被截断。 */
const TAIL_SENTINEL = '<!-- checkpoint:end -->';

function arg(name, fallback = undefined) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
}

/** 粗略 token 估算：CJK 与其余字符分别按各自密度计。
 *  tokensLow  = DSH 自己的启发式（4 字符/token）—— 会低估真实占用；
 *  tokensHigh = 中文最坏密度（1.7 字符/token）—— 预算应以它为准。
 */
function estimateTokens(text) {
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    const isCjk =
      (cp >= 0x2e80 && cp <= 0x2eff) || // CJK 部首补充
      (cp >= 0x3000 && cp <= 0x303f) || // CJK 标点
      (cp >= 0x3400 && cp <= 0x4dbf) || // 扩展 A
      (cp >= 0x4e00 && cp <= 0x9fff) || // 基本区
      (cp >= 0xf900 && cp <= 0xfaff) || // 兼容表意
      (cp >= 0xfe30 && cp <= 0xfe4f) || // CJK 兼容形式
      (cp >= 0xff00 && cp <= 0xffef) || // 全角
      (cp >= 0x20000 && cp <= 0x2a6df) || // 扩展 B
      (cp >= 0x2a700 && cp <= 0x2ebef);   // 扩展 C–F
    if (isCjk) cjk += 1;
    else other += 1;
  }
  const otherTokens = Math.ceil(other / ASCII_CHARS_PER_TOKEN);
  return {
    cjkChars: cjk,
    otherChars: other,
    tokensLow: Math.ceil(cjk / ASCII_CHARS_PER_TOKEN) + otherTokens,
    tokensHigh: Math.ceil(cjk / CJK_CHARS_PER_TOKEN) + otherTokens
  };
}

/** 解析 YAML-ish frontmatter（只认 `key: value` 单行，够用且不引依赖）。
 *  容忍：BOM、CRLF、行内 `# 注释`、值两端引号。列表值（`key:` 后跟 `- x`）解析为空串。 */
function parseFrontmatter(text) {
  const src = text.replace(/^\uFEFF/, '');
  if (!/^---\r?\n/.test(src)) return { ok: false, reason: '文件不以 --- 开头（注意 UTF-8 BOM）' };
  const end = src.search(/\r?\n---\r?\n/);
  if (end === -1) return { ok: false, reason: 'frontmatter 缺少结束的 ---（需独占一行）' };
  const firstBreak = /\r?\n/.exec(src);
  const body = src.slice(firstBreak.index + firstBreak[0].length, end + 1);
  const data = {};
  // 先整体规范化换行，避免 split 后最后一行残留尾部 \r（会让该行的键解析失败）。
  for (const line of body.replace(/\r\n?/g, '\n').split('\n')) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/);
    if (!m) continue;
    // 去掉行内注释：只认「水平空白 + #」，避免 `\s` 吃掉换行后误把下一行的 `#` 当注释。
    let value = m[2];
    const hash = value.search(/[ \t]#/);
    if (hash !== -1) value = value.slice(0, hash);
    data[m[1]] = value.trim().replace(/^["']|["']$/g, '');
  }
  return { ok: true, data };
}

function findCanonicalFiles(root) {
  if (!existsSync(root)) return [];
  if (!statSync(root).isDirectory()) throw new Error(`--root 不是目录: ${root}`);
  return readdirSync(root)
    .filter((name) => CANONICAL_RE.test(name))
    .map((name) => join(root, name))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
}

/** 列出归档目录里的代际文件（canonical 丢失时用于回退定位）。 */
function findArchivedFiles(root) {
  const dir = join(root, '.dsh', 'memory');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => /^important_view.*\.g\d{3,}\.md$/.test(name))
    .map((name) => join(dir, name))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
}

function cmdLocate() {
  const root = resolve(arg('root', process.cwd()));
  const quiet = process.argv.includes('--quiet');
  const files = findCanonicalFiles(root);
  const archived = files.length === 0 ? findArchivedFiles(root) : [];

  if (quiet) {
    // 每轮廉价扫描用：只出必要字段，避免把整份 frontmatter 灌进 transcript。
    const pick = (f) => {
      const fm = parseFrontmatter(readFileSync(f, 'utf8'));
      return {
        name: basename(f),
        path: f,
        generation: fm.ok ? (fm.data.generation ?? null) : null,
        status: fm.ok ? (fm.data.status ?? null) : null,
        updatedAt: fm.ok ? (fm.data.updated_at ?? null) : null,
        mtime: new Date(statSync(f).mtimeMs).toISOString()
      };
    };
    console.log(JSON.stringify({
      root,
      exists: files.length > 0,
      count: files.length,
      files: files.map(pick),
      fallbackFromArchive: archived.length > 0,
      archived: archived.slice(0, 1).map(pick)
    }, null, 2));
    return 0;
  }

  const detail = (f) => {
    const text = readFileSync(f, 'utf8');
    const fm = parseFrontmatter(text);
    return {
      path: f,
      name: basename(f),
      bytes: statSync(f).size,
      mtime: new Date(statSync(f).mtimeMs).toISOString(),
      frontmatter: fm.ok ? fm.data : null,
      frontmatterError: fm.ok ? null : fm.reason
    };
  };

  console.log(JSON.stringify({
    root,
    exists: files.length > 0,
    count: files.length,
    canonical: files.map(detail),
    archivedFallback: archived.slice(0, 3).map(detail),
    hint: files.length > 1
      ? '发现多份 canonical 文件：优先取 frontmatter.status=active 且 updated_at 最新的一份；其余视为候选。'
      : files.length === 0 && archived.length > 0
        ? '项目根没有 canonical，但归档目录有代际文件：上一代可能在归档与写入之间中断。可从最新归档恢复。'
        : null
  }, null, 2));
  return 0;
}

function cmdBudget() {
  const file = arg('file');
  if (!file) { console.error('用法: budget --file <path>'); return 2; }
  if (!existsSync(file)) { console.error(`文件不存在: ${file}`); return 2; }
  const text = readFileSync(file, 'utf8');
  const est = estimateTokens(text);
  const verdict = est.tokensHigh > HARD_TOKENS ? 'OVER_HARD_CEILING'
    : est.tokensHigh > SOFT_TOKENS ? 'OVER_SOFT_TARGET'
      : 'OK';
  console.log(JSON.stringify({
    file: resolve(file),
    bytes: statSync(file).size,
    totalChars: text.length,
    ...est,
    softTarget: SOFT_TOKENS,
    hardCeiling: HARD_TOKENS,
    verdict,
    advice: verdict === 'OVER_HARD_CEILING'
      ? '必须折叠：删除已完成细节、superseded 决策只留引用、代码改记 path::symbol、日志改记 command/result/关键错误串（归档旧代际不会减小当前文件体积）。'
      : verdict === 'OVER_SOFT_TARGET'
        ? '建议折叠，但不强制：优先删已解决且不再构成 pitfall 的条目。'
        : '体积健康。'
  }, null, 2));
  return verdict === 'OVER_HARD_CEILING' ? 1 : 0;
}

function cmdVerify() {
  const file = arg('file');
  if (!file) { console.error('用法: verify --file <path>'); return 2; }
  if (!existsSync(file)) {
    console.log(JSON.stringify({ file: resolve(file), ok: false, problems: ['文件不存在（写入未落盘）'] }, null, 2));
    return 1;
  }
  const text = readFileSync(file, 'utf8');
  const problems = [];
  const warnings = [];

  if (!CANONICAL_RE.test(basename(file))) {
    problems.push(`文件名不符合约定（${CANONICAL_RE}）: ${basename(file)}`);
  }
  if (statSync(file).size === 0) problems.push('文件大小为 0');

  const fm = parseFrontmatter(text);
  if (!fm.ok) {
    problems.push(`frontmatter 无法解析: ${fm.reason}`);
  } else {
    for (const key of REQUIRED_KEYS) {
      if (!(key in fm.data)) { problems.push(`frontmatter 缺少键: ${key}`); continue; }
      if (fm.data[key] === '') problems.push(`frontmatter 键为空: ${key}`);
    }
    if (fm.data.status && !VALID_STATUS.has(fm.data.status)) {
      problems.push(`status 非法: ${fm.data.status}（应为 ${[...VALID_STATUS].join('|')}）`);
    }
    if (fm.data.memory_reason && !VALID_REASON.has(fm.data.memory_reason)) {
      problems.push(`memory_reason 非法: ${fm.data.memory_reason}（应为 ${[...VALID_REASON].join('|')}）`);
    }
    if (fm.data.working_tree && !VALID_WORKING_TREE.has(fm.data.working_tree)) {
      warnings.push(`working_tree 非标准值: ${fm.data.working_tree}（建议 ${[...VALID_WORKING_TREE].join('|')}）`);
    }
    const gen = Number(fm.data.generation);
    if (fm.data.generation !== undefined && (!Number.isInteger(gen) || gen < 0)) {
      problems.push(`generation 必须是非负整数，实际: ${fm.data.generation}`);
    }
    for (const key of ['created_at', 'updated_at']) {
      const value = fm.data[key];
      if (value !== undefined && value !== '' && Number.isNaN(Date.parse(value))) {
        warnings.push(`${key} 不是可解析的时间: ${value}（§3.1 排序与 §3.2 TTL 依赖它）`);
      }
    }
    if (fm.data.project_root) {
      const normalize = (p) => resolve(p).replace(/[\\/]+$/, '').toLowerCase();
      if (normalize(fm.data.project_root) !== normalize(dirname(resolve(file)))) {
        warnings.push(`project_root (${fm.data.project_root}) 与文件所在目录不一致；下次 locate --root 可能找不到它`);
      }
    }
  }

  // 必备小节：防止"只写了头部/被截断"被当作写成功。
  for (const section of REQUIRED_SECTIONS) {
    if (!text.includes(section)) problems.push(`缺少必备小节: ${section}`);
  }
  if (!text.includes(TAIL_SENTINEL)) {
    problems.push(`缺少文末哨兵 ${TAIL_SENTINEL}（文件可能被截断，或未按 §4.2 骨架书写）`);
  }

  const est = estimateTokens(text);
  if (est.tokensHigh > HARD_TOKENS) problems.push(`超出硬上限: ~${est.tokensHigh} token > ${HARD_TOKENS}`);

  console.log(JSON.stringify({
    file: resolve(file),
    bytes: statSync(file).size,
    chars: text.length,
    estimatedTokens: est.tokensHigh,
    ok: problems.length === 0,
    problems,
    warnings
  }, null, 2));
  return problems.length === 0 ? 0 : 1;
}

/** 归档 = 先复制到归档目录，成功后才删除 canonical（避免中断后 canonical 失联）。 */
function cmdArchive() {
  const file = arg('file');
  if (!file || !existsSync(file)) { console.error('用法: archive --file <path>（文件须存在）'); return 2; }
  const target = resolve(file);
  const root = resolve(arg('root', dirname(target)));
  const archiveDir = join(root, '.dsh', 'memory');
  mkdirSync(archiveDir, { recursive: true });

  const stem = basename(target).replace(/\.md$/, '');
  const text = readFileSync(target, 'utf8');
  const fm = parseFrontmatter(text);
  const declared = fm.ok ? Number(fm.data.generation) : NaN;
  /** 已归档的最大代际。 */
  let maxArchived = 0;
  for (const name of readdirSync(archiveDir)) {
    const m = name.match(ARCHIVE_GEN_RE(stem));
    if (m) maxArchived = Math.max(maxArchived, Number(m[1]));
  }
  // 归档序号与 frontmatter.generation 是同一条序列：取两者的较大者 + 1。
  const archivedGeneration = Math.max(Number.isInteger(declared) ? declared : 0, maxArchived + 1 || 1);
  const dest = join(archiveDir, `${stem}.g${String(archivedGeneration).padStart(3, '0')}.md`);
  if (existsSync(dest)) throw new Error(`归档目标已存在，拒绝覆盖: ${dest}`);

  copyFileSync(target, dest);
  if (readFileSync(dest, 'utf8').length !== text.length) throw new Error(`归档副本长度不一致，已保留原文件: ${dest}`);
  unlinkSync(target);

  console.log(JSON.stringify({
    archived: dest,
    archivedGeneration,
    nextGeneration: archivedGeneration + 1,
    note: `旧代际已归档为 g${String(archivedGeneration).padStart(3, '0')}。新 canonical 文件请把 frontmatter.generation 设为 nextGeneration，并补上 ${TAIL_SENTINEL}。`
  }, null, 2));
  return 0;
}

/** 生成 task slug：优先英文/拼音，避免中文（文件名与 glob 都更稳）。 */
function cmdSlug() {
  const text = arg('text', '');
  if (!text) { console.error('用法: slug --text "<任务描述>"'); return 2; }
  const MAX = 32;
  let slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (slug.length > MAX) {
    // 在词边界截断，避免把单词切成半截（context-checkpoint-desig）。
    const cut = slug.slice(0, MAX);
    const lastDash = cut.lastIndexOf('-');
    slug = lastDash > 0 ? cut.slice(0, lastDash) : cut;
  }
  if (!slug) {
    console.log('task');
    return 0;
  }
  console.log(slug);
  return 0;
}

const COMMANDS = Object.assign(Object.create(null), {
  locate: cmdLocate, budget: cmdBudget, verify: cmdVerify, archive: cmdArchive, slug: cmdSlug
});

const cmd = process.argv[2];
if (!Object.hasOwn(COMMANDS, cmd ?? '')) {
  console.error(`未知子命令: ${cmd ?? '(空)'}\n可用: ${Object.keys(COMMANDS).join(' | ')}`);
  process.exit(2);
}
try {
  process.exitCode = COMMANDS[cmd]();
} catch (error) {
  // IO / 用法类异常统一归到 2，契约里 1 只表示"内容或结构问题"。
  console.error(JSON.stringify({ ok: false, error: String(error && error.message ? error.message : error) }, null, 2));
  process.exitCode = 2;
}
