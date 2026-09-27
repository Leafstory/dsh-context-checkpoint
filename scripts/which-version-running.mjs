#!/usr/bin/env node
/**
 * 判别运行中的插件版本（只读）。
 * 用法: node scripts/which-version-running.mjs [sessionsDir]
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { zstdDecompressSync } from 'node:zlib';
import { join } from 'node:path';
import { resolveProjectSessions } from './paths.mjs';

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const dir = process.argv[2] ?? resolveProjectSessions();

function decompress(file) {
  const buf = readFileSync(file);
  const offsets = [];
  let i = buf.indexOf(MAGIC, 0);
  while (i !== -1) { offsets.push(i); i = buf.indexOf(MAGIC, i + 4); }
  const parts = [];
  for (let k = 0; k < offsets.length; k += 1) {
    const s = offsets[k];
    const e = k + 1 < offsets.length ? offsets[k + 1] : buf.length;
    try { parts.push(zstdDecompressSync(buf.subarray(s, e))); } catch { /* skip */ }
  }
  return Buffer.concat(parts).toString('utf8');
}

const sessions = [];
const walk = (p) => {
  for (const entry of readdirSync(p, { withFileTypes: true })) {
    const full = join(p, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (/session.*\.jsonl\.zstd$/.test(entry.name)) sessions.push({ file: full, mtime: statSync(full).mtimeMs });
  }
};
walk(dir);
sessions.sort((a, b) => b.mtime - a.mtime);

const { file, mtime } = sessions[0];
const text = decompress(file);
console.log(`最新会话: ${join(file).split(/[\\/]/).slice(-2)[0]}`);
console.log(`磁盘时间: ${new Date(mtime).toLocaleString()}\n`);

const probes = [
  ['新占用条文案（含「不等于压缩次数」）', /表层已被替换（surface replace）\d+ 次/g],
  ['旧占用条文案（已压缩 N 次）', /本会话已压缩 \d+ 次/g],
  ['新状态字段 surfaceReplaceCount', /surfaceReplaceCount/g],
  ['旧状态字段 compactionGeneration', /compactionGeneration/g],
  ['降级文案 NO compaction service', /NO compaction service/g],
  ['预约文案 Compaction scheduled', /Compaction scheduled/g],
  ['压缩事件 compaction\/summary', /compaction\/summary/g]
];
for (const [label, re] of probes) {
  const hits = (text.match(re) ?? []).length;
  console.log(`${hits > 0 ? '✓' : '✗'} ${label} -> ${hits} 处`);
}

console.log('\n说明：新文案计数 > 0 且出现在真实渲染（带数字）里，才说明新版在跑；');
console.log('      仅出现在源码模板里的命中不算。');
