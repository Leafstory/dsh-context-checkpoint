#!/usr/bin/env node
/**
 * 检测插件是否真的进入当前会话（只读）。
 *
 * 关键点：DSH 会话文件是 **多帧拼接** 的 zstd。
 *   - zstdDecompressSync 只解第一帧（实测只出 ~200 字节）
 *   - zlib 的 zstd 流遇到帧边界会 stop，同样拿不全
 * 正确做法：手动逐帧解压 —— 按 zstd 魔数 28 B5 2F FD 切分，逐帧解压后拼接。
 *
 * 用法: node scripts/check-session-for-plugin.mjs [sessionsDir] [topN]
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { zstdDecompressSync } from 'node:zlib';
import { join } from 'node:path';
import { resolveProjectSessions } from './paths.mjs';

const dir = process.argv[2] ?? resolveProjectSessions();
const topN = Number(process.argv[3] ?? 3);
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/** 按 zstd 魔数切帧，逐帧解压后拼接。 */
function decompressAllFrames(file) {
  const buf = readFileSync(file);
  const offsets = [];
  let i = buf.indexOf(MAGIC, 0);
  while (i !== -1) {
    offsets.push(i);
    i = buf.indexOf(MAGIC, i + 4);
  }
  if (offsets.length === 0) throw new Error('未找到 zstd 帧');
  const parts = [];
  for (let k = 0; k < offsets.length; k += 1) {
    const start = offsets[k];
    const end = k + 1 < offsets.length ? offsets[k + 1] : buf.length;
    try {
      parts.push(zstdDecompressSync(buf.subarray(start, end)));
    } catch {
      // 某些帧可能不完整（写入中），跳过
    }
  }
  return { text: Buffer.concat(parts).toString('utf8'), frames: offsets.length };
}

function collectSessions(root) {
  const out = [];
  const walk = (p) => {
    for (const entry of readdirSync(p, { withFileTypes: true })) {
      const full = join(p, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/session.*\.jsonl\.zstd$/.test(entry.name)) out.push({ file: full, mtime: statSync(full).mtimeMs });
    }
  };
  walk(root);
  return out.sort((a, b) => b.mtime - a.mtime).slice(0, topN);
}

if (!existsSync(dir)) {
  console.error(`会话目录不存在: ${dir}`);
  process.exit(2);
}

console.log(`会话目录: ${dir}\n`);
let loaded = false;
for (const { file, mtime } of collectSessions(dir)) {
  let text;
  let frames;
  try {
    ({ text, frames } = decompressAllFrames(file));
  } catch (error) {
    console.log(`  ? ${new Date(mtime).toISOString()} 解压失败: ${String(error).slice(0, 80)}`);
    continue;
  }
  const hasBar = text.includes('上下文占用');
  const hasName = text.includes('context-checkpoint');
  const hasTools = text.includes('context_status') && text.includes('context_compact');
  const ready = text.includes('context-checkpoint ready');
  const capability = text.match(/context-checkpoint ready: meter=(\S+) compactor=(\S+)/);
  if (hasBar || hasTools) loaded = true;
  console.log(`  ${new Date(mtime).toISOString()}  ${frames} 帧 / ${text.length} 字符`);
  console.log(`      占用条: ${hasBar ? '✓' : '✗'}   插件名: ${hasName ? '✓' : '✗'}   工具schema: ${hasTools ? '✓' : '✗'}   ready: ${ready ? '✓' : '✗'}`);
  if (capability) console.log(`      插件自报能力: meter=${capability[1]}  compactor=${capability[2]}`);
  if (hasBar) {
    const at = text.indexOf('上下文占用');
    console.log(`      片段: ${text.slice(at, at + 220).replace(/\\n/g, ' ').replace(/\s+/g, ' ')}`);
  }
}

console.log(loaded
  ? '\n结论：检测到插件已在会话中生效。'
  : '\n结论：最近会话中未检测到插件 —— 仍未生效。');
process.exitCode = loaded ? 0 : 1;
