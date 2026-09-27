#!/usr/bin/env node
/**
 * 检查指定会话里插件的实际状态（只读）。
 * 用法: node scripts/check-one-session.mjs <session.v3.jsonl.zstd> [...more]
 */
import { readFileSync, statSync } from 'node:fs';
import { zstdDecompressSync } from 'node:zlib';

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

function decompressAllFrames(file) {
  const buf = readFileSync(file);
  const offsets = [];
  let i = buf.indexOf(MAGIC, 0);
  while (i !== -1) { offsets.push(i); i = buf.indexOf(MAGIC, i + 4); }
  const parts = [];
  for (let k = 0; k < offsets.length; k += 1) {
    const s = offsets[k];
    const e = k + 1 < offsets.length ? offsets[k + 1] : buf.length;
    try { parts.push(zstdDecompressSync(buf.subarray(s, e))); } catch { /* 不完整帧跳过 */ }
  }
  return { text: Buffer.concat(parts).toString('utf8'), frames: offsets.length };
}

for (const file of process.argv.slice(2)) {
  console.log(`\n════ ${file}`);
  console.log(`     磁盘修改时间: ${statSync(file).mtime.toLocaleString()}`);
  let text;
  let frames;
  try { ({ text, frames } = decompressAllFrames(file)); }
  catch (error) { console.log(`     解压失败: ${String(error).slice(0, 100)}`); continue; }
  console.log(`     ${frames} 帧 / ${text.length} 字符`);

  const barTitle = '上下文占用（由 context-checkpoint';
  const at = text.indexOf(barTitle);
  console.log(`     占用条: ${at === -1 ? '✗ 未找到' : '✓ 找到'}`);
  if (at !== -1) {
    console.log('     ── 占用条原文 ──');
    console.log(text.slice(at, at + 520).split('\\n').map((l) => `     ${l}`).join('\n'));
  }
  for (const needle of ['context_status', 'context_compact', 'context-checkpoint ready', 'context-checkpoint:pressure']) {
    console.log(`     ${needle}: ${text.includes(needle) ? '✓' : '✗'}`);
  }
  const ready = text.match(/context-checkpoint ready: meter=[^\\\s]*\s*compactor=[^\\\s]*/);
  if (ready) console.log(`     ready 行: ${ready[0]}`);
}
