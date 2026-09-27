/**
 * 闭环终验：注入检查点正文 → 同代静态 → 压缩后换成新内容。
 * 用法: node scripts/verify-closed-loop.mjs
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'ctx-final-'));
const file = join(dir, 'important_view.context-checkpoint.md');
writeFileSync(file, '# Fast Resume\n\n## Current Goal\nV1 目标\n', 'utf8');

const mod = await import('../lib/index.js');
const secs = [];
const owned = new Map([
  ['llm', { resolveModelInfo: async () => ({ context: { contextWindow: 1_000_000 } }) }],
  ['tokenMeter', { measure: () => ({ totalTokens: 520_000, baseline: { kind: 'usage' } }) }],
  ['tools', {}],
  ['systemPrompt', {}]
]);
const ctx = {
  logger: () => ({ info: () => {}, warn: () => {} }),
  on: () => () => {},
  effect: (r) => { r(); return () => {}; },
  tools: { register: () => () => {} },
  systemPrompt: { section: (s) => { secs.push(s); return () => {}; } },
  get: (k) => owned.get(k),
  llm: owned.get('llm')
};
mod.apply(ctx, {});

const session = {
  id: 's',
  header: { cwd: dir },
  requestHeader: () => ({ config: { provider: 'p', model: 'q' } }),
  surface: { replaceGeneration: 5 }
};

const ok = (v) => (v ? '✓' : '✗');
const s1 = secs[0].text({ agent: { session } });
console.log('  1) 注入检查点正文        :', ok(/V1 目标/.test(s1)));
console.log('  2) 同代内两次渲染一致    :', ok(s1 === secs[0].text({ agent: { session } })));
console.log('  3) 段内无动态 token 数字 :', ok(!/520,000/.test(s1)));
console.log('  4) 段内无越线播报噪声    :', ok(!/【上下文占用】/.test(s1)));

// 模拟一次 DSH 自动压缩：surface 代际前进，同时检查点文件被更新
writeFileSync(file, '# Fast Resume\n\n## Current Goal\nV2 目标（压缩后）\n', 'utf8');
session.surface.replaceGeneration = 6;
const s2 = secs[0].text({ agent: { session } });
console.log('  5) 压缩后换成新内容      :', ok(/V2 目标/.test(s2)));
console.log('  6) 跨代文本确实变化      :', ok(s1 !== s2));
console.log('  7) 旧内容已不在段内      :', ok(!/V1 目标/.test(s2)));

rmSync(dir, { recursive: true, force: true });
