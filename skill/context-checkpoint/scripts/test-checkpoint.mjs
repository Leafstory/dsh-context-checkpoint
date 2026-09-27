#!/usr/bin/env node
/**
 * context-checkpoint 回归测试：自建 fixture，正负向全跑，退出码即结论。
 *
 * 用法: node test-checkpoint.mjs [--keep]
 *   --keep  保留临时目录（排查用）；默认跑完清理。
 *
 * 退出码: 0 = 全部 PASS; 1 = 有用例 FAIL; 2 = 环境错误。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, 'checkpoint.mjs');
const KEEP = process.argv.includes('--keep');

/** 跑一条子命令，返回 { code, out }。 */
function run(args) {
  try {
    const out = execFileSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, out };
  } catch (error) {
    return { code: error.status ?? -1, out: `${error.stdout ?? ''}${error.stderr ?? ''}` };
  }
}

const SENTINEL = '<!-- checkpoint:end -->';

/** 生成一份结构完整的合规文件（可覆盖字段 / 追加正文 / 指定哨兵）。 */
function fixture({ over = {}, extraBody = '', sentinel = true, omit = [] } = {}) {
  const keys = {
    schema_version: '1',
    project_id: '"p"',
    task_id: '"t"',
    session_id: '"s"',
    status: 'active',
    created_at: '"2026-01-01T00:00:00+08:00"',
    updated_at: '"2026-01-01T00:00:00+08:00"',
    generation: '1',
    project_root: '"__ROOT__"',
    git_branch: '"none"',
    git_head: '"none"',
    working_tree: 'unknown',
    memory_reason: 'milestone',
    ...over
  };
  const lines = Object.entries(keys).filter(([k]) => !omit.includes(k)).map(([k, v]) => `${k}: ${v}`);
  return [
    '---', ...lines, '---', '',
    '# Fast Resume', '', '## Current Goal', '目标', '', '## Current State', '- 状态', '', '## Next Action', '1. 下一步', '',
    '# Hard Constraints / Invariants', '- [USER-CONFIRMED] 约束', '',
    '# Decisions', '## D-001 — 决策', 'State: active', '',
    '# Validation State', '## Confirmed', '- `cmd` → ok', '',
    '# Recovery / Revalidation', '1. 核对',
    extraBody,
    ...(sentinel ? ['', SENTINEL] : []), ''
  ].join('\n');
}

const results = [];
function check(name, actual, expected, detail = '') {
  const pass = actual === expected;
  results.push({ name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}  (got=${JSON.stringify(actual)}, expect=${JSON.stringify(expected)})${pass ? '' : `  ${String(detail).replace(/\s+/g, ' ').slice(0, 220)}`}`);
}

const sandbox = mkdtempSync(join(tmpdir(), 'ctx-checkpoint-test-'));
const neg = join(sandbox, 'neg');
mkdirSync(neg, { recursive: true });

try {
  // ---------- 正向 ----------
  const good = join(neg, 'important_view.t-s.md');
  writeFileSync(good, fixture().replace('__ROOT__', neg.replace(/\\/g, '/')), 'utf8');
  check('verify: 合规文件 exit 0', run(['verify', '--file', good]).code, 0);

  // CRLF + BOM + 行内注释
  const commenty = join(neg, 'important_view.comments.md');
  writeFileSync(
    commenty,
    '\uFEFF' + fixture({
      over: { status: 'active            # active | completed | superseded', memory_reason: 'milestone  # milestone | manual' }
    }).replace('__ROOT__', neg.replace(/\\/g, '/')).replace(/\n/g, '\r\n'),
    'utf8'
  );
  const commentRes = run(['verify', '--file', commenty]);
  check('verify: CRLF+BOM+行内注释 exit 0', commentRes.code, 0, commentRes.out);

  // ---------- 负向：结构 ----------
  const empty = join(neg, 'important_view.empty.md');
  writeFileSync(empty, '', 'utf8');
  check('verify: 空文件 exit 1', run(['verify', '--file', empty]).code, 1);

  const badkeys = join(neg, 'important_view.badkeys.md');
  writeFileSync(badkeys, '---\nschema_version: 1\ntask_id: "x"\nstatus: bogus\ngeneration: 1\n---\n# Fast Resume\n## Current Goal\nx\n', 'utf8');
  const badRes = run(['verify', '--file', badkeys]);
  check('verify: 缺键/非法status exit 1', badRes.code, 1);
  check('verify: 报告非法 status', /status 非法/.test(badRes.out) ? 1 : 0, 1, badRes.out);

  const noSentinel = join(neg, 'important_view.nosentinel.md');
  writeFileSync(noSentinel, fixture({ sentinel: false }), 'utf8');
  const noSentinelRes = run(['verify', '--file', noSentinel]);
  check('verify: 缺文末哨兵 exit 1', noSentinelRes.code, 1);
  check('verify: 报告缺哨兵', /哨兵/.test(noSentinelRes.out) ? 1 : 0, 1, noSentinelRes.out);

  const truncated = join(neg, 'important_view.truncated.md');
  writeFileSync(truncated, '# Fast Resume\n\n## Current Goal\n目标\n\n## Current State\n- x\n\n## Next Action\n1. y\n', 'utf8');
  const truncatedRes = run(['verify', '--file', truncated]);
  check('verify: 只写头部（缺后半篇小节）exit 1', truncatedRes.code, 1);
  check('verify: 报告缺 Decisions', /缺少必备小节: # Decisions/.test(truncatedRes.out) ? 1 : 0, 1, truncatedRes.out);

  const badName = join(neg, 'notes.md');
  writeFileSync(badName, fixture(), 'utf8');
  check('verify: 文件名不合约定 exit 1', run(['verify', '--file', badName]).code, 1);

  check('verify: 文件不存在 exit 1', run(['verify', '--file', join(neg, 'important_view.nope.md')]).code, 1);
  check('verify: 缺 --file exit 2', run(['verify']).code, 2);

  // ---------- 负向：warnings 不阻断 ----------
  const warnFile = join(neg, 'important_view.warn.md');
  writeFileSync(warnFile, fixture({ over: { working_tree: 'weird', updated_at: '"not-a-date"' } }).replace('__ROOT__', 'E:/somewhere/else'), 'utf8');
  const warnRes = run(['verify', '--file', warnFile]);
  check('verify: 非标准 working_tree / 坏时间不阻断 exit 0', warnRes.code, 0, warnRes.out);
  check('verify: 输出 warnings', /"warnings": \[\n?\s*"/.test(warnRes.out) ? 1 : 0, 1, warnRes.out);

  // ---------- 预算阈值 ----------
  const soft = join(neg, 'important_view.soft.md');
  writeFileSync(soft, fixture({ extraBody: '中'.repeat(30000) }), 'utf8');
  check('budget: 超软目标 exit 0', run(['budget', '--file', soft]).code, 0);
  check('budget: 报 OVER_SOFT_TARGET', /OVER_SOFT_TARGET/.test(run(['budget', '--file', soft]).out) ? 1 : 0, 1);
  check('verify: 超软目标不失败 exit 0', run(['verify', '--file', soft]).code, 0);

  const hard = join(neg, 'important_view.hard.md');
  writeFileSync(hard, fixture({ extraBody: '中'.repeat(90000) }), 'utf8');
  const hardRes = run(['verify', '--file', hard]);
  check('verify: 超硬上限 exit 1', hardRes.code, 1);
  check('verify: 报超出硬上限', /超出硬上限/.test(hardRes.out) ? 1 : 0, 1, hardRes.out);
  check('budget: 超硬上限 exit 1', run(['budget', '--file', hard]).code, 1);
  check('budget: 文件不存在 exit 2', run(['budget', '--file', join(neg, 'nope.md')]).code, 2);

  // ---------- locate ----------
  const locate = run(['locate', '--root', neg]);
  check('locate: exit 0', locate.code, 0);
  check('locate: exists=true', /"exists": true/.test(locate.out) ? 1 : 0, 1);
  const quiet = run(['locate', '--root', neg, '--quiet']);
  check('locate --quiet: exit 0', quiet.code, 0);
  check('locate --quiet: 不含完整 frontmatter 段', /"frontmatter":/.test(quiet.out) ? 0 : 1, 1, quiet.out);
  check('locate --quiet: 含 generation', /"generation":/.test(quiet.out) ? 1 : 0, 1, quiet.out);
  const locateEmpty = run(['locate', '--root', join(sandbox, 'nowhere')]);
  check('locate: 空目录 exit 0 且 exists=false', locateEmpty.code === 0 && /"exists": false/.test(locateEmpty.out) ? 1 : 0, 1);
  check('locate: root 是文件时 exit 2', run(['locate', '--root', good]).code, 2);

  // 中文 task slug 的文件必须能被 locate 看见（回归 BLOCKER）
  const cjkDir = join(sandbox, 'cjk');
  mkdirSync(cjkDir, { recursive: true });
  writeFileSync(join(cjkDir, 'important_view.上下文检查点-ab12.md'), fixture(), 'utf8');
  const cjkLocate = run(['locate', '--root', cjkDir, '--quiet']);
  check('locate: 中文 task 名文件可见（B-1 回归）', /"exists": true/.test(cjkLocate.out) ? 1 : 0, 1, cjkLocate.out);

  // ---------- archive 代际 ----------
  const root2 = join(sandbox, 'arch');
  mkdirSync(root2, { recursive: true });
  const canonical = join(root2, 'important_view.t-s.md');
  const mem = join(root2, '.dsh', 'memory');
  writeFileSync(canonical, fixture(), 'utf8');
  const a1 = run(['archive', '--file', canonical, '--root', root2]);
  check('archive: 生成 g001', existsSync(join(mem, 'important_view.t-s.g001.md')) ? 1 : 0, 1, a1.out);
  check('archive: canonical 已移走', existsSync(canonical) ? 0 : 1, 1);
  check('archive: nextGeneration=2（与 generation 同序列）', /"nextGeneration": 2/.test(a1.out) ? 1 : 0, 1, a1.out);
  writeFileSync(canonical, fixture({ over: { generation: '2' } }), 'utf8');
  const a2 = run(['archive', '--file', canonical, '--root', root2]);
  check('archive: 第二次生成 g002', existsSync(join(mem, 'important_view.t-s.g002.md')) ? 1 : 0, 1, a2.out);
  check('archive: 第三次 nextGeneration=3', /"nextGeneration": 3/.test(a2.out) ? 1 : 0, 1, a2.out);
  check('archive: 缺文件 exit 2', run(['archive', '--file', join(root2, 'nope.md'), '--root', root2]).code, 2);

  // 归档回退：canonical 不在但归档在 → locate 给出 archivedFallback
  const fb = run(['locate', '--root', root2]);
  check('locate: 无 canonical 时给出归档回退', /"archivedFallback": \[\n?\s*\{/.test(fb.out) ? 1 : 0, 1, fb.out);

  // ---------- slug ----------
  check('slug: ASCII 按词边界截断', run(['slug', '--text', 'Context Checkpoint Design']).out.trim(), 'context-checkpoint-design');
  check('slug: 纯中文回退为 task（不产中文文件名）', run(['slug', '--text', '上下文检查点']).out.trim(), 'task');
  check('slug: 纯符号回退为 task', run(['slug', '--text', '@@@']).out.trim(), 'task');
  check('slug: 缺 --text exit 2', run(['slug']).code, 2);

  // ---------- 分派与容错 ----------
  check('未知子命令 exit 2', run(['nope']).code, 2);
  check('原型链键不穿透（constructor）exit 2', run(['constructor']).code, 2);
  check('原型链键不穿透（__proto__）exit 2', run(['__proto__']).code, 2);
} finally {
  if (KEEP) console.log(`\n保留临时目录: ${sandbox}`);
  else rmSync(sandbox, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.pass);
console.log(`\n共 ${results.length} 项，PASS ${results.length - failed.length}，FAIL ${failed.length}`);
console.log(`脚本路径: ${resolve(SCRIPT)}`);
process.exitCode = failed.length === 0 ? 0 : 1;
