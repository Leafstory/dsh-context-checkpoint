#!/usr/bin/env node
/**
 * 导出构建器：把「上下文检查点 1-2-3-4 全流程」打成一个可交付目录 + 压缩包。
 *
 * 产物（默认在 <包根>/dist/）：
 *   context-checkpoint-service-<version>/           ← 可整体拷给别的 DSH 终端
 *     INSTALL.md                                    目标机安装说明（先读这个）
 *     install.mjs                                   一键安装器
 *     MANIFEST.txt                                  版本、校验和、内容清单
 *     plugin/                                       插件包（含 skill/，与 npm 包内容一致）
 *     skill/context-checkpoint/                     技能（含 scripts/）
 *     tgz/<name>-<version>.tgz                      npm 包（npm install 路径）
 *     README.md
 *   context-checkpoint-service-<version>.zip / .tar.gz
 *
 * 用法：
 *   node scripts/export.mjs                    # 全量：校验 + 测试 + 打包 + 干净环境冒烟
 *   node scripts/export.mjs --skip-tests       # 跳过 124 项回归（只做构建校验）
 *   node scripts/export.mjs --keep-smoke       # 保留冒烟用的临时目录（排障）
 *   node scripts/export.mjs --skill <dir>      # 指定 skill 源目录
 *   node scripts/export.mjs --out <dir>        # 指定 dist 目录
 *   node scripts/export.mjs --no-archive       # 只出目录，不打压缩包
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const selfDir = dirname(fileURLToPath(import.meta.url));
const pkgDir = resolve(selfDir, '..');
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };

const SKIP_TESTS = has('--skip-tests');
const KEEP_SMOKE = has('--keep-smoke');
const NO_ARCHIVE = has('--no-archive');
const OUT_ROOT = resolve(arg('out', join(pkgDir, 'dist')));
const SKILL_NAME = 'context-checkpoint';

const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
const VERSION = pkg.version;
const DIST_NAME = `context-checkpoint-service-${VERSION}`;
const DIST = join(OUT_ROOT, DIST_NAME);
const line = (s = '') => console.log(s);
const fail = (m) => { line(`\n✗ ${m}\n`); process.exit(1); };

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim(), error: r.error };
}
function sha256(file) { return createHash('sha256').update(readFileSync(file)).digest('hex'); }
function sizeOf(p) {
  const st = statSync(p);
  if (st.isFile()) return st.size;
  return readdirSync(p, { withFileTypes: true }).reduce((n, e) => n + sizeOf(join(p, e.name)), 0);
}
const kb = (n) => `${(n / 1024).toFixed(1)} KB`;

function findSkillDir() {
  const explicit = arg('skill', null);
  if (explicit) return resolve(explicit);
  const dshHome = process.env.DSH_HOME ?? join(pkgDir, '..', '.dsh');
  const cands = [join(dshHome, 'skills', SKILL_NAME), join(pkgDir, 'skill', SKILL_NAME)];
  return cands.find((c) => existsSync(join(c, 'SKILL.md'))) ?? null;
}

line(`\n=== 导出「上下文检查点 1-2-3-4」服务包 v${VERSION} ===`);
line(`  包根   ${pkgDir}`);
line(`  产物   ${DIST}`);

// ── 1. 校验与测试（不通过就不导出） ────────────────────────────────────────
line('\n【1/6】构建校验与回归');
if (pkg.dsh?.bundle?.patch === undefined) fail('package.json 缺少 dsh.bundle.patch 声明 —— bundle 装配会让 DSH 起不来，拒绝导出');
{
  const r = run(process.execPath, [join(selfDir, 'build.mjs'), '--check'], { cwd: pkgDir });
  if (r.code !== 0) fail(`build --check 未通过：\n${r.out}`);
  line(`  ✓ build --check 通过`);
}
if (SKIP_TESTS) line('  · --skip-tests：跳过回归');
else {
  const r = run(process.execPath, [join(pkgDir, 'test-plugin.mjs')], { cwd: pkgDir });
  const m = /共 (\d+) 项，PASS (\d+)，FAIL (\d+)/.exec(r.out);
  if (r.code !== 0 || !m || m[3] !== '0') fail(`回归未通过：\n${r.out.split('\n').slice(-15).join('\n')}`);
  line(`  ✓ 回归 ${m[2]}/${m[1]} 通过`);
  globalThis.__tests = `${m[2]}/${m[1]}`;
}

// ── 2. 同步 skill（随包分发） ───────────────────────────────────────────────
line('\n【2/6】同步技能');
const skillSrc = findSkillDir();
if (skillSrc === null) fail(`找不到 skill 源目录。用 --skill <dir> 指定（形如 <DSH_HOME>/skills/${SKILL_NAME}）`);
const vendored = join(pkgDir, 'skill', SKILL_NAME);
const srcSkillHash = sha256(join(skillSrc, 'SKILL.md'));
const vendoredHash = existsSync(join(vendored, 'SKILL.md')) ? sha256(join(vendored, 'SKILL.md')) : null;
if (vendoredHash !== srcSkillHash) {
  rmSync(vendored, { recursive: true, force: true });
  mkdirSync(dirname(vendored), { recursive: true });
  cpSync(skillSrc, vendored, { recursive: true });
  line(`  ✓ 从 ${skillSrc} 同步进包（${vendoredHash === null ? '首次' : '内容有更新'}）`);
} else line(`  ✓ 包内 skill 与源一致（${srcSkillHash.slice(0, 12)}）`);
for (const s of ['scripts/checkpoint.mjs', 'scripts/test-checkpoint.mjs', 'scripts/test-skill-template.mjs', 'SKILL.md']) {
  if (!existsSync(join(vendored, s))) fail(`skill 缺文件：${s}`);
}
line(`  ✓ skill 组成完整（SKILL.md + 3 个脚本）`);

// ── 3. 组装 dist 目录 ──────────────────────────────────────────────────────
line('\n【3/6】组装交付目录');
rmSync(DIST, { recursive: true, force: true });
mkdirSync(join(DIST, 'plugin'), { recursive: true });
mkdirSync(join(DIST, 'skill'), { recursive: true });
mkdirSync(join(DIST, 'tgz'), { recursive: true });

// 插件包目录：按 package.json 的 files 白名单复制（与 npm 包内容一致）
const allow = [...(pkg.files ?? []), 'package.json'];
for (const entry of allow) {
  const src = join(pkgDir, entry);
  if (!existsSync(src)) fail(`files 里列了但不存在：${entry}`);
  cpSync(src, join(DIST, 'plugin', entry), { recursive: true, filter: (p) => basename(p) !== 'node_modules' });
}
line(`  ✓ plugin/ ← ${allow.join(', ')}`);

cpSync(join(skillSrc, ''), join(DIST, 'skill', SKILL_NAME), { recursive: true });
line(`  ✓ skill/${SKILL_NAME}/ ← ${skillSrc}`);
for (const f of ['INSTALL.md', 'README.md']) {
  if (!existsSync(join(pkgDir, f))) fail(`缺少 ${f}`);
  cpSync(join(pkgDir, f), join(DIST, f));
}
cpSync(join(selfDir, 'install.mjs'), join(DIST, 'install.mjs'));
line('  ✓ INSTALL.md / README.md / install.mjs');

// ── 4. npm pack（供 npm install 路径） ─────────────────────────────────────
line('\n【4/6】npm 包（tgz）');
{
  // Windows 下 npm 是 .cmd：直接 spawn 会 EINVAL，得走 shell。
  // 注意别写成 spawnSync('npm', [...], { shell: true }) —— Node 会报 DEP0190（args 不转义）。
  // 用整条命令字符串 + shell 才是干净写法（命令完全由本脚本拼出，无外部输入）。
  const q = process.platform === 'win32'
    ? spawnSync('npm pack --silent', { cwd: pkgDir, encoding: 'utf8', shell: true })
    : spawnSync('npm', ['pack', '--silent'], { cwd: pkgDir, encoding: 'utf8' });
  const r = { code: q.status, out: `${q.stdout ?? ''}${q.stderr ?? ''}`.trim() };
  if (r.code !== 0) fail(`npm pack 失败：\n${r.out}`);
  const tgzName = r.out.split('\n').map((s) => s.trim()).filter((s) => s.endsWith('.tgz')).pop() ?? `${pkg.name.replace(/^@/, '').replace('/', '-')}-${VERSION}.tgz`;
  const from = join(pkgDir, tgzName);
  if (!existsSync(from)) fail(`npm pack 报告了 ${tgzName}，但文件不在 ${pkgDir}`);
  renameSync(from, join(DIST, 'tgz', tgzName));
  globalThis.__tgz = join(DIST, 'tgz', tgzName);
  line(`  ✓ ${tgzName}（${kb(sizeOf(globalThis.__tgz))}）`);
}

// ── 5. 交付目录自检 + 干净环境冒烟安装 ─────────────────────────────────────
line('\n【5/6】交付目录自检 + 干净环境冒烟');
{
  const libInDist = join(DIST, 'plugin', 'lib', 'index.js');
  const srcInDist = join(DIST, 'plugin', 'src', 'index.js');
  if (sha256(libInDist) !== sha256(srcInDist)) fail('交付目录里 src ≠ lib（构建产物不一致）');
  line('  ✓ plugin：src ≡ lib（逐字节）');
  const imports = [...readFileSync(libInDist, 'utf8').matchAll(/^\s*import[^'"]*['"]([^'"]+)['"]/gm)].map((m) => m[1]);
  const external = imports.filter((s) => !s.startsWith('node:'));
  if (external.length) fail(`交付目录的 lib 有外部依赖：${external.join(', ')}`);
  line(`  ✓ plugin：零外部依赖（${[...new Set(imports)].join(', ')}）`);
  for (const f of [join(DIST, 'install.mjs'), join(DIST, 'skill', SKILL_NAME, 'scripts', 'checkpoint.mjs')]) {
    const r = run(process.execPath, ['--check', f]);
    if (r.code !== 0) fail(`语法错误 ${f}：${r.out}`);
  }
  line('  ✓ install.mjs 与 skill 脚本语法通过');

  // 冒烟：造一个干净的假 DSH_HOME，真装一遍
  const smoke = join(tmpdir(), `cc-export-smoke-${Date.now()}`);
  const fakeHome = join(smoke, '.dsh');
  const fakeProfile = join(fakeHome, 'profiles', 'web');
  mkdirSync(fakeProfile, { recursive: true });
  mkdirSync(join(fakeHome, 'skills'), { recursive: true });
  writeFileSync(join(fakeProfile, 'package.json'),
    `${JSON.stringify({ name: 'dsh-profile-web', private: true, dependencies: {}, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } } }, null, 2)}\n`, 'utf8');
  // 故意写成 disabled: true，验证安装器**真的会把它翻过来**
  writeFileSync(join(fakeProfile, 'cordis.patch.yml'), '- id: compaction-basic\n  disabled: true\n', 'utf8');

  const env = { ...process.env, DSH_HOME: '' };
  const first = run(process.execPath, [join(DIST, 'install.mjs'), '--dsh-home', fakeHome, '--profile', 'web', '--mode', 'copy', '--tgz', globalThis.__tgz], { env });
  if (first.code !== 0) fail(`冒烟安装失败（干净环境装不上 = 不能交付）：\n${first.out}`);
  line('  ✓ 干净 DSH_HOME：安装器退出码 0（校验全过）');

  // 断言落地结果
  const fp = JSON.parse(readFileSync(join(fakeProfile, 'package.json'), 'utf8'));
  const bundles = fp.dsh.profile.bundles;
  if (bundles.filter((n) => n === pkg.name).length !== 1) fail('冒烟：bundles 里本插件条目不是恰好 1 条');
  if (!fp.dependencies[pkg.name]) fail('冒烟：dependencies 缺声明');
  if (!/disabled:\s*false/.test(readFileSync(join(fakeProfile, 'cordis.patch.yml'), 'utf8'))) fail('冒烟：compaction-basic 没被启用');
  if (!existsSync(join(fakeProfile, 'node_modules', pkg.name, 'lib', 'index.js'))) fail('冒烟：插件包没落位');
  if (!existsSync(join(fakeHome, 'skills', SKILL_NAME, 'SKILL.md'))) fail('冒烟：skill 没落位');
  line('  ✓ 落地断言：bundles 恰好 1 条 / dependencies 已声明 / compaction-basic 已启用 / 插件与 skill 都在位');

  // 幂等：再装一次，不应产生重复
  const second = run(process.execPath, [join(DIST, 'install.mjs'), '--dsh-home', fakeHome, '--profile', 'web'], { env });
  const fp2 = JSON.parse(readFileSync(join(fakeProfile, 'package.json'), 'utf8'));
  if (second.code !== 0 || fp2.dsh.profile.bundles.filter((n) => n === pkg.name).length !== 1) fail('冒烟：第二次安装不幂等');
  line('  ✓ 幂等：第二次安装后 bundles 仍恰好 1 条');

  // 体检模式：应报"都就位"
  const chk = run(process.execPath, [join(DIST, 'install.mjs'), '--check', '--dsh-home', fakeHome, '--profile', 'web'], { env });
  if (chk.code !== 0) fail(`冒烟：--check 在装好的环境里应通过，实际失败：\n${chk.out}`);
  line('  ✓ --check 在装好的环境里判为"四件都就位"');

  // 卸载：应摘干净
  const un = run(process.execPath, [join(DIST, 'install.mjs'), '--uninstall', '--dsh-home', fakeHome, '--profile', 'web'], { env });
  const fp3 = JSON.parse(readFileSync(join(fakeProfile, 'package.json'), 'utf8'));
  if (un.code !== 0 || fp3.dsh.profile.bundles.includes(pkg.name) || fp3.dependencies[pkg.name]) fail('冒烟：卸载没摘干净');
  if (existsSync(join(fakeProfile, 'node_modules', pkg.name))) fail('冒烟：卸载后包目录还在');
  if (existsSync(join(fakeHome, 'skills', SKILL_NAME))) fail('冒烟：卸载后 skill 还在');
  line('  ✓ 卸载：bundles/dependencies 条目、包目录、skill 全部摘除');

  if (KEEP_SMOKE) line(`  · 冒烟目录保留：${smoke}`);
  else rmSync(smoke, { recursive: true, force: true });
}

// ── 6. MANIFEST + 压缩包 ───────────────────────────────────────────────────
line('\n【6/6】清单与压缩包');
const tgzRel = relative(DIST, globalThis.__tgz).replace(/\\/g, '/');
const manifest = [
  `上下文检查点 1-2-3-4 服务包`,
  `================`,
  `包名      ${pkg.name}`,
  `版本      ${VERSION}`,
  `导出时间  ${new Date().toISOString()}`,
  `回归      ${globalThis.__tests ?? '(跳过)'}`,
  ``,
  `闭环四步与责任方`,
  `  ① 达限   插件（占用条 + 越线提醒）`,
  `  ② 总结   skill context-checkpoint（写 important_view）+ 插件工具 context_compact`,
  `  ③ 压缩   插件触发 DSH 原生引擎（需 profile 启用 compaction-basic）`,
  `  ④ 注入   插件静态提示词段（跨代刷新）`,
  ``,
  `内容`,
  `  install.mjs                        一键安装器（幂等 / --dry-run / --check / --uninstall）`,
  `  INSTALL.md                         安装与验收说明`,
  `  plugin/                            插件包（含 skill/，与 npm 包一致）`,
  `  skill/${SKILL_NAME}/              技能（SKILL.md + scripts/）`,
  `  tgz/${basename(tgzRel)}   npm 包`,
  ``,
  `校验和（sha256）`,
  `  plugin/lib/index.js                ${sha256(join(DIST, 'plugin', 'lib', 'index.js'))}`,
  `  plugin/src/index.js                ${sha256(join(DIST, 'plugin', 'src', 'index.js'))}`,
  `  skill/${SKILL_NAME}/SKILL.md        ${srcSkillHash}`,
  `  install.mjs                        ${sha256(join(DIST, 'install.mjs'))}`,
  `  ${tgzRel}  ${sha256(globalThis.__tgz)}`,
  ``,
  `安装（目标机）`,
  `  node install.mjs --dsh-home "<DSH_HOME>" --profile <profile>`,
  `  装完必须重启 DSH；验收判据见 INSTALL.md`,
  ``,
].join('\n');
writeFileSync(join(DIST, 'MANIFEST.txt'), manifest, 'utf8');
line('  ✓ MANIFEST.txt（含 sha256）');

if (!NO_ARCHIVE) {
  mkdirSync(OUT_ROOT, { recursive: true });
  const zipPath = join(OUT_ROOT, `${DIST_NAME}.zip`);
  rmSync(zipPath, { force: true });
  // Windows 上用 Compress-Archive（用户最顺手）；失败就退 tar.gz，两者都不成则只留目录
  const zr = spawnSync('powershell', ['-NoProfile', '-Command', `Compress-Archive -Path "${DIST}" -DestinationPath "${zipPath}" -Force`], { encoding: 'utf8' });
  if (zr.status === 0 && existsSync(zipPath)) line(`  ✓ ${basename(zipPath)}（${kb(sizeOf(zipPath))}）`);
  else {
    const tarPath = join(OUT_ROOT, `${DIST_NAME}.tar.gz`);
    const tr = spawnSync('tar', ['-czf', tarPath, '-C', OUT_ROOT, DIST_NAME], { encoding: 'utf8' });
    if (tr.status === 0 && existsSync(tarPath)) line(`  · zip 失败（${(zr.stderr ?? '').trim().slice(0, 120)}），改用 tar.gz：${basename(tarPath)}（${kb(sizeOf(tarPath))}）`);
    else line('  ! 两种压缩包都没打成 —— 直接交付目录即可');
  }
}

line(`\n=== 导出完成 ===`);
line(`  目录  ${DIST}（${kb(sizeOf(DIST))}）`);
line(`  安装  node install.mjs --dsh-home "<DSH_HOME>" --profile <profile>`);
line(`  已通过：构建校验 / 回归 / 干净环境冒烟（含幂等、--check、卸载）\n`);
