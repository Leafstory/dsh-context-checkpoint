# @dsh-external/context-checkpoint

把「**达限 → 总结落盘 → 自动压缩 → 压缩后把总结重新注入为静态上下文**」做成一条闭环。

## 背景：为了解决什么

为的是 **DeepSeek V4.1 Flash 在 DSH 长上下文里的稳定性问题**。会话一长，就出现这些现象：

- **否定自己先前的正确结论** —— 明明已经定下并验证过的事，被重新推翻；
- **丢失关键节点** —— 走到哪一步、还差什么，说不清；
- **遗漏问题** —— 用户提过的约束与待办被漏掉；
- **幻觉率随上下文变长而升高** —— 于是要花大量时间回头纠正。

同时我们注意到一个可以利用的特性：**它在每轮对话的开头注意力最高、思考也最展开**。
换句话说，关键状态放在上下文的开头，是模型最容易真正读进去的位置；埋在几十万 token 的历史里则相反。

所以做法就定下来了：**自动总结 → 压缩 → 把总结注入回上下文开头 → 继续同一个任务**。
每到一个交付点把项目现状落盘；压缩交给 DSH 原生引擎；压缩后插件把那份总结重新注入成
**静态上下文**（永远位于提示词前部）。模型因此在"注意力最高的位置"拿到当前事实，
而不是依赖回忆，也不必在"上下文快满了要不要重开会话"之间反复权衡 —— 长期任务可以一直跑下去。

> 这是**工程手段**，不是模型修复：插件的职责只是把关键状态反复放到最有注意力的位置。

## 闭环的四步

| 步 | 由谁做 | 说明 |
| --- | --- | --- |
| ① 达限 | 越线提醒（本插件）/ DSH 原生阈值 / **用户本人明说** | 跨档位时本插件**提醒一次**落盘；占用 ≥ 窗口 50% 是**触发门槛**，但用户明确要求总结/开始项目时门槛让路（D-006） |
| ② 总结 | 模型 + `context_compact` + skill | 模型把项目状态写进 `important_view.<task>-<session>.md` |
| ③ 压缩 | **DSH 压缩引擎**（本插件触发：`compactIfNeeded`） | 触发点 = **`agent/pre-step` 步骤边界**，用 `'context-overflow'` 绕过阈值 |
| ④ **注入** | **本插件的系统提示词段** | 每代读一次检查点文件，**内容作为静态上下文注入**；跨代（压缩发生）自动换新 |

第 ④ 步是本插件的核心：`important_view` 的正文因此**长期存在于 prompt 里**，
不依赖模型记住、也不受自动压缩摘要取舍的影响。

## 两个工具

| 工具 | 作用 |
| --- | --- |
| `context_status` | 按需读精确占用（已用 token / 窗口 / 距安全线 / 待执行数 / 压缩执行入口探针 / 检查点文件探测） |
| `context_compact` | **落盘锚点 + 预约**：记录交付点，把压缩挂到下一个步骤边界。**它本身不执行压缩** |

**占用数字只在模型主动调用 `context_status` 时给出**，不进提示词段 ——
提示词段里只要出现动态值，整段 prompt 缓存就会失效（代价是每天上百美元的重复计费）。

### ③ 压缩是怎么被触发的

触发点是 **`agent/pre-step`（步骤边界）**，配合 `'context-overflow'` 这条分支 ——
它不比阈值、也不需要 agent 空闲。这一点是关键，因为**空闲窗口根本等不到**：

**等空闲再压**是走不通的：模型调用 `context_compact` 之后**继续在同一回合里干活**，
空闲窗口永远不出现，预约的压缩一直不执行，直到请求被服务端以

```
This model's maximum context length is 1048576 tokens. However, you requested 1048831 tokens
(655831 in the messages, 393000 in the completion). code: CONTEXT_WINDOW_EXCEEDED, status 400
```

拒绝，才由 DSH 的 overflow 兜底路径勉强压了一次。另一种做法 `compactNow()` 同样要求空闲
（它内部就是 `agent.runMaintenance()`），回合内调用必被包成 `ManualCompactionError('busy')`。

**实际做法**：读 DSH 自己的代码找到那条不需要空闲、也不比阈值的分支 ——

```js
// dsh-compaction-basic/lib/index.js:886-893
if (trigger === "context-overflow") {          // 不走 threshold 判定
  if (prune !== void 0) { prune.pruneSession(agent.session); measurement = meter.measure(agent.session) }
  const range = selectCompactableRange(agent.session, measurement, 0)
  if (range === null) return null
  return this.compactRegion(range.start, range.end, agent, signal)
}
```

于是插件挂 `agent/pre-step`（DSH 自己也是在这个事件里做压力压缩的）：

- **不依赖阈值**（`thresholdRatio 0.8 × contextWindow` 在本机因 `maxTokens` 占掉输入预算而永远够不到）；
- **不依赖空闲**（`compactIfNeeded` 没有 `runMaintenance` 包装）；
- **不依赖模型自觉停手**（预约后的**下一步**就执行；若模型正好收尾，则由 idle 兜底 + `followup()` 唤醒）。

三道闸 + 一层豁免 + 一个显式绕行口：

| 闸 | 常量 | 作用 |
| --- | --- | --- |
| 触发门槛 | `MIN_TRIGGER_RATIO = 0.5` | 占用 < 窗口 50% 时只落盘、不压缩（避免把还在用的历史白白压掉） |
| **用户意图豁免** | `userIntentWindowMs = 15 分钟` | 用户**本人**说过"总结/落盘/压缩/开始项目" ⇒ **只跳门槛**（落盘闸照旧，见下节 D-006） |
| 执行前复核 | `STALE_RATIO = 0.5` | 占用已跌到预约时的一半以下 ⇒ 期间别处压过 ⇒ 作废，避免刚压完又压 |
| **落盘闸** | `CHECKPOINT_FRESH_MS = 10 分钟` | 检查点文件缺失/陈旧 ⇒ **拒绝预约**（理由见下节：预约之后没有补写窗口） |
| 显式绕过 | `context_compact { force: true }` | 绕过**门槛与落盘闸**（实机验证 / 应急重置），返回文案标注 `FORCED` |

**实机验证（2026-09-23 22:26，会话 57d4c0ff turn 30）**：

```
#4711  tool/call  context_compact {force:true}     ← 预约
#4713  step/end   step=2
#4714  compaction/start  id=d7119c5a turn=30       ← 步骤边界自动开跑
#4715  compaction/summary
#4716  user/message  src=compact
#4717  compaction/end    error=none
#4718  step/start  step=3
#4722  assistant/message in=57,087                 ← 压缩前是 207,506
```

`surfaceReplaceCount 216 → 217`，`scheduledCompactions` 归 0（预约被消费干净）。
**start/end 落在 step2 与 step3 之间 —— 回合并未结束**：模型没有停手、没有空闲窗口，压缩照样执行了。
这正是"不等空闲窗口"的关键：压缩发生在**回合中间**。

**第二次实机（同日 23:2x，同一会话 turn 31）—— 完整 1-2-3-4 一次跑通**：

```
#5406  write  important_view.context-checkpoint.md   ← ② 落盘（generation 6）
#5411  tool/call  context_compact {force:true}        ← ③ 预约
#5414  compaction/start  id=9da939a8 turn=31          ← 步骤边界自动开跑
#5415  compaction/summary
#5416  user/message  src=compact
#5417  compaction/end    error=none
#5427  system/message    generation=6                 ← ④ 跨代刷新（正文换新）
```

请求输入 136,892 → 57,424（`context_status` 报 57,407 token / 1,000,000），
`scheduledCompactions` 归 0，文字压缩结果归因仍判为"插件预约"。

**触发方归属**（`scripts/verify-coupling-live.mjs` 自动判据；`compaction/start` 事件本身**不带** trigger 字段）：
同一会话历史上的五次压缩 —— turn 7 与 turn 29 两次是 **DSH 在请求被拒之后的原生兜底**
（`CONTEXT_WINDOW_EXCEEDED`），其余三次（turn 30 / turn 31 ×2）是**插件预约**
（调用 `context_compact` 后间隔 3 个事件开跑）。

### 落盘闸：预约之后**没有**补写窗口

时序推理只有一句话：压缩跑在预约之后的**第一个步骤边界**。

```
step N    : 模型调用 context_compact → 预约
step N+1  : pre-step 触发 → 压缩开跑
            （此刻磁盘上是什么，压完注入到新代提示词里的就是什么）
```

模型**没有机会**在 step N 与 N+1 之间补写文件。所以如果这时磁盘上的检查点还是上一代写的、
或者干脆不存在，压缩就会把尚未落盘的最新结论压掉，再往新代注入一份**旧**总结 ——
恰好就是这个工具要防的"结论丢失"。

因此 `context_compact` 在预约前先 `statSync` 一次：文件缺失、或 mtime 距今超过
`CHECKPOINT_FRESH_MS`（10 分钟），就**拒绝预约**，并明确要求"先写/更新文件，再调用一次"。
补写后 mtime 立刻变新，用同样的参数重调即可通过（不会留死循环）。
绕过**这道闸**的唯一口子是 `force: true` —— 用户意图豁免只让**门槛**让路，不碰这道闸。

为什么用固定时间窗，而不是"比较上次压缩时间"这种更精确的判据：后者需要额外状态（跨重启还要持久化），
而前者的误伤代价只是**多写一次文件**（保守方向），漏判的代价却是不可逆的结论丢失。

### 用户意图豁免：谁按的按钮，就按谁说的话算（D-006）

用户明确说"总结一下本轮 / 开始项目"时要的是**固化状态 + 换一个干净的起点**，与占用多少无关。
拿门槛把这种指令挡回去（"占用还不够，先别压"）等于把一条**指令**降级成一条**建议**。

| 项 | 取值 |
| --- | --- |
| 触发判据 | `event.type === 'user/message'` ∧ `event.data.source.kind === 'user'` ∧ 正文命中信号词表 |
| 豁免范围 | **只有触发门槛**；落盘闸、执行前复核照旧生效 |
| 有效期 | `userIntentWindowMs`，默认 15 分钟；**`0` = 关闭豁免** |
| 比较方式 | `ageMs < 窗口`（**严格小于**） |
| 可观测 | `context_status` 返回 `userIntentWindowMs` 与 `recentUserIntent`（`null` 或 `{word, ageMs}`） |

三条刻意的设计：

1. **只读用户说了什么，不看模型传了什么参数。** 让模型每次自己判断"该不该传 force"，等于把稳定性
   交给模型的记性 —— 那正是被否掉的方案。词表写在插件里，命中的词会回填进返回文案
   （`on the user's explicit request: "<词>"`）。
2. **注入消息不算用户消息。** 压缩摘要（`source.kind === 'compact'`）、AGENTS.md
   （`agent-instructions`）、技能目录（`skill-catalog`）各有自己的 kind，一律不算 —— 否则一次压缩
   留下的摘要就可能把后面每一轮都变成"用户要求过"。
3. **窗口为 0 必须真的等于关闭。** 回归 5j 当场抓到过：写成 `ageMs <= 窗口` 时，同一毫秒记录的消息
   满足 `0 <= 0`，于是 `userIntentWindowMs: 0` 静默失效。判据必须是严格小于。

安全方向：漏判（用户确实要求过但没识别出来）只是退回门槛，**保守**；误判才会在短会话上白压一把 ——
所以判据取保守的那一侧。

> 判定"新代码是否真的在跑"：看 `context_status` 有没有 `userIntentWindowMs` / `recentUserIntent`。
> 本机 2026-09-23 的 42,632 B 旧版（只有落盘闸）没有这两个字段 —— 注入成功 ≠ 代码生效，
> 改完代码必须**重启 DSH**（见文末）。

### 怎么证明第 ④ 步真的发生了（取证通道）

"总结有没有真的进提示词"不能靠感觉。三个候选通道里只有一个能用：

| 通道 | 含提示词正文？ | 结论 |
| --- | --- | --- |
| `request/header` | ❌ 只有 config / tools 清单 | 正文不在这里（曾在此搜 `important_view`，一无所获） |
| `user/message src=compact` | ❌ 是压缩**摘要**，不是提示词 | 只能当**阴性对照** |
| **`system/message`** | ✅ **完整落盘 system prompt 正文** | **唯一独立通道** |

取证两步（脚本已备好）：

```powershell
# ① 一次拿到"每一代提示词里装的是第几代检查点"
node scripts/list-events.mjs system/message --last 6 --grep "generation: 6"

# ② 阳性 / 阴性对照：同一个判别词，分别打在"压缩后的提示词"与"压缩摘要"上
node scripts/dump-event.mjs 5427 --grep "generation: 6"   # 压缩后的 system/message → 应命中
node scripts/dump-event.mjs 5415 --grep "generation: 6"   # 同一次的 compaction/summary → 应无命中
```

本机实测的生成序列（会话 57d4c0ff）：

| 事件 | 段内 `generation` | 段内字节 |
| --- | --- | --- |
| `#4608` | 2 | 19,363 |
| `#4677` / `#4702` | 3 | 17,849 / 17,956 |
| `#5203` | 5 | 20,987 |
| `#5427` | **6** | 18,957 |

`#5203` 是压缩 `#5188` 之后新铸的提示词（段内 gen 5），`#5427` 是压缩 `#5414` 之后新铸的
（段内 gen 6 —— 就是 `#5406` 刚落盘的那份）。**代次号在压缩处变了，且不是摘要污染**，这条就是 ④ 的硬证据。

⚠️ **判别词必须逐个做阴性对照**。实测被污染过的两个：`Fast Resume`、
`userIntentWindowMs: 900000` —— 它们在**压缩摘要里也各出现 2 次**（摘要吸收了我自己写文件时的
工具调用参数）。干净的判别词例如 `generation: N`、检查点特有的小节名、或正文里只属于自己的那句话。

### 为什么插件不自己执行压缩

用 `agent.whenIdle()` → `agent.runMaintenance()` → `ctx.compaction.compactNow()`
在回合边界执行压缩，**这个时机窗口赢不了**：

- `compactNow()` 内部就是 `agent.runMaintenance(...)`，phase 不是 idle 时被包成
  `ManualCompactionError('busy', 'manual compaction requires an idle agent with no waking queued work')`
  （`dsh-compaction-basic/lib/index.js:944-969`）；
- turn 边界一开，phase **立刻**变回 `running`；而 `followup()` 自己还会登记"待唤醒工作"。

实测报错：

```
ManualCompactionError: manual compaction requires an idle agent with no waking queued work
```

结论：插件**绝不自行实现压缩算法**（那是重写 DSH 带 8 小节 checkpoint 的逻辑），
但**触发时机必须自己掌握** —— 具体做法见上一节。

## 平面差异（重要）

`ctx.tokenMeter` 与 `ctx.compaction` **只挂在 host 平面**。`dsh-web-app` 的装配里
`compaction-basic` / `command-compact` 被显式 disable（本机已用 profile patch 把
`compaction-basic` 装回）。因此本插件的硬依赖只有
`inject = ['tools', 'systemPrompt', 'llm']`，那两个用 `ctx.get()` 软解析：

- 有计量、有压缩 → 全功能；
- 只有计量 → 能测不能压，工具会明确说明并给出 `/compact` 与自动压缩的真实路径；
- 两者都没有 → 如实降级，**绝不编造百分比、绝不假装压缩过**。

> 为什么 `llm` 必须在 `inject` 里：`readPressure` / `resolveWindow` 要用它解析窗口容量。
> 漏掉它的后果是 `context_compact` 一调用就抛
> `cannot get property "llm" without inject` —— 功能 2 直接不可用（真实发生过）。

## 开发约定（踩过的坑，别重犯）

### 1. 零依赖是硬要求

插件经 junction 暴露后，Node 按 **realpath** 解析依赖。插件目录没有 `node_modules` 时，
`import '@deepseek-ai/dsh-llm'` 会 `ERR_MODULE_NOT_FOUND`，而模块级 import 失败会让 `apply`
永不执行 → fiber 永久 pending → **DSH 起不来**。
所以：只用 `node:` 内置模块，`createUserMessage` / `defineTool` 在本文件内联。

### 2. 绝不直接访问未声明的服务

```js
ctx.tokenMeter        // ✗ 抛 cannot get property "tokenMeter" without inject
ctx.get('tokenMeter') // ✓ 服务不存在时返回 undefined
```

写法与 `inject` 声明必须匹配：写进 `inject` 会在缺该服务的平面上永久挂起；不写又直接属性访问会抛错。
**唯一正确姿势是 `ctx.get()`。**

### 3. WeakMap 的键必须是对象（本插件最致命的一次事故）

```js
const routeBySession = new WeakMap()
routeBySession.set(options.sessionId, ...)   // ✗ 字符串键 → Invalid value used as weak map key
```

它不在于装配阶段炸，而在**首次 `llm/stream` 事件**炸，所以换 `dev_inject_plugin` 还是
`dev_install_package` 都报同一个错、并毒化整个插件树（DSH 直接不可用）。
**字符串键一律用 `new Map()`。**

### 4. 所有注册都过 `register()` 包装

`ctx.on` 在被取消时返回布尔 `true`；原始值一旦进入 cordis 的 `DisposableList`，
`weak.set(true, sn)` 同样抛 WeakMap 错。`register()` 会校验返回值确实是 disposer，
不合法就抛一条**指向本插件、可读的**错误。

### 5. 装配有两条路径，不要同时用

| 路径 | 入口 | 是否持久 | 适用 |
| --- | --- | --- | --- |
| **运行时注入** | `dev_inject_plugin` | ❌ 否（写 registry，重启时重放） | **开发期测试**，试完 `dev_uninject_plugin` 退掉 |
| **bundle 装配** | `dev_install_package` | ✅ 是（写 profile 的 `dependencies` + `bundles`） | **正式安装** |

**两条路径同时生效会让同一个插件被装配两次**（重复提示词段、重复工具注册）。
所以：先用注入验证，再退注入、走 bundle 装配。

**bundle 路径的硬性前提**：`dsh-app-boot` 会校验 `dsh.profile.bundles` 里的每个包
（`dsh-app-boot/lib/index.js:851`）：

```js
const declared = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")).dsh?.bundle?.patch
if (declared === undefined) throw new Error(`profile bundle "X" declares no dsh.bundle in its package.json`)
```

**只要包名在 `bundles` 里而缺少这个声明，DSH 启动就整体失败** —— 比插件崩溃更严重。
本包因此声明 `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`，
`cordis.patch.yml` 即正规装配入口（一条 `insert` 条目），与 `dev_inject_plugin`
指向同一份 `lib/index.js`，行为一致。

**另有一条易漏的坑**：`dev_uninject_plugin` 会往 profile patch 写一条
`- id: <插件> / disabled: true` 阻断自装配。若之后改用 bundle 装配，
**必须先注释掉那条**，否则重启后插件被自己屏蔽。

## 四层防线

| 层 | 内容 | 命令 |
| --- | --- | --- |
| 构建 | 7 项校验（含 bundle 元数据 + WeakMap 键审计）；不过就**拒绝写 lib** | `node scripts/build.mjs` |
| 测试 | **124 项**，含字符串 sessionId 致命回归、③ 的两条触发路径、三道闸、用户意图豁免（5j）、落盘闸自愈路径、超限截断注入、成本回归 | `node test-plugin.mjs` |
| 闭环 | 7 项：检查点正文注入、同代逐字不变、跨代换新 | `node scripts/verify-closed-loop.mjs` |
| 运行时 | `register()` 守卫 + `ctx.get()` 软解析 + 降级分支 + 能力探针 | 内建 |
| 实机 | 压缩**归属权**判据（插件预约 vs DSH 原生兜底）+ 按事件类型/按行号取证 | `node scripts/verify-coupling-live.mjs`、`scripts/list-events.mjs`、`scripts/tail-session.mjs`、`scripts/dump-event.mjs` |

构建刻意**不做编译**（`src/index.js` → `lib/index.js` 是校验后复制）：历史上
「重新构建」曾把手写 lib 覆盖回旧脚手架，直接导致插件挂起。

## 目录

```
src/index.js                        本体（也是构建输入）
lib/index.js                        构建产物（装配入口，必须与 src 逐字节一致）
cordis.patch.yml                    bundle 装配入口
package.json                        含 dsh.bundle.patch 声明（bundle 路径硬性要求）
INSTALL.md                          **分发到别的 DSH 终端**的安装与验收说明（先读这个）
skill/context-checkpoint/           随包分发的技能（SKILL.md + scripts/，导出时从活 skill 同步）
scripts/build.mjs                   校验 + 复制，绝不编译
scripts/install.mjs                 目标机安装器：插件 + bundles + 压缩后端 + skill（幂等 / --check / --uninstall）
scripts/export.mjs                  导出构建器：校验 → 同步 skill → npm pack → 组装 dist → 干净环境冒烟 → 压缩包
scripts/list-events.mjs             按**事件类型**列出事件（解析后比较 type，绕开 shell 引号）
scripts/tail-session.mjs            会话日志尾部取证（尾部 N 行 + 字面子串过滤）
scripts/dump-event.mjs              按行号 dump 事件的**完整 JSON**（--grep 打命中处上下文 + 偏移）
scripts/verify-coupling-live.mjs    实机取证：压缩归属权 + 闭环特征
scripts/verify-closed-loop.mjs      闭环 7 项验证
test-plugin.mjs                     124 项回归（含桩 ctx，忠实模拟 cordis 语义）
dist/context-checkpoint-service-<v>/ 导出产物（目录 + zip，可直接拷给别的终端）
```

> 为什么 `list-events.mjs` 是必需的：`tail-session.mjs` 的过滤参数是对**原始 JSONL 行**做字面子串
> 匹配，想精确匹配 `"type":"system/message"` 就得把双引号传进命令行 —— 而经 PowerShell 传参会把
> 引号吃掉（实际送进去的是空串 → 过滤条件退化成"匹配所有行"，输出看着像没过滤）。`list-events.mjs`
> 改成解析后按 `ev.type` 精确比较，并顺手汇报每条事件里的 `generation: N`。

⚠️ 两个会话日志取证脚本默认**只看本项目目录**（`--E-dsh~0020workplace--`）。
本机同时有多个项目在跑，日志目录是按 mtime 混排的 —— 早先按"最新会话文件"取，
结果行号对得上、内容却是别的项目，取证结论差点作废。要跨项目看时显式加 `--all`。

## 装配（本机走注入；分发到别的终端走 bundle + 安装器）

**分发/移植 → 读 `INSTALL.md`，一条命令：**

```powershell
node scripts/export.mjs                                             # 本机：产出 dist 服务包（目录 + zip）
node install.mjs --dsh-home "<DSH_HOME>" --profile <profile>        # 目标机：装插件 + bundles + 压缩后端 + skill
```

导出包 = **插件 + skill + 安装器**，因为 1-2-3-4 里第 ② 步（落盘 `important_view`）靠 skill 的纪律，
插件只提供工具与注入。安装器是幂等的，支持 `--dry-run` / `--check` / `--uninstall`，
并且导出的 tgz 里含 `skill/`，所以 `npm install <tgz>` 也是完整服务。

**本机（开发态）用运行时注入：**

```powershell
dev_inject_plugin     { "dir": "E:/dsh workplace/context-checkpoint-plugin" }
dev_uninject_plugin   { "match": "context-checkpoint" }
```

> ⚠️ **两条路不要同时用**（同一个插件会被装配两次：工具重复注册、提示词段出现两遍）。
> 本机现在是注入态；`--check` 会如实报告 "bundles 缺条目" —— 那是**刻意**的，不是故障。

**`dev_install_package`（bundle 路径）在本机被证伪** —— 2026-09-23 实测：
DSH Desktop 启动时会重写 profile 的 `package.json`（19:53:02 那次把本包的
`dependencies` 与 `bundles` 条目一起抹掉），而 bundle 路径还额外要求包里有
`dsh.bundle.patch` 声明，缺了会让 DSH **整体启动失败**。插件因此声明了
`"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`，只为不踩那颗雷，
**本机的开发态装配一律走注入**；分发到别的终端才走 bundle，并在装完后用
`node install.mjs --check` 复核条目还在不在（Desktop 会重写）。

⚠️ **改完代码必须重启 DSH**：注入器复用 Node 的 ESM 模块缓存，`uninject → inject`
只换 registry/loader 入口，**不会重新 import 已加载过的模块**。本轮实测：
注入返回 `host ✓`，但 `context_status` 里仍是旧版本的字段（新探针字段一个都没有）。
`dev_reload_package` 在本机直接报 `loader.internal 不可用`，指望不上。
判别方法：重启后看 `context_status` 里有没有这四个字段 ——
`checkpointFresh`、`checkpointAgeMs`、`userIntentWindowMs`（应为 `900000`）、
`recentUserIntent`（`null` 或 `{word, ageMs}`），外加
`capabilityProbe["compaction.compactIfNeeded"] === "present"`。
**只有新版本才有**；旧模块只给出 `checkpointFile` / `checkpointBytes`。

⚠️ **dev 探针会重放**：注入记录写进 registry，重启时全部重放；测完核对 `dev_injected_list`。

## 已知局限

- **需要 profile patch 才拿得到压缩服务**：`ctx.compaction` 在 web 平面默认被
  `dsh-web-app` disable；本机已在 `.dsh/profiles/web/cordis.patch.yml` 加
  `- id: compaction-basic` + `disabled: false` 装回（**重启生效**）。
  回退：改回 `disabled: true` 后重启。
- 压缩**失败或无事可压**时不唤醒续读（不谎报"已压缩"）；预约请求会被清掉，
  由下一次越线提醒重新预约。成功的压缩在回合内是**透明**的：本回合照常继续，无需唤醒。
- 预约有**门槛**（窗口 50%）：占用还低时调用 `context_compact` 只落盘不压缩 ——
  这是刻意的，避免把还在用的历史白白压掉。**但用户本人明确要求总结/落盘/压缩/开始项目时，
  门槛自动让路**（D-006），返回文案会写明是按哪位用户的话放行的；其余情况实机验证请用
  `context_compact { force: true }`。
- 预约还有**落盘闸**（检查点必须是 10 分钟内写过的）：长回合里模型如果在回合开头写了文件、
  到回合末才调用，会被要求**重写一次**再调用。这是刻意选的保守方向 ——
  误伤的代价是多写一次文件，漏判的代价是不可逆地丢结论。`force: true` 可绕过，
  **用户意图豁免不绕过它**（用户要的是"固化状态"，状态没落盘就压缩正好违背他的意图）。
- 用户意图豁免（D-006）的判据是**保守**的：只认真正的用户消息 + 固定词表 + 15 分钟窗口。
  代价是"用户用词很偏"时可能识别不到 —— 退回门槛，不会误触。
