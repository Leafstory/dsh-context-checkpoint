#!/usr/bin/env node
/**
 * context-checkpoint 插件本地测试台（不需要 DSH 运行时）。
 *
 * 用桩 ctx 驱动真实插件代码，验证：
 *  1. apply 能跑完并注册两个工具 + 一个提示词段（不再"卡住等不到"）；
 *  2. 占用条按真实 token / 窗口渲染，并在越过安全线时改变措辞；
 *  3. context_status 返回真实数字与 checkpoint 文件探测结果；
 *  4. context_compact 是「回合后执行」：execute 立即返回，压缩在 deferred 里发生，
 *     随后 followup 入队继续消息（顺序：压缩 → 续读）；
 *  5. 无可压缩历史 / 压缩抛错时，仍然会续读（任务不会被晾住）。
 *
 * 用法: node test-plugin.mjs
 */
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const { apply, inject, name } = await import('./lib/index.js');

/**
 * 默认 fixture：一个"已经落盘、且刚写过"的检查点目录。
 *
 * 落盘闸（CHECKPOINT_FRESH_MS）要求压缩前磁盘上的检查点必须是刚写的 —— 这是**正常场景**
 * （模型的正确用法就是"先写文件、再调用 context_compact"），所以默认 fixture 就是它。
 * 异常场景（文件缺失 / 陈旧）由对应 block 显式构造，不再让默认 fixture 落进异常分支。
 */
const DEFAULT_CWD = mkdtempSync(join(tmpdir(), 'ctx-plugin-cwd-'));
writeFileSync(join(DEFAULT_CWD, 'important_view.demo-test.md'), '# Fast Resume\n\n## Current Goal\n默认 fixture\n', 'utf8');

const results = [];
function check(label, actual, expected, detail = '') {
  const pass = actual === expected;
  results.push({ label, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}  (got=${JSON.stringify(actual)}, expect=${JSON.stringify(expected)})${pass ? '' : `  ${String(detail).slice(0, 240)}`}`);
}

/** 构造一个桩 ctx，记录所有注册与调用。
 *  withMeter / withCompactor = false 用来模拟 web 平面（这两个服务只在 host 平面）。
 *  cwd 指定会话工作目录 —— 检查点注入依赖它去找 important_view。 */
function makeCtx({
  usedTokens = 100_000, contextWindow = 1_000_000, compactResult, compactThrows = false,
  idle = true, withMeter = true, withCompactor = true, cwd = DEFAULT_CWD
} = {}) {
  const record = {
    tools: new Map(), sections: [], followups: [], maintenanceCalls: 0, compactionCalls: 0,
    compactionTriggers: [], events: [], effects: [], disposers: [], primitiveRegistrations: [],
    /** 事件名 → 监听器数组（同一事件可能注册多个，例如 agent/pre-step）。 */
    listeners: new Map()
  };
  let used = usedTokens;
  record.setUsed = (n) => { used = n };
  record.listenerFor = (eventName) => (record.listeners.get(eventName) ?? [])[0];
  /**
   * 按 cordis waterfall 语义触发某个事件的所有监听器：每个监听器收到 (payload, next)，
   * `next()` 返回下游结果。这样 pre-step 的注册顺序（先强制压缩、后越线采样）被如实复现。
   */
  record.fire = (eventName, payload, downstream) => {
    const chain = record.listeners.get(eventName) ?? [];
    const run = (i) => {
      if (i >= chain.length) return Promise.resolve(downstream);
      return Promise.resolve(chain[i](payload, () => run(i + 1)));
    };
    return run(0);
  };
  const session = {
    id: 'sess-test',
    header: { cwd },
    requestHeader: () => ({ config: { provider: 'deepseek-official', model: 'deepseek-flash' } }),
    surface: { replaceGeneration: 0 }
  };
  const agent = {
    session,
    wakeRequested: false,
    async whenIdle() { if (!idle) throw new Error('idle wait aborted'); },
    runMaintenance(job) {
      record.maintenanceCalls += 1;
      return Promise.resolve(job(new AbortController().signal)).finally(() => {
        if (agent.wakeRequested) record.events.push('wake');
      });
    },
    followup(message) {
      agent.wakeRequested = true;
      record.followups.push(message);
      record.events.push('followup');
    }
  };
  const ctx = {
    logger: () => ({ info: () => {}, warn: () => {} }),
    // cordis 契约：on() 与 section() 必须返回 disposer；tools.register() 同样返回 disposer。
    // 同时把监听器抓出来，供"事件真实触发"类回归测试调用。
    on: (eventName, listener) => {
      const chain = record.listeners.get(eventName) ?? [];
      chain.push(listener);
      record.listeners.set(eventName, chain);
      return () => {};
    },
    tools: { register: (def) => { record.tools.set(def.name, def); return () => {}; } },
    systemPrompt: { section: (s) => { record.sections.push(s); return () => {}; } },
    llm: { resolveModelInfo: async () => ({ context: { contextWindow } }) },
    record, agent, session
  };

  // ctx.effect：cordis 的资源挂载形态。规范要求 run 返回 disposer；
  // 返回原始值就是本次 "Invalid value used as weak map key" 事故的成因，这里如实记账。
  ctx.effect = (run, label) => {
    record.effects.push(label ?? '(unlabeled)');
    const disposer = run();
    if (typeof disposer !== 'function' && typeof disposer !== 'object') {
      record.primitiveRegistrations.push(`${label ?? '(unlabeled)'} -> ${typeof disposer}`);
    } else {
      record.disposers.push(disposer);
    }
    return () => {};
  };

  // ── 忠实模拟 cordis 的真实行为（本次事故的根因）─────────────────────
  // 1) 未在 inject 声明的服务：属性访问直接抛 "cannot get property X without inject"
  // 2) ctx.get('X') 是安全的软读取，服务不存在时返回 undefined
  const owned = new Map();
  if (withMeter) owned.set('tokenMeter', { measure: () => ({ totalTokens: used, baseline: { kind: 'usage' }, nodes: [] }) });
  if (withCompactor) {
    owned.set('compaction', {
      /**
       * ③ 的实际执行入口。触发值必须带出来记账 —— 只有 'context-overflow'
       * 这条分支绕过 800k 阈值（见 dsh-compaction-basic L886-893），
       * 用 'pressure' 就会在阈值以下静默 return null。
       */
      compactIfNeeded: async (_agent, trigger) => {
        record.compactionCalls += 1;
        record.compactionTriggers.push(trigger);
        record.events.push('compact');
        if (compactThrows) throw new Error('compaction engine exploded');
        return compactResult === undefined ? { shadowedSeqs: [1, 2, 3], shadowedTokenCount: 4242 } : compactResult;
      },
      /** 需要空闲 agent 的旧路径：插件**不得**再用它（回合内必抛 busy）。 */
      compactNow: async () => {
        record.compactNowCalls = (record.compactNowCalls ?? 0) + 1;
        throw new Error('manual compaction requires an idle agent with no waking queued work');
      }
    });
  }
  owned.set('llm', ctx.llm);
  ctx.get = (key) => owned.get(key);
  for (const key of owned.keys()) {
    if (key in ctx) continue;
    Object.defineProperty(ctx, key, {
      configurable: true,
      get() {
        // 模型检查：插件若直接写 ctx.tokenMeter，就会在这里炸掉 —— 与 cordis 一致
        throw new Error(`cannot get property "${key}" without inject`);
      }
    });
  }
  return ctx;
}

const tick = () => new Promise((r) => setTimeout(r, 20));

// ── 1. apply 能跑完并注册齐全 ─────────────────────────────────────────
{
  const ctx = makeCtx();
  apply(ctx, {});
  check('apply 注册了 context_status', ctx.record.tools.has('context_status') ? 1 : 0, 1);
  check('apply 注册了 context_compact', ctx.record.tools.has('context_compact') ? 1 : 0, 1);
  check('apply 注册了占用条提示词段', ctx.record.sections.length, 1);
  check('提示词段名正确', ctx.record.sections[0]?.name, 'context-checkpoint:checkpoint');
  // inject 契约（历史两次事故都在这条上）：
  //   必须含 tools / systemPrompt —— 插件要注册工具与提示词段
  //   必须含 llm —— 否则 ctx.llm 一访问就抛 cannot get property "llm" without inject
  //   绝不能含 host 平面专有服务 —— 否则 web 平面 fiber 永久 pending、DSH 起不来
  const hostOnly = ['tokenMeter', 'compaction', 'sessions', 'sessionProjections', 'agents', 'commands'];
  check('inject 含 tools', inject.includes('tools') ? 1 : 0, 1, inject.join(','));
  check('inject 含 systemPrompt', inject.includes('systemPrompt') ? 1 : 0, 1, inject.join(','));
  check('inject 含 llm（否则 ctx.llm 会抛 without inject）', inject.includes('llm') ? 1 : 0, 1, inject.join(','));
  check('inject 不含 host 平面专有服务', inject.filter((n) => hostOnly.includes(n)).join(',') || '(none)', '(none)', inject.join(','));
  check('插件名未被意外改动', name, '@dsh-external/context-checkpoint');
  const REGISTRATION_COUNT = 8; // session-event, llm-stream, pre-step-compact, idle-watch, checkpoint-section, pre-step, tool-status, tool-compact
  check(`所有注册都走 ctx.effect（${REGISTRATION_COUNT} 处）`, ctx.record.effects.length, REGISTRATION_COUNT, ctx.record.effects.join(' | '));
  check('没有任何注册返回原始值（WeakMap 事故回归）', ctx.record.primitiveRegistrations.length, 0, ctx.record.primitiveRegistrations.join(' | '));
  check('每个注册都拿到了 disposer', ctx.record.disposers.length, REGISTRATION_COUNT, `disposers=${ctx.record.disposers.length}`);
}

// ── 1b. 关键回归：某个注册返回原始值时，插件必须抛带标签的错误 ────────
{
  const ctx = makeCtx();
  // 模拟 cordis 的取消分支：on() 返回布尔 true（这正是 "Invalid value used as weak map key" 的来源）
  ctx.on = () => true;
  let threw = null;
  try { apply(ctx, {}); } catch (error) { threw = String(error.message ?? error); }
  check('注册返回原始值时插件抛错而非污染框架', threw === null ? 0 : 1, 1, String(threw));
  check('抛出的错误点名了责任插件', /context-checkpoint/.test(threw ?? '') ? 1 : 0, 1, String(threw));
  check('抛出的错误说明了原始值类型', /boolean/.test(threw ?? '') ? 1 : 0, 1, String(threw));
}

// ── 2. 无检查点：静态段如实说明，且不含任何数字 ─────────────────────────
{
  const emptyDir = mkdtempSync(join(tmpdir(), 'ctx-nocp-'));
  try {
    const ctx = makeCtx({ usedTokens: 400_000, contextWindow: 1_000_000 });
    apply(ctx, {});
    ctx.session.header.cwd = emptyDir;
    const text = ctx.record.sections[0].text({ agent: ctx.agent });
    check('无检查点时静态段说明尚未落盘', /尚未落盘/.test(text) ? 1 : 0, 1, text);
    check('静态段说明压缩由 DSH 原生引擎承担、插件只负责触发', /DSH 原生压缩引擎/.test(text) ? 1 : 0, 1, text);
    check('静态段不含具体 token 数', /400,000/.test(text) ? 0 : 1, 1, text);
  } finally { rmSync(emptyDir, { recursive: true, force: true }); }
}

// ── 2b. 有检查点文件：内容应被注入静态段，且同代内逐字稳定 ───────────────
{
  const dir = mkdtempSync(join(tmpdir(), 'ctx-cp-'));
  try {
    writeFileSync(join(dir, 'important_view.demo-ab12.md'), [
      '# Fast Resume', '', '## Current Goal', '把插件做成静态注入', '', '## Next Action', '1. 重启验证'
    ].join('\n'), 'utf8');
    const ctx = makeCtx({ usedTokens: 400_000, contextWindow: 1_000_000, cwd: dir });
    apply(ctx, {});
    await ctx.record.tools.get('context_status').execute({}, { agent: ctx.agent, signal: undefined });
    const text = ctx.record.sections[0].text({ agent: ctx.agent });
    check('静态段注入了检查点正文', /把插件做成静态注入/.test(text) ? 1 : 0, 1, text.slice(0, 300));
    check('静态段标注来源文件', /important_view\.demo-ab12\.md/.test(text) ? 1 : 0, 1, text.slice(0, 300));
    check('静态段声明冲突时以文件为准', /以它为准/.test(text) ? 1 : 0, 1, text.slice(0, 380));
    check('静态段声明每代读取一次', /每代读取一次/.test(text) ? 1 : 0, 1, text.slice(0, 300));
    check('同代内重复组装逐字一致（缓存友好）',
      text === ctx.record.sections[0].text({ agent: ctx.agent }) ? 1 : 0, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

// ── 2e. 检查点超限：**截断注入**，绝不静默清空 ──────────────────────────
// 早先的实现超限时把 text 清空、只报"内容未注入" —— 那等于让闭环第 ④ 步静默失效：
// 压缩后模型什么都拿不到，却以为一切正常。现在改为"注入前 60,000 字符 + 一条警告"。
{
  const bigDir = mkdtempSync(join(tmpdir(), 'ctx-bigcp-'));
  try {
    writeFileSync(join(bigDir, 'important_view.big-demo.md'),
      '# BigCheckpoint-MARKER\n' + 'x'.repeat(70_000), 'utf8');
    const ctx = makeCtx({ cwd: bigDir });
    apply(ctx, {});
    const text = ctx.record.sections[0].text({ agent: ctx.agent });
    check('2e 超限时仍注入文件开头内容（不静默清空）', /BigCheckpoint-MARKER/.test(text) ? 1 : 0, 1, text.slice(0, 240));
    check('2e 超限时给出截断警告', /超出可注入上限/.test(text) ? 1 : 0, 1, text.slice(0, 240));
    check('2e 超限时保留权威副本声明', /以它为准/.test(text) ? 1 : 0, 1);
    check('2e 超限时确实截断（没有整文件注入）', text.includes('x'.repeat(65_000)) ? 0 : 1, 1, String(text.length));
  } finally { rmSync(bigDir, { recursive: true, force: true }); }
}

// ── 3. 越线时改口径 ──────────────────────────────────────────────────
{
  const ctx = makeCtx({ usedTokens: 950_000, contextWindow: 1_000_000 });
  apply(ctx, {});
  await ctx.record.tools.get('context_status').execute({}, { agent: ctx.agent, signal: undefined });
  const first = ctx.record.sections[0].text({ agent: ctx.agent });
  // 模拟一次压缩：surface 代际前进
  ctx.session.surface.replaceGeneration += 1;
  const second = ctx.record.sections[0].text({ agent: ctx.agent });
  check('跨代后静态段可重新解析（不抛错）', second.length > 0 ? 1 : 0, 1, String(second.length));
  check('跨代读取仍指向同一文件', second === first ? 1 : 0, 1, '文件未变则内容不变（符合预期）');
}

// ── 4. context_status 返回真实数字 + checkpoint 探测 ─────────────────
{
  const dir = mkdtempSync(join(tmpdir(), 'ctx-plugin-status-'));
  try {
    writeFileSync(join(dir, 'important_view.demo-ab12.md'), 'x'.repeat(1234), 'utf8');
    const ctx = makeCtx({ usedTokens: 500_000, contextWindow: 1_000_000 });
    apply(ctx, {});
    ctx.session.header.cwd = dir;
    const out = await ctx.record.tools.get('context_status').execute({}, { agent: ctx.agent, signal: undefined });
    const parsed = JSON.parse(out);
    check('status.usedTokens 真实', parsed.usedTokens, 500_000);
    check('status.contextWindow 真实', parsed.contextWindow, 1_000_000);
    check('status.safeLine = 90% 窗口', parsed.safeLine, 900_000);
    check('status 找到 checkpoint 文件', parsed.checkpointFile?.endsWith('important_view.demo-ab12.md') ? 1 : 0, 1, out);
    check('status 报告 checkpoint 大小', parsed.checkpointBytes, 1234);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

// ── 5. context_compact：落盘锚点 + 上膛（压缩由 DSH 引擎执行）─────────────
// 设计决定（用户确认方案 A）：本插件**不自行压缩**，只负责落盘与触发时机。
// 触发走后侧路径：pre-step（回合内步骤边界）用 'context-overflow' 强制压缩。
{
  const ctx = makeCtx({ usedTokens: 800_000, contextWindow: 1_000_000 });
  apply(ctx, {});
  const tool = ctx.record.tools.get('context_compact');
  const out = await tool.execute({ note: 'delivery point' }, { agent: ctx.agent, signal: undefined });

  check('compact 不在工具内自行压缩', ctx.record.compactionCalls, 0);
  check('compact 记录落盘点', /Checkpoint recorded/.test(out) ? 1 : 0, 1, out);
  check('compact 报告真实用量', /800,000/.test(out) ? 1 : 0, 1, out);
  check('compact 声明压缩已 armed', /Compaction is armed/i.test(out) ? 1 : 0, 1, out);
  check('compact 说明在"下一个步骤边界"执行（不再等 idle）', /next step boundary/i.test(out) ? 1 : 0, 1, out);
  check('compact 说明无需结束本轮', /do NOT need to end the turn/i.test(out) ? 1 : 0, 1, out);
  check('compact 明令禁止声称已压缩', /不要\*\*声称自己压缩了|do NOT claim/i.test(out) ? 1 : 0, 1, out);
  check('compact 不调 runMaintenance（无竞争窗口）', ctx.record.maintenanceCalls, 0);
  check('compact 不自行唤醒下一轮', ctx.record.followups.length, 0);
  await tick();
  check('工具返回后仍未压缩（压缩发生在步骤边界，不在工具里）', ctx.record.compactionCalls, 0);
}

// ── 9. 没有 checkpoint 文件时必须明确警告 ───────────────────────────────
{
  const emptyDir = mkdtempSync(join(tmpdir(), 'ctx-nocp2-'));
  try {
    const ctx = makeCtx({ cwd: emptyDir });
    apply(ctx, {});
    const out = await ctx.record.tools.get('context_compact').execute({}, { agent: ctx.agent, signal: undefined });
    check('无 checkpoint 时给出明确警告', /NOT FOUND/.test(out) ? 1 : 0, 1, out);
  } finally { rmSync(emptyDir, { recursive: true, force: true }); }
}

// ── 10. 降级：既无 meter 也无 compactor 时仍能工作、不假装 ───────────────
{
  const ctx = makeCtx({ withMeter: false, withCompactor: false });
  apply(ctx, {});
  check('降级：apply 仍能完成注册', ctx.record.tools.size, 2);
  const statusOut = JSON.parse(await ctx.record.tools.get('context_status').execute({}, { agent: ctx.agent, signal: undefined }));
  check('降级：context_status 报 available=false', statusOut.available, false);
  check('降级：回报能力探测', statusOut.capabilityProbe?.tokenMeter, 'absent');
  check('降级：压缩执行入口探针如实报 absent', statusOut.capabilityProbe?.['compaction.compactIfNeeded'], 'absent');
  const compactOut = await ctx.record.tools.get('context_compact').execute({}, { agent: ctx.agent, signal: undefined });
  check('降级：compact 仍不自行压缩', ctx.record.compactionCalls, 0);
  check('降级：compact 如实报用量不可用', /unavailable/.test(compactOut) ? 1 : 0, 1, compactOut);
}

// ── 11. 只有 meter 没有 compactor：能测不能压，但不影响落盘锚点 ──────────
{
  const ctx = makeCtx({ withCompactor: false });
  apply(ctx, {});
  const statusOut = JSON.parse(await ctx.record.tools.get('context_status').execute({}, { agent: ctx.agent, signal: undefined }));
  check('半降级：仍能读出真实占用', statusOut.available, true);
  const compactOut = await ctx.record.tools.get('context_compact').execute({}, { agent: ctx.agent, signal: undefined });
  check('半降级：compact 仍能记录落盘点', /Checkpoint recorded/.test(compactOut) ? 1 : 0, 1, compactOut);
  check('半降级：无 compactor 时明确说明不会压缩', /NO compaction service/.test(compactOut) ? 1 : 0, 1, compactOut);
}


// ── 5b. ②③ 连用（兜底路径）：回合已结束时由 idle 边界压缩并唤醒继续 ──────
// 场景：模型把 context_compact 当作本回合的最后一个动作 —— 之后不会再有 pre-step，
// 所以必须由 agent/status → idle 兜底执行，并 followup 唤醒继续同一任务。
{
  const cpDir = mkdtempSync(join(tmpdir(), 'ctx-couple-'));
  writeFileSync(join(cpDir, 'important_view.demo.md'), '# Fast Resume\n\n## Current Goal\n连用验证\n', 'utf8');
  const ctx = makeCtx({ usedTokens: 700_000, contextWindow: 1_000_000, cwd: cpDir });
  apply(ctx, {});
  check('idle 监听已注册', ctx.record.listenerFor('agent/status') === undefined ? 0 : 1, 1);

  // 调用 ②：只登记，不在回合内压缩
  await ctx.record.tools.get('context_compact').execute({}, { agent: ctx.agent, signal: undefined });
  check('② 调用后尚未压缩（工具内不压）', ctx.record.compactionCalls, 0);

  // 空闲边界到来 → ③ 自动执行
  await ctx.record.fire('agent/status', { status: 'idle' });
  await tick();
  check('③ 在 idle 边界自动压缩', ctx.record.compactionCalls, 1);
  check('③ 压缩后入队续读消息', ctx.record.followups.length, 1);
  const msg = ctx.record.followups[0];
  check('续读消息来自插件而非用户', msg?.source?.kind, 'plugin');
  check('续读消息要求继续同一任务', /继续同一任务/.test(msg?.content?.[0]?.text ?? '') ? 1 : 0, 1, msg?.content?.[0]?.text ?? '');
  check('续读消息指向权威副本', /以它为准/.test(msg?.content?.[0]?.text ?? '') ? 1 : 0, 1, msg?.content?.[0]?.text ?? '');
  // 事件顺序：必须先压缩、后唤醒（反过来会自己制造"待处理工作"）
  check('顺序为 压缩 → 唤醒', ctx.record.events.join('>'), 'compact>followup');
  rmSync(cpDir, { recursive: true, force: true });
}

// ── 5c. 压缩引擎报错：清膛、不唤醒、不炸（不再无限重试）──────────────────
{
  const ctx = makeCtx({ usedTokens: 700_000, contextWindow: 1_000_000, compactThrows: true });
  apply(ctx, {});
  await ctx.record.tools.get('context_compact').execute({}, { agent: ctx.agent, signal: undefined });
  await ctx.record.fire('agent/status', { status: 'idle' });
  await tick();
  check('报错时尝试过压缩', ctx.record.compactionCalls >= 1 ? 1 : 0, 1);
  check('报错时不入队续读（不谎报已压缩）', ctx.record.followups.length, 0);
  await ctx.record.fire('agent/status', { status: 'idle' });
  await tick();
  check('报错后清膛，不无限重试', ctx.record.compactionCalls, 1, String(ctx.record.compactionCalls));
}

// ── 5d. ②③ 连用（主路径）：**回合内下一个步骤边界**就压缩，不等 idle ────
// 这是 2026-09-23 实机事故的回归：上一版只在 idle 执行，而模型调完 context_compact
// 后继续在同一回合里干活 → 空闲窗口永不出现 → 上膛的压缩从未执行，直到请求被服务端
// 以 CONTEXT_WINDOW_EXCEEDED 拒绝（会话 #4230/#4231）。
{
  const ctx = makeCtx({ usedTokens: 700_000, contextWindow: 1_000_000 });
  apply(ctx, {});
  await ctx.record.tools.get('context_compact').execute({}, { agent: ctx.agent, signal: undefined });
  check('5d ② 之后尚未压缩', ctx.record.compactionCalls, 0);

  const out = await ctx.record.fire(
    'agent/pre-step',
    { agent: ctx.agent, messages: [], signal: undefined },
    { kind: 'enter', messages: [] }
  );
  check('5d ③ 回合内下一个步骤边界就压缩（不依赖 idle）', ctx.record.compactionCalls, 1);
  check('5d ③ 用绕过阈值的 context-overflow 触发（pressure 会在阈值下静默不压）',
    ctx.record.compactionTriggers[0], 'context-overflow');
  check('5d 回合内压缩后不额外唤醒（本回合会自己继续）', ctx.record.followups.length, 0);
  check('5d pre-step 仍返回 enter（不破坏决策链）', out?.kind, 'enter');
  check('5d 未用需要空闲的 compactNow', ctx.record.compactNowCalls ?? 0, 0);

  // 已清膛 → 后续步骤不再重复压缩
  await ctx.record.fire('agent/pre-step', { agent: ctx.agent, messages: [], signal: undefined }, { kind: 'enter', messages: [] });
  check('5d 压缩只发生一次（已清膛）', ctx.record.compactionCalls, 1, String(ctx.record.compactionCalls));
}

// ── 5e. 上膛闸门：占用远低于窗口时**只落盘、不压缩**（避免白白压掉历史）──
{
  const ctx = makeCtx({ usedTokens: 120_000, contextWindow: 1_000_000 });
  apply(ctx, {});
  const out = await ctx.record.tools.get('context_compact').execute({}, { agent: ctx.agent, signal: undefined });
  check('5e 低于窗口 50% 时明确说明不压缩', /below the compaction floor/i.test(out) ? 1 : 0, 1, out);
  await ctx.record.fire('agent/pre-step', { agent: ctx.agent, messages: [], signal: undefined }, { kind: 'enter', messages: [] });
  check('5e 未上膛时步骤边界不压缩', ctx.record.compactionCalls, 0);
  const status = JSON.parse(await ctx.record.tools.get('context_status').execute({}, { agent: ctx.agent, signal: undefined }));
  check('5e context_status 报 armedCompactions=0', status.armedCompactions, 0);
}

// ── 5f. 执行前复核：期间已被别处压缩过 → 作废，不"刚压完又压一次" ────────
{
  const ctx = makeCtx({ usedTokens: 700_000, contextWindow: 1_000_000 });
  apply(ctx, {});
  await ctx.record.tools.get('context_compact').execute({}, { agent: ctx.agent, signal: undefined });
  const armed = JSON.parse(await ctx.record.tools.get('context_status').execute({}, { agent: ctx.agent, signal: undefined }));
  check('5f 上膛后 armedCompactions=1', armed.armedCompactions, 1);
  check('5f 记录上膛时的占用量', armed.armedTokens, 700_000);

  // 模拟期间发生了一次 DSH 自己的 overflow 兜底压缩：占用从 70 万掉到 6 万
  ctx.record.setUsed(60_000);
  await ctx.record.fire('agent/pre-step', { agent: ctx.agent, messages: [], signal: undefined }, { kind: 'enter', messages: [] });
  check('5f 占用已大幅下降时放弃压缩（不白烧一次摘要）', ctx.record.compactionCalls, 0);
  const after = JSON.parse(await ctx.record.tools.get('context_status').execute({}, { agent: ctx.agent, signal: undefined }));
  check('5f 作废后已清膛', after.armedCompactions, 0);
}

// ── 5g. force 开关：显式绕过 50% 地板（实机验证 / 应急）─────────────────
{
  const ctx = makeCtx({ usedTokens: 120_000, contextWindow: 1_000_000 });
  apply(ctx, {});
  const out = await ctx.record.tools.get('context_compact').execute({ force: true }, { agent: ctx.agent, signal: undefined });
  check('5g force 时仍上膛', /Compaction is armed/.test(out) ? 1 : 0, 1, out);
  check('5g force 时如实标注绕过地板', /FORCED/i.test(out) ? 1 : 0, 1, out);
  await ctx.record.fire('agent/pre-step', { agent: ctx.agent, messages: [], signal: undefined }, { kind: 'enter', messages: [] });
  check('5g force 的重压在步骤边界真的执行', ctx.record.compactionCalls, 1);
}

// ── 5h. 落盘闸：文件缺失 / 陈旧时**拒绝上膛** ──────────────────────────
// 为什么这是硬要求：压缩由 pre-step 在"下一个步骤边界"执行，模型**没有**补写的机会。
// 此刻磁盘上的内容，就是压缩后会被注入到新代提示词里的内容 ——
// 文件缺失/陈旧就压，等于把最新结论压掉、再注入一份旧总结（用户最怕的"结论丢失"）。
{
  const emptyDir = mkdtempSync(join(tmpdir(), 'ctx-noland-'));
  const staleDir = mkdtempSync(join(tmpdir(), 'ctx-stale-'));
  try {
    // (1) 文件缺失 → 拒绝
    const ctx = makeCtx({ usedTokens: 800_000, contextWindow: 1_000_000, cwd: emptyDir });
    apply(ctx, {});
    const out = await ctx.record.tools.get('context_compact').execute({}, { agent: ctx.agent, signal: undefined });
    check('5h 文件缺失时明确拒绝上膛', /NOT armed/i.test(out) && /NOT FOUND/i.test(out) ? 1 : 0, 1, out);
    await ctx.record.fire('agent/pre-step', { agent: ctx.agent, messages: [], signal: undefined }, { kind: 'enter', messages: [] });
    check('5h 文件缺失时步骤边界不压缩', ctx.record.compactionCalls, 0);
    const status = JSON.parse(await ctx.record.tools.get('context_status').execute({}, { agent: ctx.agent, signal: undefined }));
    check('5h context_status 如实报 checkpointFresh=false', status.checkpointFresh, false);

    // 低占用（达不到地板）时也必须给出落盘警告，不能让模型以为"工具已收下"
    const lowCtx = makeCtx({ usedTokens: 80_000, contextWindow: 1_000_000, cwd: emptyDir });
    apply(lowCtx, {});
    const lowOut = await lowCtx.record.tools.get('context_compact').execute({}, { agent: lowCtx.agent, signal: undefined });
    check('5h 低占用 + 无文件时也给出 NOT FOUND 警告', /NOT FOUND/.test(String(lowOut)) ? 1 : 0, 1, String(lowOut));

    // (2) 陈旧文件（mtime 拨到 1 小时前）→ 拒绝
    const staleFile = join(staleDir, 'important_view.stale-demo.md');
    writeFileSync(staleFile, '# old checkpoint\n', 'utf8');
    const old = new Date(Date.now() - 60 * 60 * 1000);
    utimesSync(staleFile, old, old);
    const ctx2 = makeCtx({ usedTokens: 800_000, contextWindow: 1_000_000, cwd: staleDir });
    apply(ctx2, {});
    const out2 = await ctx2.record.tools.get('context_compact').execute({}, { agent: ctx2.agent, signal: undefined });
    check('5h 陈旧文件时明确拒绝上膛', /NOT armed/i.test(out2) && /STALE/i.test(out2) ? 1 : 0, 1, out2);
    await ctx2.record.fire('agent/pre-step', { agent: ctx2.agent, messages: [], signal: undefined }, { kind: 'enter', messages: [] });
    check('5h 陈旧文件时步骤边界不压缩', ctx2.record.compactionCalls, 0);

    // (3) 被拒后补写文件 → 立刻可以上膛（自愈路径，不留死循环）
    writeFileSync(staleFile, '# fresh checkpoint\n', 'utf8');
    const out3 = await ctx2.record.tools.get('context_compact').execute({}, { agent: ctx2.agent, signal: undefined });
    check('5h 补写文件后立刻可以上膛', /Compaction is armed/i.test(out3) ? 1 : 0, 1, out3);
  } finally {
    rmSync(emptyDir, { recursive: true, force: true });
    rmSync(staleDir, { recursive: true, force: true });
  }
}

// ── 5i. force 是唯一能绕过落盘闸的路径（应急重置 / 实机验证）────────────
{
  const emptyDir = mkdtempSync(join(tmpdir(), 'ctx-force-'));
  try {
    const ctx = makeCtx({ usedTokens: 800_000, contextWindow: 1_000_000, cwd: emptyDir });
    apply(ctx, {});
    const out = await ctx.record.tools.get('context_compact').execute({ force: true }, { agent: ctx.agent, signal: undefined });
    check('5i force 绕过落盘闸仍上膛', /Compaction is armed/i.test(out) ? 1 : 0, 1, out);
    check('5i force 且无落盘时如实标注绕过', /bypassed/i.test(out) ? 1 : 0, 1, out);
    await ctx.record.fire('agent/pre-step', { agent: ctx.agent, messages: [], signal: undefined }, { kind: 'enter', messages: [] });
    check('5i force 的压缩在步骤边界执行', ctx.record.compactionCalls, 1);
  } finally { rmSync(emptyDir, { recursive: true, force: true }); }
}

// ── 5j. 用户显式要求 → 跳过**占用**地板，但不跳过落盘闸（D-006）─────────
// 用户 22:47 的决断：用户自己说"总结一下本轮 / 开始项目"时，要的是"把状态固化下来 +
// 换一个干净的上下文起点"，**与当前占用多少无关** —— 拿"没到窗口 50%"把人挡回去，
// 等于把用户的明确指令降级成建议。
//
// 但落盘闸**不豁免**（用户亲自确认保留）：它守的是"② 落盘必须发生在 ③ 压缩之前"，
// 与用量无关；豁免它就等于允许压掉尚未落盘的结论。
{
  const freshDir = mkdtempSync(join(tmpdir(), 'ctx-intent-'));
  const bareDir = mkdtempSync(join(tmpdir(), 'ctx-intent-bare-'));
  writeFileSync(join(freshDir, 'important_view.intent-demo.md'), '# checkpoint\n', 'utf8');

  /** 造一条真实的用户消息事件（`source.kind === 'user'` 是实测判据）。 */
  const sendMessage = (ctx, text, kind = 'user') => {
    const listener = ctx.record.listenerFor('session/event');
    listener(ctx.session, {
      type: 'user/message',
      data: { content: [{ type: 'text', text }], source: { kind }, role: 'user' }
    });
  };
  const compactTool = (ctx) => ctx.record.tools.get('context_compact');
  const step = (ctx) => ctx.record.fire(
    'agent/pre-step',
    { agent: ctx.agent, messages: [], signal: undefined },
    { kind: 'enter', messages: [] }
  );

  try {
    // (1) 基线：低占用（12%）+ 新鲜检查点，没人要求 → 只落盘、不上膛
    const ctx = makeCtx({ usedTokens: 120_000, contextWindow: 1_000_000, cwd: freshDir });
    apply(ctx, {});
    const baseline = await compactTool(ctx).execute({}, { agent: ctx.agent, signal: undefined });
    check('5j 无用户意图时低占用不上膛（基线）', /below the compaction floor/i.test(baseline) ? 1 : 0, 1, baseline);
    check('5j 基线不压缩', ctx.record.compactionCalls, 0);

    // (2) 用户说"总结一下本轮" → 同样的低占用，照样上膛
    sendMessage(ctx, '先总结一下本轮，然后把结论落盘');
    const asked = await compactTool(ctx).execute({}, { agent: ctx.agent, signal: undefined });
    check('5j 用户显式要求后低占用也上膛', /Compaction is armed/i.test(asked) ? 1 : 0, 1, asked);
    check('5j 上线理由如实标注用户意图', /user's explicit request/i.test(asked) ? 1 : 0, 1, asked);
    await step(ctx);
    check('5j 用户意图的上膛在步骤边界真的执行', ctx.record.compactionCalls, 1);

    // (3) 非用户来源（系统注入的各种 src）即便含信号词，也不算"用户要求"
    //     —— 方向上是故意选保守的一边：漏判退回地板，误判会白压一个还很短的会话。
    const injectedCtx = makeCtx({ usedTokens: 120_000, contextWindow: 1_000_000, cwd: freshDir });
    apply(injectedCtx, {});
    for (const kind of ['compact', 'agent-instructions', 'skill-catalog', '@deepseek-ai/dsh-system-prompt']) {
      sendMessage(injectedCtx, '开始项目：总结一下本轮并落盘', kind);
    }
    const injectedOut = await compactTool(injectedCtx).execute({}, { agent: injectedCtx.agent, signal: undefined });
    check('5j 非用户来源不触发豁免', /below the compaction floor/i.test(injectedOut) ? 1 : 0, 1, injectedOut);

    // (4) 无关消息不触发豁免（信号词表是完整短语，不是"总结"二字）
    const unrelatedCtx = makeCtx({ usedTokens: 120_000, contextWindow: 1_000_000, cwd: freshDir });
    apply(unrelatedCtx, {});
    sendMessage(unrelatedCtx, '帮我看看这个函数的实现，顺便总结一下它的复杂度');
    const unrelatedOut = await compactTool(unrelatedCtx).execute({}, { agent: unrelatedCtx.agent, signal: undefined });
    check('5j 无关消息不触发豁免', /below the compaction floor/i.test(unrelatedOut) ? 1 : 0, 1, unrelatedOut);

    // (5) 窗口过期即失效（窗口长度走 config，所以这里能构造出"已过期"）
    const expiredCtx = makeCtx({ usedTokens: 120_000, contextWindow: 1_000_000, cwd: freshDir });
    apply(expiredCtx, { userIntentWindowMs: 1 });
    sendMessage(expiredCtx, '总结一下本轮');
    await new Promise((r) => setTimeout(r, 10));
    const expiredOut = await compactTool(expiredCtx).execute({}, { agent: expiredCtx.agent, signal: undefined });
    check('5j 意图窗口过期后不再豁免', /below the compaction floor/i.test(expiredOut) ? 1 : 0, 1, expiredOut);

    // (5b) 窗口长度 0 = 关闭豁免。这条专门守 `ageMs < 窗口` 的**严格**边界：
    //      写成 `<=` 时，同一毫秒内记录的消息会让 `0 <= 0` 成立、开关静默失效。
    const offCtx = makeCtx({ usedTokens: 120_000, contextWindow: 1_000_000, cwd: freshDir });
    apply(offCtx, { userIntentWindowMs: 0 });
    sendMessage(offCtx, '总结一下本轮');
    const offOut = await compactTool(offCtx).execute({}, { agent: offCtx.agent, signal: undefined });
    check('5j 窗口长度 0 表示关闭豁免', /below the compaction floor/i.test(offOut) ? 1 : 0, 1, offOut);

    // (6) **关键安全属性**：用户要求 + 检查点不存在 → 仍然拒绝上膛。
    //     用户要的是"固化状态再压缩"，没有落盘就压，正好压掉他要固化的东西。
    const bareCtx = makeCtx({ usedTokens: 120_000, contextWindow: 1_000_000, cwd: bareDir });
    apply(bareCtx, {});
    sendMessage(bareCtx, '开始项目');
    const bareOut = await compactTool(bareCtx).execute({}, { agent: bareCtx.agent, signal: undefined });
    check('5j 落盘闸不豁免：用户要求 + 无文件仍拒绝', /NOT armed/i.test(bareOut) && /NOT FOUND/i.test(bareOut) ? 1 : 0, 1, bareOut);
    check('5j 拒绝时点明"用户要求过、但没落盘"', /explicitly asked/i.test(bareOut) ? 1 : 0, 1, bareOut);
    await step(bareCtx);
    check('5j 被落盘闸拦下时步骤边界不压缩', bareCtx.record.compactionCalls, 0);

    // (7) 工具描述必须把这条规则写给模型看（否则模型会自己去纠结 force）
    const desc = String(compactTool(ctx).description ?? '');
    check('5j 工具描述说明"用户显式要求可跳过地板"', /user-requested checkpoint skips the usage floor/i.test(desc) ? 1 : 0, 1, desc.slice(0, 200));

    // (8) context_status 暴露意图状态：重启后据此确认**新版本真的生效了**
    //     （旧模块没有这两个字段），也用来回答"这次为什么没豁免"。
    const statusJson = JSON.parse(await ctx.record.tools.get('context_status').execute({}, { agent: ctx.agent, signal: undefined }));
    check('5j context_status 报默认意图窗口长度', statusJson.userIntentWindowMs, 900000);
    check('5j context_status 报窗口内命中的用户意图', statusJson.recentUserIntent?.word, '落盘');
  } finally {
    rmSync(freshDir, { recursive: true, force: true });
    rmSync(bareDir, { recursive: true, force: true });
  }
}

// ── 1c. 致命回归：llm/stream 监听用**字符串 sessionId** 作键 ─────────────
// 原实现把 routeBySession 写成 WeakMap 并以 session.id（字符串）为键，
// 首次流事件即抛 "Invalid value used as weak map key" 并毒化整个插件树 ——
// 这正是"换哪种装配方式都崩"的根因。这里直接把事件打进去。
{
  const ctx = makeCtx();
  apply(ctx, {});
  const streamListener = ctx.record.listenerFor('llm/stream');
  check('llm/stream 监听已注册', streamListener === undefined ? 0 : 1, 1);

  let threw = null;
  try {
    streamListener({ sessionId: 'sess-abc-123', provider: 'deepseek-official', model: 'deepseek-flash' }, () => Promise.resolve('downstream'));
  } catch (error) {
    threw = String(error?.message ?? error);
  }
  check('字符串 sessionId 触发 llm/stream 不再抛错（WeakMap 致命回归）', threw === null ? 1 : 0, 1, String(threw));

  // session/event 同样会用对象触发，确认不抛
  const eventListener = ctx.record.listenerFor('session/event');
  let threw2 = null;
  try { eventListener(ctx.session, { type: 'turn/start' }); } catch (error) { threw2 = String(error?.message ?? error); }
  check('session/event 用对象触发正常', threw2 === null ? 1 : 0, 1, String(threw2));
}

// ── 2c. 成本回归：系统提示词段必须**完全静态**（曾因此烧掉 $97/天）──────
// 事故：占用条把每步都在变的 token 数与 surface 计数写进提示词段 →
// 提示词每步都不同 → 新 request series → prompt 缓存全失效、每步全价重算。
// 实测一小时内：未命中缓存输入 40,527,851 / 命中缓存 73,472（0.18%）。
// 修法：段文本 = 静态常量；动态内容改为**每步注入消息**（走消息尾）。
{
  const settings = [
    { used: 1_000, window: 1_000_000 },
    { used: 400_000, window: 1_000_000 },
    { used: 520_000, window: 1_000_000 },
    { used: 950_000, window: 1_000_000 },
    { used: 123_456, window: undefined }
  ];
  const texts = [];
  for (const s of settings) {
    const ctx = makeCtx({ usedTokens: s.used, contextWindow: s.window });
    apply(ctx, {});
    await ctx.record.tools.get('context_status').execute({}, { agent: ctx.agent, signal: undefined });
    texts.push(ctx.record.sections[0].text({ agent: ctx.agent }));
  }
  check('成本回归：提示词段在各种占用量下逐字一致', new Set(texts).size, 1,
    `不同文本数=${new Set(texts).size}`);
  const joined = texts.join('\n');
  // 拦的是**动态**数字（每步会变的用量），不是说明文字里的常量上限。
  const dynamicNumbers = (joined.match(/\d{1,3}(,\d{3})+/g) ?? []).filter((n) => n !== '60,000');
  check('提示词段不含动态 token 数字', dynamicNumbers.length, 0, dynamicNumbers.join(','));
  // 注意：静态档位定义里的 <50% / 50–80% / 80–90% / ≥90% 是**常量**，允许存在。
  // 要拦的是"每步都在变的百分比数值"，即带小数的形态（如 52.0%）。
  check('提示词段不含动态百分比（带小数）', /\d+\.\d+%/.test(joined) ? 0 : 1, 1,
    (joined.match(/\d+\.\d+%/g) ?? []).join(','));
  check('提示词段不含 surface 计数', /surface replace）\d+/.test(joined) ? 0 : 1, 1);
}

// ── 2d. 越线提醒走**消息尾**，且只在跨档位时注入一次 ────────────────────
{
  const ctx = makeCtx({ usedTokens: 520_000, contextWindow: 1_000_000 });
  apply(ctx, {});
  const preStepChain = ctx.record.listeners.get('agent/pre-step') ?? [];
  check('pre-step 注册了两个监听器（先强制压缩、后越线采样）', preStepChain.length, 2, String(preStepChain.length));
  const downstream = { kind: 'enter', messages: [] };
  const out = await ctx.record.fire('agent/pre-step', { agent: ctx.agent, messages: [], signal: undefined }, downstream);
  check('pre-step 仍返回 enter（不破坏决策链）', out?.kind, 'enter');
  check('pre-step 追加了一条消息', out?.messages?.length ?? 0, 1, String(out?.messages?.length));
  const injected = out?.messages?.[0];
  const text = injected?.content?.[0]?.text ?? '';
  check('注入消息带【上下文占用】前缀', text.startsWith('【上下文占用】') ? 1 : 0, 1, text);
  // 提醒文案是**自然路径的驱动源**：它必须与 v3 机制一致 ——
  // 旧文案叫模型"下一次交付点时再调用"，等于把触发时机推给一个不存在的窗口；
  // 而 v3 的压缩发生在"调用之后的第一个步骤边界"，所以顺序要求是"先落盘、再调用"。
  check('52% 的提醒文案要求"先落盘、再调用"', /先[\s\S]{0,40}(写进|更新)[\s\S]{0,60}context_compact/.test(text) ? 1 : 0, 1, text);
  check('52% 的提醒文案说明压缩在下一步自动执行', /下一步/.test(text) ? 1 : 0, 1, text);
  check('52% 的提醒文案明确不必等交付点', /不必等交付点/.test(text) ? 1 : 0, 1, text);
  check('注入消息来自插件而非用户', injected?.source?.kind, 'plugin');
  // 同一档位内不得重复注入（"只提醒一次"）
  const out2 = await ctx.record.fire(
    'agent/pre-step',
    { agent: ctx.agent, messages: [], signal: undefined },
    { kind: 'enter', messages: [] }
  );
  check('同一档位内不重复注入（只提醒一次）', out2?.messages?.length ?? 0, 0, String(out2?.messages?.length));
  // 已存在提醒时也不重复
  const out3 = await ctx.record.fire(
    'agent/pre-step',
    { agent: ctx.agent, messages: [], signal: undefined },
    { kind: 'enter', messages: [injected] }
  );
  check('已存在提醒时不重复注入', out3?.messages?.length ?? 0, 1, String(out3?.messages?.length));
}

const failed = results.filter((r) => !r.pass);
console.log(`\n共 ${results.length} 项，PASS ${results.length - failed.length}，FAIL ${failed.length}`);
process.exitCode = failed.length === 0 ? 0 : 1;