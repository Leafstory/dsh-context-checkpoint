#!/usr/bin/env node
/**
 * 文档一致性测试：把 SKILL.md 里的模板骨架原样抽出，检验它必须能通过自己的 verify。
 * 这防止"文档提供的模板照抄即失败"这类自相矛盾回归。
 *
 * 用法: node test-skill-template.mjs
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SKILL_MD = join(HERE, '..', 'SKILL.md');
const SCRIPT = join(HERE, 'checkpoint.mjs');

const md = readFileSync(SKILL_MD, 'utf8');

// 1) SKILL.md 自身 frontmatter 必须有 name / description
const own = md.match(/^---\r?\n([\s\S]*?)\r?\n---/);
const problems = [];
if (!own) problems.push('SKILL.md 自身缺少 frontmatter');
else {
  if (!/^name:\s*context-checkpoint\s*$/m.test(own[1])) problems.push('SKILL.md frontmatter 缺少或写错 name');
  if (!/^description:\s*\S/m.test(own[1])) problems.push('SKILL.md frontmatter 缺少 description');
}

// 2) 抽出 §4.2 的模板骨架代码块（第一个含 schema_version 的 markdown 代码块）
const blocks = [...md.matchAll(/```markdown\r?\n([\s\S]*?)```/g)].map((m) => m[1]);
const template = blocks.find((b) => b.includes('schema_version:'));
if (!template) problems.push('未在 SKILL.md 中找到含 schema_version 的 markdown 模板块');

const sandbox = mkdtempSync(join(tmpdir(), 'ctx-skill-template-'));
let verifyOut = '';
let verifyCode = -1;
try {
  if (template) {
    // 模板里的占位值需要替换成合法的具体值，才代表"照抄后的结果"。
    const root = sandbox.replace(/\\/g, '/');
    const filled = template
      .replace('"稳定项目标识"', '"dsh-workplace"')
      .replace('"任务标识"', '"context-checkpoint"')
      .replace('"会话标识"', '"sess-ab12"')
      .replace('"2026-01-01T00:00:00+08:00"', '"2026-09-22T22:00:00+08:00"')
      .replace('"绝对路径"', `"${root}"`);
    const file = join(sandbox, 'important_view.context-checkpoint-sess-ab12.md');
    writeFileSync(file, filled, 'utf8');
    try {
      verifyOut = execFileSync(process.execPath, [SCRIPT, 'verify', '--file', file], { encoding: 'utf8' });
      verifyCode = 0;
    } catch (error) {
      verifyCode = error.status ?? -1;
      verifyOut = `${error.stdout ?? ''}${error.stderr ?? ''}`;
    }
    if (verifyCode !== 0) problems.push(`SKILL.md 模板骨架照抄后未通过 verify（exit ${verifyCode}）: ${verifyOut.replace(/\s+/g, ' ').slice(0, 400)}`);
  }
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}

console.log(problems.length === 0
  ? 'PASS  SKILL.md 自身 frontmatter 合规，且 §4.2 模板骨架照抄后可通过 verify（exit 0）'
  : `FAIL  ${problems.length} 项问题:\n- ${problems.join('\n- ')}`);
process.exitCode = problems.length === 0 ? 0 : 1;
