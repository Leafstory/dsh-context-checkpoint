#!/usr/bin/env node
/**
 * context-checkpoint 构建脚本：**校验 + 复制**（刻意不做编译）。
 *
 * 为什么不用 tsc：
 *  1. 本机没有可用的 dsh 源码 checkout（`vendor/cordis`、`packages/*` 的 node_modules 缺失），
 *     脚手架原来的 build.sh 根本跑不起来；
 *  2. 更重要的：手写 lib 曾经被"重新构建"覆盖成旧的守护循环脚手架版本，直接导致插件挂起。
 *
 * 因此本脚本的唯一职责是：**保证 lib/ 永远与 src/ 一致，且 src/ 必须仍然是一个自洽的
 * 零依赖插件**。任何一条校验不过就直接失败，绝不写入 lib。
 *
 * 用法: node scripts/build.mjs [--check]
 *   --check  只校验，不写 lib
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SRC = join(ROOT, 'src', 'index.js');
const LIB = join(ROOT, 'lib', 'index.js');
const CHECK_ONLY = process.argv.includes('--check');

/**
 * 去掉注释与字符串字面量，只留可执行代码。
 * 校验必须在**代码**上做：`ctx.tokenMeter` 出现在注释或给模型看的说明文案里是正常的，
 * 直接对整份源码做正则匹配会产生误报（本脚本第一版就误报过）。
 */
function stripCommentsAndStrings(source) {
  let out = '';
  let i = 0;
  const n = source.length;
  while (i < n) {
    const c = source[i];
    const c2 = source[i + 1];
    if (c === '/' && c2 === '/') {
      while (i < n && source[i] !== '\n') i += 1;
      continue;
    }
    if (c === '/' && c2 === '*') {
      i += 2;
      while (i < n && !(source[i] === '*' && source[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      i += 1;
      while (i < n) {
        if (source[i] === '\\') { i += 2; continue; }
        if (source[i] === quote) { i += 1; break; }
        i += 1;
      }
      out += '""';
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

const problems = [];
const notes = [];

if (!existsSync(SRC)) {
  console.error(`build: 源文件不存在: ${SRC}`);
  process.exit(2);
}
const source = readFileSync(SRC, 'utf8');
const code = stripCommentsAndStrings(source);

// ── 1. 零依赖：绝不能出现 DSH 内部包的 import（那会 ERR_MODULE_NOT_FOUND）──
const forbidden = [...source.matchAll(/^\s*import[^\n]*from\s+['"]([^'"]+)['"]/gm)]
  .map((m) => m[1])
  .filter((spec) => !spec.startsWith('node:'));
if (forbidden.length > 0) {
  problems.push(`存在非 node: 内置模块的 import：${forbidden.join(', ')}（零依赖是本插件能加载的前提）`);
}

// ── 2. inject 声明：绝不能含只在 host 平面的服务 ─────────────────────────
// 历史教训：把 tokenMeter / compaction 写进 inject，会让 web 平面 fiber 永久 pending
// （表现为"插件卡住、DSH 起不来"）。但也不能因此禁止其它合法服务（例如 llm 必须在列表里，
// 否则 ctx.llm 一访问就抛 without inject）—— 所以这里只设**黑名单**，不写死整个列表。
const injectMatch = source.match(/export const inject = \[([^\]]*)\]/);
if (!injectMatch) {
  problems.push('找不到 `export const inject = [...]` 声明');
} else {
  const declared = injectMatch[1].split(',').map((s) => s.trim().replace(/['"]/g, '')).filter(Boolean);
  const HOST_PLANE_ONLY = ['tokenMeter', 'compaction', 'sessions', 'sessionProjections', 'agents', 'commands'];
  const banned = declared.filter((name) => HOST_PLANE_ONLY.includes(name));
  if (banned.length > 0) {
    problems.push(
      `inject 里含只在 host 平面的服务：${banned.join(', ')} —— web 平面取不到，fiber 会永久 pending、DSH 起不来。` +
      ' 这些必须改用 ctx.get() 软解析 + 降级分支。'
    );
  }
  if (!declared.includes('tools') || !declared.includes('systemPrompt')) {
    problems.push('inject 必须含 tools 与 systemPrompt（插件要注册工具与提示词段）');
  }
}

// ── 3. 未声明服务的属性访问必须绝迹（cordis 会直接抛错）──────────────────
// 只在剥离注释/字符串后的代码上检查，避免误报。
// 动态判定：凡是 ctx.X 直接访问，只要 X 不在 inject 里、也不是已知的非服务成员，就拦下。
// 这一条覆盖了历史上两次真实事故：ctx.tokenMeter（写进 inject 会永久 pending）
// 与 ctx.llm（漏写 inject → 一调用就抛 cannot get property "llm" without inject）。
{
  const injectMatch0 = source.match(/export const inject = \[([^\]]*)\]/);
  const declared0 = injectMatch0
    ? injectMatch0[1].split(',').map((s) => s.trim().replace(/['"]/g, '')).filter(Boolean)
    : [];
  // ctx 上允许直接访问的非服务成员。
  const ALLOWED_CTX_MEMBERS = new Set([
    'logger', 'on', 'once', 'effect', 'get', 'set', 'waterfall', 'bail', 'emit', 'parallel', 'serial',
    'scope', 'fiber', 'reflect', 'root', 'ctx', 'extend', 'isolate', 'intercept', 'plugin', 'registry'
  ]);
  const accessed = new Set([...code.matchAll(/ctx\.([A-Za-z_$][\w$]*)/g)].map((m) => m[1]));
  for (const name of accessed) {
    if (ALLOWED_CTX_MEMBERS.has(name)) continue;
    if (declared0.includes(name)) continue;
    problems.push(
      `代码里出现 ctx.${name} 直接访问，但它不在 inject 声明里 —— cordis 会抛 ` +
      '"cannot get property ... without inject"（历史事故：ctx.tokenMeter、ctx.llm）。' +
      '二选一：加进 inject（该服务在所有目标平面都存在时），或改用 ctx.get() 软解析。'
    );
  }
  notes.push(`inject 声明: [${declared0.join(', ')}]；直接访问的 ctx 成员: ${[...accessed].filter((n) => !ALLOWED_CTX_MEMBERS.has(n)).join(', ') || '(无)'}`);
}

// ── 3b. WeakMap 键必须是对象：字符串键会抛 "Invalid value used as weak map key" ──
// 这是本插件最致命的一次事故：routeBySession 用 session.id（字符串）当 WeakMap 键，
// 首次 llm/stream 事件即抛错并毒化整个插件树。
{
  const weakNames = [...code.matchAll(/const\s+(\w+)\s*=\s*new WeakMap\(\)/g)].map((m) => m[1]);
  for (const name of weakNames) {
    const setSites = [...code.matchAll(new RegExp(`${name}\\.set\\(\\s*([^,]+),`, 'g'))];
    for (const site of setSites) {
      const keyExpr = site[1].trim();
      // 允许的键表达式：对象/属性访问形式（含 ?.）。字符串拼接、模板串、字面量一律拦下。
      const looksLikeObject = /^[A-Za-z_$][\w$]*(\??\.[\w$]+)*$/.test(keyExpr) && !/^(true|false|null|undefined|\d+)$/.test(keyExpr);
      // 启发式：以 .id / .name 结尾的属性几乎必然是字符串（routeBySession.set(session.id) 就是那次事故）。
      const looksLikeString = /\.(id|name|key|keyId|sessionId)$/.test(keyExpr);
      if (!looksLikeObject || looksLikeString) {
        problems.push(
          `WeakMap "${name}" 的键表达式可疑: ${keyExpr} —— ` +
          '字符串/原始值作键会抛 "Invalid value used as weak map key"；字符串键请改用 new Map()'
        );
      }
    }
  }
  notes.push(`WeakMap 审计: ${weakNames.length} 个（${weakNames.join(', ') || '无'}）`);
}

// ── 4. 必备导出 ─────────────────────────────────────────────────────────
for (const need of ['export const name', 'export function apply']) {
  if (!source.includes(need)) problems.push(`缺少导出：${need}`);
}

// ── 5. 注册必须走 ctx.effect 包装（WeakMap 事故的防线）──────────────────
if (!/const register = \(label, action\)/.test(source)) {
  problems.push('缺少 register() 包装：裸的 ctx.on / ctx.tools.register / ctx.systemPrompt.section 可能把原始值交给 cordis，触发 "Invalid value used as weak map key"');
}

// ── 5b. bundle 元数据：缺失会让整个 profile 加载失败（比插件崩溃更严重）──
// dsh-app-boot 的硬校验（lib/index.js:851）：
//   const declared = JSON.parse(pkg).dsh?.bundle?.patch
//   if (declared === undefined) throw new Error(`profile bundle "X" declares no dsh.bundle in its package.json`)
// 只要本包名出现在 profile 的 dsh.profile.bundles 里而没这个声明，DSH 就整体起不来。
{
  const pkgPath = join(ROOT, 'package.json');
  try {
    const raw = readFileSync(pkgPath);
    if (raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf) {
      problems.push('package.json 带 UTF-8 BOM —— JSON.parse 与注入器预检都会失败（用 node 写文件，别用 PowerShell Set-Content -Encoding UTF8）');
    }
    const manifest = JSON.parse(raw.toString('utf8'));
    const declaredPatch = manifest.dsh?.bundle?.patch;
    if (typeof declaredPatch !== 'string' || declaredPatch.length === 0) {
      problems.push('package.json 缺少 `dsh.bundle.patch` —— 一旦被列入 profile 的 bundles，DSH 启动会抛 "declares no dsh.bundle" 并整体加载失败');
    } else if (!existsSync(join(ROOT, declaredPatch))) {
      problems.push(`dsh.bundle.patch 指向的文件不存在: ${declaredPatch}`);
    } else {
      notes.push(`bundle patch: ${declaredPatch}`);
    }
    if (manifest.main !== './lib/index.js') {
      problems.push(`main 应为 ./lib/index.js（当前 ${String(manifest.main)}）`);
    }
  } catch (error) {
    problems.push(`package.json 校验失败: ${String(error).slice(0, 120)}`);
  }
}

if (problems.length > 0) {
  console.error('build: 校验失败，未写入 lib：');
  for (const p of problems) console.error(`  ✗ ${p}`);
  process.exit(1);
}

// ── 6. 语法校验：让 node 真的解析一遍产物 ───────────────────────────────
const staging = join(ROOT, '.build-check.mjs');
try {
  writeFileSync(staging, source, 'utf8');
  execFileSync(process.execPath, ['--check', staging], { stdio: ['ignore', 'pipe', 'pipe'] });
  notes.push('语法校验通过（node --check）');
} catch (error) {
  console.error(`build: 语法校验失败：${String(error.stderr ?? error).slice(0, 400)}`);
  process.exit(1);
} finally {
  try { writeFileSync(staging, '', 'utf8'); } catch { /* ignore */ }
  try { (await import('node:fs')).unlinkSync(staging); } catch { /* ignore */ }
}

if (CHECK_ONLY) {
  console.log(`build: --check 通过（${notes.join('；')}）`);
  process.exit(0);
}

mkdirSync(dirname(LIB), { recursive: true });
copyFileSync(SRC, LIB);

// ── 7. 写后验证：lib 必须与 src 逐字节一致 ──────────────────────────────
const written = readFileSync(LIB, 'utf8');
if (written !== source) {
  console.error('build: lib 与 src 不一致（复制后校验失败）');
  process.exit(1);
}

console.log(`build: OK  ${statSync(LIB).size} bytes  src → lib（零依赖，7 项校验全过）`);
for (const note of notes) console.log(`  · ${note}`);
