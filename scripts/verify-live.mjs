#!/usr/bin/env node
/**
 * 判定插件在最新一次运行里是否真的进入了协议（只读）。
 *
 * 只看两件事，都是模型可见的事实：
 *   1. request/header 的 tools[] 里有没有 context_status / context_compact
 *   2. 系统提示词里有没有渲染后的占用条（带具体数字，不是源码模板）
 *
 * 用法: node scripts/verify-live.mjs [sessionsDir]
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

console.log(`检查最近 ${Math.min(3, sessions.length)} 个会话\n`);
for (const { file, mtime } of sessions.slice(0, 3)) {
  const text = decompress(file);
  const lines = text.split('\n').filter((l) => l.trim());

  // 1) 工具是否在协议里（逐条 header 找）
  let headers = 0;
  let headersWithTools = 0;
  let toolCount = -1;
  for (const line of lines) {
    if (!line.includes('"request/header"')) continue;
    headers += 1;
    if (!line.includes('"context_status"')) continue;
    headersWithTools += 1;
    if (toolCount === -1) {
      try {
        const ev = JSON.parse(line);
        const tools = ev.data?.header?.tools ?? ev.header?.tools ?? [];
        toolCount = tools.length;
      } catch { /* ignore */ }
    }
  }

  // 2) 渲染后的占用条（带数字）
  const renderedBars = (text.match(/已用：[\d,]+ token/g) ?? []).length;
  const newText = (text.match(/表层已被替换（surface replace）\d+ 次/g) ?? []).length;
  const oldText = (text.match(/本会话已压缩 \d+ 次/g) ?? []).length;

  console.log(`${new Date(mtime).toLocaleString()}  ${join(file).split(/[\\/]/).slice(-2)[0].slice(0, 34)}`);
  console.log(`    request/header: ${headers} 个，其中含本插件工具: ${headersWithTools} 个${toolCount > 0 ? `（工具总数 ${toolCount}）` : ''}`);
  console.log(`    渲染后的占用条: ${renderedBars} 处（真实用量行）`);
  console.log(`    占用条版本: 新版(表层已被替换)=${newText}  旧版(本会话已压缩)=${oldText}`);
  const verdict = headersWithTools > 0 ? '✅ 插件已进入协议' : '❌ 未进入协议';
  console.log(`    → ${verdict}\n`);
}
