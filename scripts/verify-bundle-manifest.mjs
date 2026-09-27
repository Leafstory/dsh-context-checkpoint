#!/usr/bin/env node
/**
 * 复算 dsh-app-boot 的 bundle 校验（只读，不改任何东西）。
 *
 * 对应源码逻辑（lib/index.js:845-852）：
 *   const bundles = manifest.dsh?.profile?.bundles ?? []
 *   for (const packageName of bundles) {
 *     const packageDir = <resolve from profile node_modules>
 *     const declared = JSON.parse(readFileSync(join(packageDir,'package.json'))).dsh?.bundle?.patch
 *     if (declared === undefined) throw new Error(`profile bundle "X" declares no dsh.bundle`)
 *   }
 *
 * 用法: node scripts/verify-bundle-manifest.mjs [profileDir]
 * 退出码: 0 = 全部 bundles 合法; 1 = 有非法项（DSH 启动会失败）
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { resolveDesktopAppModules, resolveProfileDir, resolveSelfProject } from './paths.mjs';

const profileDir = resolve(process.argv[2] ?? resolveProfileDir());
const pkgPath = join(profileDir, 'package.json');
const manifest = JSON.parse(readFileSync(pkgPath, 'utf8'));
const bundles = manifest.dsh?.profile?.bundles ?? [];

// 解析顺序与 Node 一致：profile/node_modules → profiles/node_modules → 应用自带 node_modules
const searchRoots = [
  join(profileDir, 'node_modules'),
  join(profileDir, '..', 'node_modules'),
  resolveDesktopAppModules()
];

function resolvePackageDir(packageName) {
  for (const root of searchRoots) {
    const dir = join(root, packageName);
    if (existsSync(join(dir, 'package.json'))) return dir;
  }
  return undefined;
}

let failures = 0;
console.log(`profile: ${profileDir}`);
console.log(`bundles: ${bundles.length} 个\n`);

for (const packageName of bundles) {
  const dir = resolvePackageDir(packageName);
  if (dir === undefined) {
    console.log(`  ✗ ${packageName}\n      未在任何 node_modules 根下解析到（DSH 启动会失败）`);
    failures += 1;
    continue;
  }
  let declared;
  try {
    declared = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).dsh?.bundle?.patch;
  } catch (error) {
    console.log(`  ✗ ${packageName}\n      package.json 无法解析: ${String(error).slice(0, 100)}`);
    failures += 1;
    continue;
  }
  if (declared === undefined) {
    console.log(`  ✗ ${packageName}\n      declares no dsh.bundle —— DSH 启动会抛错并整体加载失败`);
    failures += 1;
    continue;
  }
  const patchFile = join(dir, declared);
  if (!existsSync(patchFile)) {
    console.log(`  ✗ ${packageName}\n      dsh.bundle.patch 指向的文件不存在: ${declared}`);
    failures += 1;
    continue;
  }
  console.log(`  ✓ ${packageName}  →  ${declared}`);
}

// 额外：本插件自身的声明检查（无论是否已在 bundles 里）
const selfDir = resolve(resolveSelfProject());
const selfName = JSON.parse(readFileSync(join(selfDir, 'package.json'), 'utf8')).name;
const selfDeclared = JSON.parse(readFileSync(join(selfDir, 'package.json'), 'utf8')).dsh?.bundle?.patch;
const inBundles = bundles.includes(selfName);
console.log(`\n本插件 ${selfName}:`);
console.log(`  dsh.bundle.patch = ${selfDeclared ?? '(缺失)'}`);
console.log(`  在 profile.bundles 中: ${inBundles}`);
if (inBundles && (selfDeclared === undefined || !existsSync(join(selfDir, selfDeclared)))) {
  console.log('  ✗ 在 bundles 中但声明不合法 —— 这会让 DSH 启动失败');
  failures += 1;
} else if (inBundles) {
  console.log('  ✓ 声明合法，满足加载器校验');
} else {
  console.log('  · 尚未列入 bundles（声明已就绪，可安全列入）');
}

// 前置断言：profile patch 里若有**活跃的** context-checkpoint disabled 条目，
// 会把 bundle 装配出来的插件直接屏蔽掉（历史上踩过一次）。
const profilePatch = join(profileDir, 'cordis.patch.yml');
if (existsSync(profilePatch)) {
  const lines = readFileSync(profilePatch, 'utf8').split(/\r?\n/);
  const activeDisabled = lines.some((line, i) => (
    /^\s*-\s*id:\s*context-checkpoint\s*$/.test(line)
    && /^\s*disabled:\s*true\s*$/.test(lines[i + 1] ?? '')
  ));
  if (activeDisabled) {
    console.log('\n  ✗ profile patch 里存在活跃的 `- id: context-checkpoint / disabled: true`');
    console.log('     它会在重启后屏蔽 bundle 装配的插件（注释掉它）');
    failures += 1;
  } else {
    console.log('\n  ✓ profile patch 无活跃的 context-checkpoint disabled 条目');
  }
}

console.log(failures === 0 ? '\n结论：当前 bundles 列表全部合法。' : `\n结论：${failures} 项非法 —— DSH 启动会失败。`);
process.exitCode = failures === 0 ? 0 : 1;
