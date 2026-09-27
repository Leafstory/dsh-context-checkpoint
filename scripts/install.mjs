#!/usr/bin/env node
/**
 * 一键安装：把「上下文检查点 1-2-3-4 全流程」装进一个 DSH 终端。
 *
 * 装四样东西（全部幂等；写之前先备份；可 --dry-run / --check / --uninstall）：
 *   ① 插件包   → <profile>/node_modules/<包名>（copy 复制 / link 软链）
 *   ② 装配声明 → <profile>/package.json 的 dependencies + dsh.profile.bundles
 *   ③ 压缩后端 → <profile>/cordis.patch.yml 里 compaction-basic: disabled false
 *                （dsh-web-app 默认把它 disable 掉；没有 ctx.compaction 就没有第 ③ 步）
 *   ④ 技能     → <DSH_HOME>/skills/context-checkpoint/（SKILL.md + scripts/，第 ② 步的落盘纪律）
 *
 * 用法（在解压出来的目录里直接跑）：
 *   node install.mjs                                   # 自动探测 DSH_HOME 与 profile
 *   node install.mjs --dsh-home "E:/x/.dsh" --profile web
 *   node install.mjs --dry-run                         # 只打印将要做的改动，不落盘
 *   node install.mjs --check                           # 只体检：现在装到哪一步了
 *   node install.mjs --uninstall                       # 反向摘除（保留备份与包文件）
 *
 * 选项：
 *   --from <dir>            插件包目录（默认 = 本脚本的上一级）
 *   --skill <dir>           skill 目录（默认 <安装包>/skill/context-checkpoint，
 *                           再退 <DSH_HOME>/skills/context-checkpoint）
 *   --name <pkg>            包名覆盖（默认读 package.json）
 *   --mode copy|link        放进 node_modules 的方式（默认 copy，装完可删源目录）
 *   --no-skill              不装 skill
 *   --no-compaction-patch   不动 profile 的 cordis.patch.yml
 *   --force                 覆盖 node_modules 里已存在的副本 / 已存在的 skill
 *
 * 退出码：0 = 成功（含 --check 一切就绪）；1 = 失败；2 = 用法错误。
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const selfDir = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
};

const DRY = has('--dry-run');
const CHECK_ONLY = has('--check');
const UNINSTALL = has('--uninstall');
const FORCE = has('--force');
const WITH_SKILL = !has('--no-skill');
const WITH_PATCH = !has('--no-compaction-patch');
const MODE = arg('mode', 'copy');
const SKILL_NAME = 'context-checkpoint';

const steps = [];
const ok = (msg) => steps.push(`  ✓ ${msg}`);
const skip = (msg) => steps.push(`  · ${msg}`);
const warn = (msg) => steps.push(`  ! ${msg}`);
const die = (msg, code = 1) => { console.error(`\n✗ ${msg}\n`); process.exit(code); };
const say = (msg) => console.log(msg);
const ACT = DRY ? '[dry-run] 将' : '已';

if (!['copy', 'link'].includes(MODE)) die(`--mode 只能是 copy 或 link，收到 "${MODE}"`, 2);

// ── 0. 定位安装包（插件）与 skill 源 ────────────────────────────────────────
/**
 * 认亲判据：**必须声明 `dsh.bundle.patch`**。
 * 只用"有没有 package.json"会把上级目录里别人的 package.json 认成插件包
 * （导出包被解压进某个 Node 项目时就会踩到）。
 */
function looksLikePluginDir(dir) {
  const p = join(dir, 'package.json');
  if (!existsSync(p)) return false;
  try { return JSON.parse(readFileSync(p, 'utf8')).dsh?.bundle?.patch !== undefined; } catch { return false; }
}
function findPkgDir() {
  const explicit = arg('from', null);
  if (explicit) return resolve(explicit);
  const cands = [
    resolve(selfDir, '..'),            // 包内：<pkg>/scripts/install.mjs
    join(selfDir, 'plugin'),           // 导出包：<dist>/install.mjs + <dist>/plugin/
    selfDir,
    join(resolve(selfDir, '..'), 'plugin'),
  ];
  return cands.find(looksLikePluginDir) ?? resolve(selfDir, '..');
}
const pkgDir = findPkgDir();
const pkgJsonPath = join(pkgDir, 'package.json');
if (!existsSync(pkgJsonPath)) die(`插件包目录里没有 package.json：${pkgDir}\n  用 --from <插件包目录> 指定。`);
let pkg;
try { pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8')); } catch (e) { die(`package.json 解析失败：${e.message}`); }
const PKG_NAME = arg('name', pkg.name);
const PKG_VERSION = pkg.version ?? '0.0.0';
if (!PKG_NAME) die('package.json 里没有 name，且未给 --name');

/** bundle 装配的硬前提：缺 dsh.bundle.patch 声明会让 DSH **整体启动失败**，所以先挡住。 */
const bundlePatchDecl = pkg.dsh?.bundle?.patch;
if (bundlePatchDecl === undefined) {
  die(`插件包的 package.json 缺少 dsh.bundle.patch 声明 —— 把它加进 bundles 会让 DSH 启动直接失败（dsh-app-boot 会校验）。拒绝继续。`);
}
const bundlePatchFile = resolve(pkgDir, bundlePatchDecl);
if (!existsSync(bundlePatchFile)) die(`dsh.bundle.patch 指向的文件不存在：${bundlePatchFile}`);
const libFile = resolve(pkgDir, pkg.main ?? './lib/index.js');
if (!existsSync(libFile)) die(`入口文件不存在：${libFile}（先跑 node scripts/build.mjs）`);

function findSkillDir() {
  const explicit = arg('skill', null);
  if (explicit) return resolve(explicit);
  const candidates = [
    resolve(pkgDir, 'skill', SKILL_NAME),        // 导出包布局：<包根>/skill/context-checkpoint
    resolve(selfDir, '..', 'skill', SKILL_NAME),
    resolve(pkgDir, '..', 'skill', SKILL_NAME),
  ];
  // 目标机上已经装过时，本机现有 skill 也可当源（升级/重装）
  if (DSH_HOME) candidates.push(join(DSH_HOME, 'skills', SKILL_NAME));
  return candidates.find((c) => existsSync(join(c, 'SKILL.md'))) ?? null;
}

// ── 1. 定位 DSH_HOME 与 profile ─────────────────────────────────────────────
function findDshHome() {
  const explicit = arg('dsh-home', null);
  if (explicit) return resolve(explicit);
  if (process.env.DSH_HOME) return resolve(process.env.DSH_HOME);
  // 从安装包位置往上找 .dsh（把导出包解压到 DSH 根旁边时最常见的布局）
  let cur = pkgDir;
  for (let i = 0; i < 5; i += 1) {
    const cand = join(cur, '.dsh');
    if (existsSync(join(cand, 'profiles'))) return cand;
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  const home = join(homedir(), '.dsh');
  if (existsSync(join(home, 'profiles'))) return home;
  return null;
}

const DSH_HOME = findDshHome();
if (DSH_HOME === null) {
  die('找不到 DSH_HOME。按顺序试过：--dsh-home → $env:DSH_HOME → 安装包上层的 .dsh → ~/.dsh\n'
    + '  请显式指定，例如：node install.mjs --dsh-home "C:/Users/you/.dsh" --profile web');
}
if (!existsSync(join(DSH_HOME, 'profiles'))) die(`${DSH_HOME} 下没有 profiles/ —— 这不像 DSH_HOME`);

const profilesRoot = join(DSH_HOME, 'profiles');
const available = readdirSync(profilesRoot, { withFileTypes: true })
  .filter((e) => e.isDirectory() && e.name !== 'node_modules' && !e.name.startsWith('.'))
  .map((e) => e.name);
if (!available.length) die(`${profilesRoot} 下没有任何 profile`);
let profile = arg('profile', null);
if (profile === null) {
  if (available.length === 1) profile = available[0];
  else die(`有多个 profile，必须显式指定：${available.join(', ')}\n  例如：node install.mjs --dsh-home "${DSH_HOME}" --profile ${available.includes('web') ? 'web' : available[0]}`);
}
if (!available.includes(profile)) die(`没有名为 "${profile}" 的 profile；现有的：${available.join(', ')}`);

const profileDir = join(profilesRoot, profile);
const profileJsonPath = join(profileDir, 'package.json');
const profilePatchPath = join(profileDir, 'cordis.patch.yml');
const targetPkgDir = join(profileDir, 'node_modules', PKG_NAME);
const skillsRoot = join(DSH_HOME, 'skills');
const targetSkillDir = join(skillsRoot, SKILL_NAME);
const skillSrc = WITH_SKILL ? findSkillDir() : null;
if (WITH_SKILL && skillSrc === null) {
  warn('没找到 skill 源目录（--skill 未给，且 <包根>/skill/context-checkpoint 不存在）—— 将只装插件');
}

say(`\n=== 上下文检查点 1-2-3-4 · 安装器 ${DRY ? '（dry-run，不落盘）' : ''} ===`);
say(`  插件包   ${PKG_NAME}@${PKG_VERSION}`);
say(`  包目录   ${pkgDir}`);
say(`  DSH_HOME ${DSH_HOME}`);
say(`  profile  ${profile}   (${profileDir})`);
if (skillSrc) say(`  skill    ${skillSrc}`);
say(`  模式     ${MODE}${CHECK_ONLY ? ' · 仅体检' : ''}${UNINSTALL ? ' · 卸载' : ''}\n`);

// ── 工具 ───────────────────────────────────────────────────────────────────
function backupOnce(file) {
  if (!existsSync(file)) return null;
  const bak = `${file}.context-checkpoint.bak`;
  if (existsSync(bak)) return bak;                 // 保留最初的原始副本，不覆盖
  if (DRY) return bak;
  cpSync(file, bak);
  return bak;
}
function readJson(file, label) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch (e) { die(`${label} 解析失败（${file}）：${e.message}`); }
}
function sha256(file) { return createHash('sha256').update(readFileSync(file)).digest('hex'); }
function nodeCheck(file) {
  const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  return r.status === 0 ? null : (r.stderr || '').split('\n').slice(0, 3).join(' ').trim();
}

/**
 * 读 patch 里 compaction-basic 的状态（纯文本扫描，零依赖）。
 * ⚠️ 别用 `(?=...|\Z)` 之类的 PCRE 写法：JS 正则里 `\Z` 会被当成字面量 Z，
 * 结果是判据静默失效（本安装器第一次跑就这么误报过"未启用"）。
 */
function compactionState(lines) {
  const i = lines.findIndex((l) => /^\s*-\s*id:\s*compaction-basic\s*$/.test(l));
  if (i === -1) return { state: 'missing', line: -1 };
  for (let j = i + 1; j < Math.min(i + 8, lines.length); j += 1) {
    if (/^\s*-\s*id:/.test(lines[j])) break;
    if (/^\s*disabled:/.test(lines[j])) {
      return { state: /disabled:\s*false/.test(lines[j]) ? 'enabled' : 'disabled', line: j };
    }
  }
  return { state: 'no-flag', line: i };   // 条目在但没写 disabled ⇒ 沿用原值（web 平面原值是 true）
}

// ── 2. 插件包落位 ───────────────────────────────────────────────────────────
function installPackage() {
  say('【1/4】插件包落位');
  const alreadyThere = existsSync(join(targetPkgDir, 'package.json'));
  if (UNINSTALL) {
    if (!existsSync(targetPkgDir)) { skip(`${targetPkgDir} 本就不存在`); return; }
    if (DRY) { skip(`将删除 ${targetPkgDir}`); return; }
    rmSync(targetPkgDir, { recursive: true, force: true });
    ok(`删除 ${targetPkgDir}`);
    return;
  }
  if (alreadyThere && !FORCE) {
    const same = sha256(join(targetPkgDir, 'lib', 'index.js')) === sha256(libFile);
    skip(`已在位：${targetPkgDir}（lib 与源${same ? '一致' : '**不一致**'}；--force 可覆盖）`);
    if (!same) warn('目标里的 lib 与源不一致 —— 可能是旧版本，用 --force 重装');
    return;
  }
  if (alreadyThere && FORCE) {
    if (!DRY) rmSync(targetPkgDir, { recursive: true, force: true });
    skip(`--force：先移除旧副本`);
  }
  if (DRY) { skip(`将把 ${pkgDir} ${MODE === 'copy' ? '复制' : '软链'}到 ${targetPkgDir}`); return; }
  mkdirSync(dirname(targetPkgDir), { recursive: true });
  if (MODE === 'copy') {
    cpSync(pkgDir, targetPkgDir, { recursive: true, filter: (src) => basename(src) !== 'node_modules' });
    ok(`复制到 ${targetPkgDir}`);
  } else {
    symlinkSync(pkgDir, targetPkgDir, process.platform === 'win32' ? 'junction' : 'dir');
    ok(`软链到 ${targetPkgDir} → ${pkgDir}`);
  }
}

// ── 3. profile 装配声明（dependencies + bundles） ───────────────────────────
function installProfileJson() {
  say('\n【2/4】profile 装配声明');
  if (!existsSync(profileJsonPath)) {
    if (UNINSTALL) { skip('profile package.json 不存在'); return; }
    if (DRY) { skip(`将新建 ${profileJsonPath}`); return; }
    writeFileSync(profileJsonPath, `${JSON.stringify({ name: `dsh-profile-${profile}`, private: true, dependencies: {}, dsh: { profile: { bundles: [] } } }, null, 2)}\n`, 'utf8');
    ok(`新建 ${profileJsonPath}`);
  }
  const json = readJson(profileJsonPath, 'profile package.json');
  json.dependencies ??= {};
  json.dsh ??= {};
  json.dsh.profile ??= {};
  json.dsh.profile.bundles ??= [];
  const inDeps = Object.prototype.hasOwnProperty.call(json.dependencies, PKG_NAME);
  const inBundles = json.dsh.profile.bundles.includes(PKG_NAME);

  if (UNINSTALL) {
    let touched = false;
    if (inDeps) { delete json.dependencies[PKG_NAME]; touched = true; ok(`dependencies 移除 ${PKG_NAME}`); } else skip('dependencies 里没有它');
    if (inBundles) { json.dsh.profile.bundles = json.dsh.profile.bundles.filter((n) => n !== PKG_NAME); touched = true; ok(`bundles 移除 ${PKG_NAME}`); } else skip('bundles 里没有它');
    if (touched && !DRY) { backupOnce(profileJsonPath); writeFileSync(profileJsonPath, `${JSON.stringify(json, null, 2)}\n`, 'utf8'); }
    return;
  }

  // 依赖写法对齐本机既有风格：copy → file:<安装包路径或源目录>；link → link:<源目录>
  const tgz = arg('tgz', null);
  const value = MODE === 'link'
    ? `link:${pkgDir}`
    : (tgz ? `file:${resolve(tgz)}` : `file:${pkgDir}`);
  if (json.dependencies[PKG_NAME] !== value) {
    if (DRY) skip(`将写 dependencies["${PKG_NAME}"] = "${value}"`);
    else { json.dependencies[PKG_NAME] = value; ok(`dependencies["${PKG_NAME}"] = "${value}"`); }
  } else skip(`dependencies 已是 "${value}"`);
  if (!inBundles) {
    if (DRY) skip(`将把 "${PKG_NAME}" 追加进 dsh.profile.bundles`);
    else { json.dsh.profile.bundles.push(PKG_NAME); ok(`dsh.profile.bundles += "${PKG_NAME}"`); }
  } else skip('bundles 里已在');

  if (!DRY) {
    backupOnce(profileJsonPath);
    writeFileSync(profileJsonPath, `${JSON.stringify(json, null, 2)}\n`, 'utf8');
  }
}

// ── 4. 压缩后端（profile cordis.patch.yml） ──────────────────────────────────
/** 纯文本处理（零依赖，不引 YAML 库）：找 `- id: compaction-basic` 条目，把 disabled 置 false；没有就追加。 */
function patchCompactionBackend() {
  say('\n【3/4】压缩后端 compaction-basic');
  if (!WITH_PATCH) { skip('--no-compaction-patch：已跳过'); return; }
  const existed = existsSync(profilePatchPath);
  let text = existed ? readFileSync(profilePatchPath, 'utf8') : '';
  let lines = text.length ? text.split('\n') : [];

  // 顺手清掉阻断自己的条目（dev_uninject_plugin 会写 `- id: context-checkpoint / disabled: true`）
  let blocked = false;
  for (let i = 0; i < lines.length; i += 1) {
    if (!/^\s*-\s*id:\s*context-checkpoint\s*$/.test(lines[i])) continue;
    for (let j = i + 1; j < Math.min(i + 6, lines.length); j += 1) {
      if (/^\s*-\s*id:/.test(lines[j])) break;
      if (/^\s*disabled:\s*true\s*$/.test(lines[j])) {
        blocked = true;
        if (UNINSTALL) break;
        if (DRY) { skip(`将注释掉阻断条目（第 ${i + 1}-${j + 1} 行）`); }
        else {
          lines[i] = `# ${lines[i]}   # 本安装器注释：该条目会屏蔽 bundle 装配`;
          lines[j] = `# ${lines[j]}`;
          ok('注释掉会屏蔽本插件的 disabled 条目（改用 bundle 装配）');
        }
      }
    }
  }
  const entryLine = lines.findIndex((l) => /^\s*-\s*id:\s*compaction-basic\s*$/.test(l));
  if (entryLine === -1) {
    if (DRY) skip('将追加 compaction-basic: disabled false 条目');
    else {
      const block = [
        '',
        '# ── 上下文检查点插件依赖的压缩后端 ──────────────────────────────',
        '# dsh-web-app 默认把 compaction-basic 设为 disabled: true；插件的第 ③ 步',
        '# （自动压缩）需要 ctx.compaction，服务缺失时只能测占用、压不了。',
        '# 回退：删掉本条目或改回 disabled: true，然后重启。',
        '- id: compaction-basic',
        '  disabled: false',
        '',
      ];
      lines = lines.concat(block);
      ok('追加 compaction-basic（disabled: false）');
    }
  } else {
    let found = false;
    for (let j = entryLine + 1; j < Math.min(entryLine + 8, lines.length); j += 1) {
      if (/^\s*-\s*id:/.test(lines[j])) break;
      if (/^\s*disabled:/.test(lines[j])) {
        found = true;
        if (/^\s*disabled:\s*false\s*$/.test(lines[j])) skip('compaction-basic 已启用');
        else if (DRY) skip(`将把第 ${j + 1} 行改为 disabled: false`);
        else { lines[j] = lines[j].replace(/disabled:\s*true/, 'disabled: false'); ok('compaction-basic 改为 disabled: false'); }
        break;
      }
    }
    if (!found) {
      if (DRY) skip('将在 compaction-basic 条目下补 disabled: false');
      else { lines.splice(entryLine + 1, 0, '  disabled: false'); ok('compaction-basic 补上 disabled: false'); }
    }
  }

  if (!existed && UNINSTALL) { skip('profile patch 不存在'); return; }
  if (UNINSTALL) { skip('卸载不动 profile patch（如需回退，见备份文件）'); return; }
  if (!DRY) {
    backupOnce(profilePatchPath);
    mkdirSync(dirname(profilePatchPath), { recursive: true });
    writeFileSync(profilePatchPath, `${lines.join('\n').replace(/\n+$/, '')}\n`, 'utf8');
  }
  if (blocked) warn('注意：原先存在屏蔽本插件的条目，已注释掉');
}

// ── 5. skill 落位 ───────────────────────────────────────────────────────────
function installSkill() {
  say('\n【4/4】技能 context-checkpoint');
  if (!WITH_SKILL || skillSrc === null) { skip('未提供 skill 源目录，跳过'); return; }
  if (UNINSTALL) {
    if (!existsSync(targetSkillDir)) { skip(`${targetSkillDir} 本就不存在`); return; }
    if (DRY) { skip(`将删除 ${targetSkillDir}`); return; }
    rmSync(targetSkillDir, { recursive: true, force: true });
    ok(`删除 ${targetSkillDir}`);
    return;
  }
  if (existsSync(targetSkillDir) && !FORCE) {
    const sameSkill = sha256(join(targetSkillDir, 'SKILL.md')) === sha256(join(skillSrc, 'SKILL.md'));
    if (!sameSkill) warn('目标 skill 与源不同 —— 可能是旧版本，用 --force 覆盖（会先备份）');
    else skip('已存在且 SKILL.md 一致');
    if (!sameSkill) {
      if (DRY) skip('将备份旧 skill 后覆盖');
      else {
        const bak = `${targetSkillDir}.bak-${Date.now()}`;
        renameSync(targetSkillDir, bak);
        cpSync(skillSrc, targetSkillDir, { recursive: true });
        ok(`旧 skill 备份到 ${basename(bak)}，并装入新版`);
      }
    }
    return;
  }
  if (DRY) { skip(`将复制 ${skillSrc} → ${targetSkillDir}`); return; }
  mkdirSync(skillsRoot, { recursive: true });
  cpSync(skillSrc, targetSkillDir, { recursive: true });
  ok(`复制到 ${targetSkillDir}`);
}

// ── 6. 校验 ─────────────────────────────────────────────────────────────────
async function verify() {
  say('\n=== 校验 ===');
  let bad = 0;

  // 插件包自身
  const libInTarget = join(targetPkgDir, 'lib', 'index.js');
  if (existsSync(libInTarget)) {
    const same = sha256(libInTarget) === sha256(libFile);
    same ? ok('node_modules 里的 lib 与源逐字节一致') : (warn('node_modules 里的 lib 与源不一致'), bad += 1);
    const srcInTarget = join(targetPkgDir, 'src', 'index.js');
    if (existsSync(srcInTarget) && sha256(srcInTarget) !== sha256(libInTarget)) { warn('包内 src ≠ lib（说明没 build）'); bad += 1; }
    const imports = [...readFileSync(libInTarget, 'utf8').matchAll(/^\s*import[^'"]*['"]([^'"]+)['"]/gm)].map((m) => m[1]);
    const external = imports.filter((s) => !s.startsWith('node:'));
    external.length === 0
      ? ok(`零外部依赖（只 import ${[...new Set(imports)].join(', ')}）`)
      : (warn(`发现外部 import：${external.join(', ')}（junction/realpath 解析会挂）`), bad += 1);
    try {
      const mod = await import(pathToFileURL(libInTarget).href);
      const shape = typeof mod.apply === 'function' && Array.isArray(mod.inject) && typeof mod.name === 'string';
      shape ? ok(`模块可加载：name=${mod.name} inject=[${mod.inject}] apply() ✓`) : (warn('模块加载了但导出形状不对'), bad += 1);
    } catch (e) { warn(`模块加载失败：${e.message}`); bad += 1; }
  } else { warn(`插件未落位：${libInTarget}`); bad += 1; }

  // 装配声明
  if (existsSync(profileJsonPath)) {
    const j = readJson(profileJsonPath, 'profile package.json');
    const inDeps = Boolean(j.dependencies?.[PKG_NAME]);
    const inBundles = (j.dsh?.profile?.bundles ?? []).includes(PKG_NAME);
    inDeps ? ok('dependencies 已声明') : (warn('dependencies 缺声明'), bad += 1);
    inBundles ? ok('dsh.profile.bundles 已包含') : (warn('bundles 缺条目 → 重启后不会装配'), bad += 1);
  } else { warn('profile package.json 不存在'); bad += 1; }

  // 压缩后端
  if (WITH_PATCH && existsSync(profilePatchPath)) {
    const st = compactionState(readFileSync(profilePatchPath, 'utf8').split('\n'));
    if (st.state === 'enabled') ok('compaction-basic 已启用（ctx.compaction 可用 → 第 ③ 步能压）');
    else if (st.state === 'missing') { warn('profile patch 里没有 compaction-basic 条目 → 第 ③ 步压不了'); bad += 1; }
    else { warn(`compaction-basic 是 ${st.state}（第 ${st.line + 1} 行）→ 只能测占用、压不了`); bad += 1; }
  } else if (WITH_PATCH) warn('profile cordis.patch.yml 不存在');

  // skill
  if (WITH_SKILL && skillSrc !== null) {
    const skillMd = join(targetSkillDir, 'SKILL.md');
    if (existsSync(skillMd)) {
      const head = readFileSync(skillMd, 'utf8').slice(0, 400);
      /name:\s*context-checkpoint/.test(head) ? ok('skill 已落位（frontmatter.name 正确）') : (warn('skill 落了但 frontmatter 不对'), bad += 1);
      const scripts = ['checkpoint.mjs', 'test-checkpoint.mjs', 'test-skill-template.mjs'];
      for (const s of scripts) {
        const f = join(targetSkillDir, 'scripts', s);
        if (!existsSync(f)) { warn(`skill 缺脚本 ${s}`); bad += 1; continue; }
        const err = nodeCheck(f);
        err ? (warn(`skill 脚本语法错误 ${s}: ${err}`), bad += 1) : ok(`skill 脚本语法通过 ${s}`);
      }
    } else { warn(`skill 未落位：${skillMd}`); bad += 1; }
  }
  return bad;
}

// ── 主流程 ─────────────────────────────────────────────────────────────────
if (CHECK_ONLY) {
  say('（--check：只读体检，不写任何文件）\n');
  const bad = await verify();
  say('');
  for (const s of steps) say(s);
  say(bad === 0 ? '\n体检通过：四件都就位。\n' : `\n体检发现 ${bad} 处问题（见上面 ! 行）。\n`);
  process.exit(bad === 0 ? 0 : 1);
}

installPackage();
installProfileJson();
patchCompactionBackend();
installSkill();

say('\n=== 本次动作 ===');
for (const s of steps) say(s);

// 卸载模式不跑"装好了吗"的校验 —— 刚摘完东西，校验当然会报缺（这条曾经让卸载假失败退出 1）
if (!DRY && !UNINSTALL) {
  const bad = await verify();
  say('');
  if (bad > 0) {
    say(`✗ 校验发现 ${bad} 处问题 —— 按上面 ! 行修掉再重启。`);
    process.exit(1);
  }
  say('✓ 校验全部通过。');
}

if (UNINSTALL) {
  say('\n卸载完成。备份文件（*.context-checkpoint.bak）与插件包目录都保留着，需要彻底清理请手动删。\n');
  process.exit(0);
}

say(`
=== 下一步（装完必做）===
1. **重启 DSH** —— 注入器/装配都只在启动时组合；改完不重启 = 没生效。
2. 重启后确认插件在跑（这 4 个字段旧版没有）：
     调用 context_status → 应看到 checkpointFresh / checkpointAgeMs /
     userIntentWindowMs: 900000 / recentUserIntent
3. 确认第 ③ 步能压（compaction-basic 已启用）：
     context_status.capabilityProbe["compaction.compactIfNeeded"] === "present"
4. 自然路径验收：在占用远低于 50% 时直接说「总结一下本轮」，
   应看到 Compaction scheduled (on the user's explicit request: "…")，**不需要任何 force**。
5. skill 验收：让模型 skill context-checkpoint，或看 <DSH_HOME>/skills/context-checkpoint/SKILL.md。

⚠️ 若目标终端是 DSH Desktop：它启动时会重写 profile 的 package.json，
   bundles 条目可能被抹掉（本机实测过）。重启后跑一次
   \`node install.mjs --check\` 自查；若条目没了，改用 dev_inject_plugin 或再跑一次本安装器。
⚠️ 别两条路同时用（注入器 + bundle 装配 = 同一个插件装配两次）：
   装过注入器的先 dev_uninject_plugin 再跑本安装器。
`);
