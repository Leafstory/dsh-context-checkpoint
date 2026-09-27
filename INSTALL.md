# 安装：把「上下文检查点 1-2-3-4」装进一个 DSH 终端

本包装的是**完整服务**，不是单个插件 —— 四步闭环各由谁负责：

| 步 | 做什么 | 由谁提供 |
| --- | --- | --- |
| ① 达限 | 每步注入真实占用条；跨档位提醒落盘 | 插件（`lib/index.js` + 静态提示词段） |
| ② 总结 | 把项目状态写进 `important_view.<task>-<session>.md`（落盘才会被注入） | **skill `context-checkpoint`** + 插件的 `context_compact` 工具 |
| ③ 压缩 | 在**下一个步骤边界**用 DSH 原生引擎压缩（`'context-overflow'` 绕过阈值） | 插件触发 + **profile 里启用 `compaction-basic`** |
| ④ 注入 | 压缩后把检查点正文重新注入为静态上下文（跨代刷新） | 插件 |

## 前提

- DSH 已装好、能启动（Node 随 DSH 自带即可，脚本零外部依赖）。
- 知道两个值：`DSH_HOME`（默认 `~/.dsh`，也可以是任意自定义目录，如 `D:\dsddata\.dsh`）与目标 **profile 名**
  （`<DSH_HOME>/profiles/` 下的目录名，常见 `web` / `desktop`）。

## 安装（一条命令）

把本目录（或解压后的目录）拷到目标机，然后：

```powershell
node install.mjs --dsh-home "<DSH_HOME>" --profile <profile>            # 安装
node install.mjs --dsh-home "<DSH_HOME>" --profile <profile> --dry-run  # 先看要改什么
node install.mjs --dsh-home "<DSH_HOME>" --profile <profile> --check    # 只体检，不写
node install.mjs --dsh-home "<DSH_HOME>" --profile <profile> --uninstall
```

不带 `--dsh-home` 时会按 `$DSH_HOME` → 上级 `.dsh` → `~/.dsh` 依次探测；profile 只有一个时自动选中。

它会做四件事（幂等、写前先备份为 `*.context-checkpoint.bak`）：

| # | 动作 | 位置 |
| --- | --- | --- |
| 1 | 复制插件包 | `<profile>/node_modules/@dsh-external/context-checkpoint/` |
| 2 | 声明装配 | `<profile>/package.json` 的 `dependencies` + `dsh.profile.bundles` |
| 3 | 启用压缩后端 | `<profile>/cordis.patch.yml` 里 `compaction-basic: disabled: false`（没它就没有第 ③ 步） |
| 4 | 投放技能 | `<DSH_HOME>/skills/context-checkpoint/`（SKILL.md + scripts/） |

装完**必须重启 DSH**（装配只在启动时组合）。

## 装完怎么验收（四条，都可复制）

1. **插件在跑** —— 调用 `context_status`，应看到这四个字段（旧版没有）：
   `checkpointFresh`、`checkpointAgeMs`、`userIntentWindowMs: 900000`、`recentUserIntent`。
2. **第 ③ 步压得动** —— 同一返回里
   `capabilityProbe["compaction.compactIfNeeded"] === "present"` 且 `capabilityProbe.compaction === "present"`。
3. **自然路径**（不需要任何 `force`）—— 在占用**远低于 50%** 时直接对模型说
   「总结一下本轮」，应看到
   `Compaction scheduled (on the user's explicit request: "…")`；
   随后 `context_status.recentUserIntent` 报出命中词。
4. **第 ④ 步真的换了内容** —— 压缩后新铸的提示词段里应带上新一代码次：

   ```powershell
   node "$env:DSH_HOME\profiles\<profile>\node_modules\@dsh-external\context-checkpoint\scripts\list-events.mjs" `
     system/message --last 3 --grep "generation:"
   ```

## 卸载

```powershell
node install.mjs --dsh-home "<DSH_HOME>" --profile <profile> --uninstall
```

移除 bundles/dependencies 条目、`node_modules` 里的包、以及 skill 目录；
**保留**所有 `*.context-checkpoint.bak` 备份。第 ③ 步的 patch 条目不动（要回退就删掉
`compaction-basic` 那段，或从备份恢复后重启）。

## 排障

| 症状 | 原因 / 对策 |
| --- | --- |
| 重启后 `context_status` 字段没变多 | 跑一次 `--check`；多半是 `bundles` 条目没写进去，或插件被装配了两次 |
| `bundles` 条目**消失了** | 目标终端是 **DSH Desktop**：它启动时会重写 profile 的 `package.json`（本机实测会抹掉条目）。对策：再跑一次安装器，或改用 `dev_inject_plugin` 注入 |
| 能测占用、压不动 | `compaction-basic` 没启用 → 第 ③ 步的服务缺失，重跑安装器（别加 `--no-compaction-patch`） |
| 工具重复注册 / 提示词段出现两遍 | **两条装配路同时生效**（注入器 + bundle）。先 `dev_uninject_plugin`，只留一条 |
| DSH 起不来、报 `declares no dsh.bundle` | 包的 `package.json` 缺 `dsh.bundle.patch` 声明 —— 本安装器会在写 **之前**挡住这种情况 |
| 模型不主动落盘 | skill 没生效：确认 `<DSH_HOME>/skills/context-checkpoint/SKILL.md` 在，且会话里能 `skill context-checkpoint` |

## 给 agent 的说明（如果你是另一个终端的 agent）

1. 先 `node install.mjs --check` 看现状，再决定装/不装；**别在没看现状前直接写**。
2. 装完**让用户自己重启**（重启是用户的动作）。
3. 验收按上面四条，**逐条拿证据**，不要凭"应该生效了"下结论。
4. 这个插件的核心禁忌：提示词段里**不能有动态值**（会毁掉 prompt 缓存）、
   插件**不自行实现压缩**（用 DSH 原生引擎）、**别同时用两条装配路径**。
