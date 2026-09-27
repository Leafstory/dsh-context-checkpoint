/**
 * 取证脚本的路径解析。
 *
 * 为什么要有这一层：这些脚本原本把**开发机的绝对路径**直接写成默认值 ——
 * 既泄露了那台机器的用户名与目录结构，别人拿去也跑不通。
 * 这里统一改成**环境变量优先 + 自动推断**。
 *
 * 环境变量（都可选）：
 *   DSH_HOME               DSH 数据根（默认 `~/.dsh`）
 *   DSH_PROFILE            profile 名（默认 `web`）
 *   DSH_SESSIONS           会话日志根（默认 `<cwd>/.dsh/sessions` → `<DSH_HOME>/sessions`）
 *   DSH_PROJECT_SESSIONS   直接指定项目会话目录（跳过推断）
 *   DSH_DESKTOP_APP        DSH Desktop 的 `resources/app` 路径（只有 bundle/桌面相关脚本用）
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DSH_HOME = process.env.DSH_HOME ? resolve(process.env.DSH_HOME) : join(homedir(), '.dsh');
export const PROFILE = process.env.DSH_PROFILE ?? 'web';

/**
 * DSH 把项目路径编码成会话目录名：`D:\my projects\demo` → `--D-my~0020projects-demo--`
 * （去掉盘符冒号、分隔符统一成 `-`、空格写成 `~0020`、两端加 `--`）。
 */
export function slugFor(dir) {
  return `--${resolve(dir).replace(/:/g, '').replace(/[\\/]+/g, '-').replace(/ /g, '~0020')}--`;
}

/** 会话日志根目录。 */
export function resolveSessionsRoot() {
  if (process.env.DSH_SESSIONS) return resolve(process.env.DSH_SESSIONS);
  const local = join(process.cwd(), '.dsh', 'sessions');
  if (existsSync(local)) return local;
  return join(DSH_HOME, 'sessions');
}

/**
 * 当前项目的会话目录。
 * ⚠️ 从 cwd **逐级向上**试 slug：脚本常在子目录里跑（如 `<项目>/插件目录`），
 * 只按 cwd 算会匹配不到，退化成"扫全部项目"—— 那正是历史上取错会话的坑。
 */
export function resolveProjectSessions() {
  if (process.env.DSH_PROJECT_SESSIONS) return resolve(process.env.DSH_PROJECT_SESSIONS);
  const root = resolveSessionsRoot();
  let cur = process.cwd();
  for (let i = 0; i < 8; i += 1) {
    const cand = join(root, slugFor(cur));
    if (existsSync(cand)) return cand;
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return root;   // 推断不出就退回会话根
}

/** profile 目录与它的 patch 文件。 */
export function resolveProfileDir() { return join(DSH_HOME, 'profiles', PROFILE); }
export function resolveProfilePatch() { return join(resolveProfileDir(), 'cordis.patch.yml'); }

/** 本仓库根（`scripts/` 的上一级）。 */
export function resolveSelfProject() { return resolve(dirname(fileURLToPath(import.meta.url)), '..'); }

/** DSH Desktop 的 `resources/app`；未设 `DSH_DESKTOP_APP` 时返回空串（调用方的 existsSync 会自然失败）。 */
export function resolveDesktopApp() {
  return process.env.DSH_DESKTOP_APP ? resolve(process.env.DSH_DESKTOP_APP) : '';
}
export function resolveDesktopAppFile(rel) { return join(resolveDesktopApp(), rel); }
export function resolveDesktopAppModules() { return join(resolveDesktopApp(), 'node_modules'); }
export function resolveDesktopAppModule(name) { return join(resolveDesktopAppModules(), name); }
