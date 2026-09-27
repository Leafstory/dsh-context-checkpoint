#!/usr/bin/env node
/**
 * Desktop 侧装配的完整只读预检。
 *
 * 复刻两条独立的解析链（它们是不同的代码路径，之前只查了一条就误判过）：
 *   A. dsh-app-boot 的 bundle 校验        → createRequire(anchor).resolve.paths
 *   B. Desktop 的 overlay 解析            → findPackageJSON(name, packageUrl)
 *      并在两侧都有时按 semver 取较高版本（package-overlay:74）
 *
 * 任一条不通过，DSH 启动就会失败或退回 recovery 模式（表现为插件不生效）。
 *
 * 用法: node scripts/preflight-desktop-assembly.mjs
 */
import { existsSync, readFileSync } from 'node:fs';
import { createRequire, findPackageJSON } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveDesktopApp, resolveProfileDir } from './paths.mjs';

const APP = resolveDesktopApp();
const INSTALL_ANCHOR = `${APP}/package.json`;

// 借用应用自带的 semver，保证版本比较规则与 Desktop 完全一致（本插件自身保持零依赖）。
const appRequire = createRequire(INSTALL_ANCHOR);
const { compare, valid } = appRequire('semver');
const PROFILE_DIR = resolveProfileDir();
const SELF = '@dsh-external/context-checkpoint';

const problems = [];
const notes = [];

const profileManifest = JSON.parse(readFileSync(join(PROFILE_DIR, 'package.json'), 'utf8'));
const bundles = profileManifest.dsh?.profile?.bundles ?? [];

// ── A. dsh-app-boot 的 bundle 校验 ──────────────────────────────────────
function packageDirFromAnchor(anchor, packageName) {
  const paths = createRequire(anchor).resolve.paths(packageName) ?? [];
  for (const searchPath of paths) {
    const candidate = join(searchPath, packageName);
    if (existsSync(join(candidate, 'package.json'))) return candidate;
  }
  return undefined;
}
for (const name of bundles) {
  let dir;
  for (const anchor of [INSTALL_ANCHOR, join(PROFILE_DIR, 'package.json')]) {
    dir = packageDirFromAnchor(anchor, name);
    if (dir !== undefined) break;
  }
  if (dir === undefined) { problems.push(`A: bundle 无法解析: ${name}`); continue; }
  let declared;
  try { declared = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).dsh?.bundle?.patch; }
  catch (error) { problems.push(`A: ${name} 的 package.json 读取失败: ${String(error).slice(0, 80)}`); continue; }
  if (typeof declared !== 'string' || declared.length === 0) {
    problems.push(`A: ${name} declares no dsh.bundle（读到 ${dir}）`);
    continue;
  }
  if (!existsSync(join(dir, declared))) { problems.push(`A: ${name} 的 patch 缺失: ${declared}`); continue; }
}
notes.push(`A. dsh-app-boot bundle 校验: ${bundles.length} 项全部通过`);

// ── B. Desktop overlay 解析（针对本插件）────────────────────────────────
function readCandidate(source, url) {
  let manifestPath;
  try { manifestPath = findPackageJSON(SELF, url); }
  catch (cause) {
    if (cause?.code === 'ERR_MODULE_NOT_FOUND') return undefined;
    throw cause;
  }
  if (manifestPath === undefined) return undefined;
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (manifest.name !== SELF) throw new Error(`${source} package identity invalid`);
  const v = typeof manifest.version === 'string' && valid(manifest.version) !== null ? manifest.version : undefined;
  return { manifestPath, dir: join(manifestPath, '..'), manifest, version: v };
}
const install = readCandidate('install', pathToFileURL(INSTALL_ANCHOR).href);
const profile = readCandidate('profile', pathToFileURL(join(PROFILE_DIR, 'package.json')).href);
if (install === undefined && profile === undefined) {
  problems.push('B: overlay 两侧都解析不到本插件');
} else {
  const selected = install === undefined ? profile
    : profile === undefined ? install
      : profile.version !== undefined && install.version !== undefined && compare(profile.version, install.version) > 0 ? profile : install;
  const declared = selected.manifest.dsh?.bundle?.patch;
  notes.push(`B. overlay 选中: ${selected.manifestPath} (v${selected.version ?? '?'})`);
  if (typeof declared !== 'string' || declared.length === 0) {
    problems.push(`B: overlay 选中的 manifest 没有 dsh.bundle.patch（${selected.manifestPath}）`);
  } else {
    const patchPath = join(selected.dir, declared);
    if (!existsSync(patchPath)) problems.push(`B: overlay patch 缺失: ${patchPath}`);
    else notes.push(`B. overlay patch 可达: ${declared}`);
  }
}

// ── C. profile 依赖声明 ─────────────────────────────────────────────────
const dep = profileManifest.dependencies?.[SELF];
if (dep === undefined) problems.push('C: profile dependencies 里没有声明本插件');
else notes.push(`C. profile dependency: ${SELF} = ${dep}`);

// ── D. junction 与 patch 层里的 disabled 条目 ───────────────────────────
const junction = join(PROFILE_DIR, 'node_modules', '@dsh-external', 'context-checkpoint');
if (!existsSync(join(junction, 'package.json'))) problems.push(`D: junction 不可用: ${junction}`);
else notes.push('D. junction 可用且可读');

const profilePatch = join(PROFILE_DIR, 'cordis.patch.yml');
if (existsSync(profilePatch)) {
  const lines = readFileSync(profilePatch, 'utf8').split(/\r?\n/);
  let active = 0;
  for (let i = 0; i < lines.length; i += 1) {
    if (/^\s*-\s*id:\s*context-checkpoint\s*$/.test(lines[i]) && /^\s*disabled:\s*true\s*$/.test(lines[i + 1] ?? '')) active += 1;
  }
  if (active > 0) problems.push(`D: profile patch 里有 ${active} 条活跃的 context-checkpoint disabled —— 会屏蔽插件`);
  else notes.push('D. profile patch 无屏蔽条目');
}

for (const n of notes) console.log(`  · ${n}`);
if (problems.length > 0) {
  console.error('\n预检失败（当前磁盘状态启动会失败或退回 recovery）：');
  for (const p of problems) console.error(`  ✗ ${p}`);
  process.exit(1);
}
console.log('\n结论：两条解析链 + 依赖 + junction + patch 全部通过 —— 当前磁盘状态可以干净启动。');
