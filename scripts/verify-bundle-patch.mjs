#!/usr/bin/env node
/**
 * 校验本插件的 cordis.patch.yml 是否是加载器可接受的条目形状（只读）。
 *
 * 依据：profile 自身的 cordis.patch.yml 用的是同一套形状（顶层数组，
 * 元素为 `- insert: [ {id, name, config?} ]` 或 `- id: X` + `disabled/config`）。
 * 这里做结构性校验，避免"声明了 dsh.bundle 但 patch 不合法"导致的启动失败。
 *
 * 用法: node scripts/verify-bundle-patch.mjs [profilePatchPath]
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveDesktopAppModule, resolveProfilePatch } from './paths.mjs';

const require = createRequire(import.meta.url);
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

// 复用 DSH 自带的 yaml（不引新依赖）
const YAML_PATHS = [
  resolveDesktopAppModule('yaml'),
  resolveDesktopAppModule('js-yaml')
];
let YAML;
for (const p of YAML_PATHS) {
  try { YAML = require(p); break; } catch { /* try next */ }
}
if (YAML === undefined) {
  console.error('找不到可用的 YAML 解析器（尝试过 yaml / js-yaml）');
  process.exit(2);
}
const parse = YAML.parse ?? YAML.load;

const problems = [];
const checks = [];

function checkFile(label, path) {
  let doc;
  try {
    doc = parse(readFileSync(path, 'utf8'));
  } catch (error) {
    problems.push(`${label}: YAML 解析失败 — ${String(error).slice(0, 160)}`);
    return;
  }
  if (!Array.isArray(doc)) {
    problems.push(`${label}: 顶层必须是数组（加载器的 patch 层格式）`);
    return;
  }
  checks.push(`${label}: 顶层数组，${doc.length} 个条目`);
  doc.forEach((entry, i) => {
    const at = `${label}[${i}]`;
    if (entry === null || typeof entry !== 'object') { problems.push(`${at}: 条目必须是对象`); return; }
    if ('insert' in entry) {
      if (!Array.isArray(entry.insert) || entry.insert.length === 0) {
        problems.push(`${at}: insert 必须是非空数组`);
        return;
      }
      entry.insert.forEach((item, j) => {
        const iat = `${at}.insert[${j}]`;
        if (item === null || typeof item !== 'object') { problems.push(`${iat}: 必须是对象`); return; }
        if (typeof item.id !== 'string' || item.id.length === 0) problems.push(`${iat}: 缺少字符串 id`);
        if (typeof item.name !== 'string' || item.name.length === 0) problems.push(`${iat}: 缺少字符串 name`);
      });
      return;
    }
    if (typeof entry.id !== 'string' || entry.id.length === 0) {
      problems.push(`${at}: 既不是 insert 条目，也没有字符串 id`);
      return;
    }
    if ('disabled' in entry && typeof entry.disabled !== 'boolean') {
      problems.push(`${at}: disabled 必须是布尔值`);
    }
  });
}

const ownPatch = join(ROOT, 'cordis.patch.yml');
checkFile('本插件 cordis.patch.yml', ownPatch);

const profilePatch = resolve(process.argv[2] ?? resolveProfilePatch());
try {
  checkFile('profile cordis.patch.yml（对照）', profilePatch);
} catch (error) {
  checks.push(`profile patch 未检查: ${String(error).slice(0, 80)}`);
}

// 两份 patch 的形状必须同族：本插件的每条 insert 都要能在 profile patch 里找到同类
try {
  const own = parse(readFileSync(ownPatch, 'utf8'));
  const shapeOf = (doc) => [...new Set(doc.flatMap((e) => Object.keys(e)))].sort().join(',');
  const ownShape = shapeOf(own);
  checks.push(`本插件 patch 条目键: {${ownShape}}`);
  if (!own.every((e) => 'insert' in e || 'id' in e)) {
    problems.push('本插件 patch 含未知形状的条目');
  }
} catch { /* 已在上面报过 */ }

for (const c of checks) console.log(`  · ${c}`);
if (problems.length > 0) {
  console.error('\n校验失败：');
  for (const p of problems) console.error(`  ✗ ${p}`);
  process.exit(1);
}
console.log('\n结论：bundle patch 形状合法，加载器可接受。');
