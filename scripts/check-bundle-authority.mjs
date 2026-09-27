#!/usr/bin/env node
/**
 * 权威装配检查器：**逐字复算 dsh-app-boot 的 bundle 校验**。
 *
 * 对应源码（dsh-app-boot/lib/index.js）：
 *   826  resolveBundleDir(binName, packageName, installAnchor, profileDir)
 *   827    for (const anchor of [installAnchor, join(profileDir,'package.json')])
 *   828      const dir = packageDirFromAnchor(anchor, packageName)
 *   807  packageDirFromAnchor: createRequire(anchor).resolve.paths(packageName)
 *                               → join(searchPath, packageName) / existsSync(package.json)
 *   851  declared = JSON.parse(readFileSync(join(packageDir,'package.json'))).dsh?.bundle?.patch
 *   852  if (declared === undefined) throw `... declares no dsh.bundle ...`
 *
 * 这里用 createRequire 复刻同一条解析链，而不是自己拼 node_modules 路径 ——
 * 手写的顺序容易与实际解析不一致（上一版脚本就是这么漏判的）。
 *
 * 用法: node scripts/check-bundle-authority.mjs [profileDir] [installAnchor]
 */
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { resolveDesktopAppFile, resolveProfileDir } from './paths.mjs';

const profileDir = process.argv[2] ?? resolveProfileDir();
const installAnchor = process.argv[3]
  ?? resolveDesktopAppFile('package.json');

const manifestPath = join(profileDir, 'package.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const bundles = manifest.dsh?.profile?.bundles ?? [];

/** 复刻 packageDirFromAnchor。 */
function packageDirFromAnchor(anchor, packageName) {
  const paths = createRequire(anchor).resolve.paths(packageName) ?? [];
  for (const searchPath of paths) {
    const candidate = join(searchPath, packageName);
    if (existsSync(join(candidate, 'package.json'))) return candidate;
  }
  return undefined;
}

/** 复刻 resolveBundleDir：安装锚点优先，再 profile 目录。 */
function resolveBundleDir(packageName) {
  for (const anchor of [installAnchor, join(profileDir, 'package.json')]) {
    const dir = packageDirFromAnchor(anchor, packageName);
    if (dir !== undefined) return dir;
  }
  return undefined;
}

console.log(`profile      : ${profileDir}`);
console.log(`installAnchor: ${installAnchor}`);
console.log(`bundles      : ${bundles.length} 项\n`);

let failures = 0;
for (const packageName of bundles) {
  const dir = resolveBundleDir(packageName);
  if (dir === undefined) {
    console.log(`  ✗ ${packageName}\n      cannot resolve profile bundle（DSH 启动会抛错）`);
    failures += 1;
    continue;
  }
  let declared;
  try {
    declared = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).dsh?.bundle?.patch;
  } catch (error) {
    console.log(`  ✗ ${packageName}\n      package.json 解析失败: ${String(error).slice(0, 90)}`);
    failures += 1;
    continue;
  }
  if (declared === undefined) {
    console.log(`  ✗ ${packageName}\n      declares no dsh.bundle（读到的是 ${dir}）`);
    failures += 1;
    continue;
  }
  const patchFile = join(dir, declared);
  if (!existsSync(patchFile)) {
    console.log(`  ✗ ${packageName}\n      patch 文件缺失: ${patchFile}`);
    failures += 1;
    continue;
  }
  console.log(`  ✓ ${packageName}\n      dir=${dir}\n      patch=${declared}`);
}

console.log(failures === 0
  ? '\n结论：按加载器真实解析链复算，全部 bundles 合法 —— 这份配置可以启动。'
  : `\n结论：${failures} 项会让 DSH 启动失败。`);
process.exitCode = failures === 0 ? 0 : 1;
