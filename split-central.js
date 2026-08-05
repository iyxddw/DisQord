#!/usr/bin/env node
/**
 * split-central.js —— 把旧版 DisQord 中央存储 central.json（单一文件）拆分为追加式存储格式。
 *
 * 输出（默认写到 central.json 所在目录）：
 *   trace-log.ndjson            日志，追加式，保留最近 2000 行
 *   message-history.ndjson      历史，追加式，保留最近 5000 行
 *   blueprint-activity.ndjson   活动，追加式，保留最近 5000 行
 *   state.ndjson                其余全部状态类命名空间
 *
 * 执行后原文件会被改名为 central.migrated-<时间戳>.json（保留备份，不删除）。
 *
 * 用法：
 *   node split-central.js /path/to/central.json [输出目录]
 *
 * 建议先备份：cp central.json central.bak.json
 */
'use strict';

const fs = require('fs');
const path = require('path');

// 追加类命名空间：只追加、只读近期、按行数保留
const CAPS = {
  'trace-log': 2000,
  'message-history': 5000,
  'blueprint-activity': 5000,
};
const APPEND_NS = new Set(Object.keys(CAPS));

// ---------- 参数 ----------
const [, , centralArg, outArg] = process.argv;
const centralPath = path.resolve(centralArg || 'central.json');
if (!fs.existsSync(centralPath)) {
  console.error(`[split] 找不到 ${centralPath}`);
  process.exit(1);
}
const outDir = path.resolve(outArg || path.dirname(centralPath));
fs.mkdirSync(outDir, { recursive: true });

// 防误跑：输出目录里已有拆分产物时报错
for (const f of [...Object.keys(CAPS), 'state'].map((n) => `${n}.ndjson`)) {
  if (fs.existsSync(path.join(outDir, f))) {
    console.error(`[split] ${outDir}/${f} 已存在，看起来已经拆分过了。请先确认，避免覆盖。`);
    process.exit(1);
  }
}

// ---------- 1. 读旧文件 ----------
console.log(`[split] 读取 ${centralPath} ...`);
let doc;
try {
  doc = JSON.parse(fs.readFileSync(centralPath, 'utf8'));
} catch (e) {
  console.error(`[split] 解析失败：${e.message}`);
  process.exit(1);
}
if (!doc || doc.version !== 1 || !doc.namespaces) {
  console.error('[split] 不是预期的 central.json 格式（version: 1 + namespaces）');
  process.exit(1);
}

const namespaces = doc.namespaces;
const nsNames = Object.keys(namespaces);
console.log(`[split] 共 ${nsNames.length} 个命名空间`);

// ---------- 2. 按命名空间分类 ----------
const appendBuckets = {}; // ns -> entries[]
const stateEntries = [];
for (const ns of nsNames) {
  const records = Object.values(namespaces[ns]);
  if (APPEND_NS.has(ns)) {
    appendBuckets[ns] = records.map((entry) => ({ ...entry, namespace: ns }));
  } else {
    stateEntries.push(...records.map((entry) => ({ ...entry, namespace: ns })));
  }
}

// 追加类：按 updatedAt 排序（旧->新），截取最近 cap 条
let totalIn = 0;
let totalOut = 0;
for (const ns of Object.keys(CAPS)) {
  const cap = CAPS[ns];
  const records = appendBuckets[ns] || [];
  const sorted = records
    .slice()
    .sort((a, b) => String(a.updatedAt).localeCompare(String(b.updatedAt)));
  const kept = sorted.length > cap ? sorted.slice(-cap) : sorted;
  const file = path.join(outDir, `${ns}.ndjson`);
  const payload = kept.map((e) => JSON.stringify(e)).join('\n');
  fs.writeFileSync(file, payload + (kept.length ? '\n' : ''), 'utf8');
  const kb = (fs.statSync(file).size / 1024).toFixed(1);
  console.log(
    `[split]   ${ns.padEnd(22)} ${String(records.length).padStart(7)} -> ${String(kept.length).padStart(7)} 条   ${file} (${kb} KB)`,
  );
  totalIn += records.length;
  totalOut += kept.length;
}

// 状态类：全部写入 state.ndjson（旧文件里每 key 已是最新值，无重复）
const stateFile = path.join(outDir, 'state.ndjson');
const sortedState = stateEntries
  .slice()
  .sort((a, b) => String(a.updatedAt).localeCompare(String(b.updatedAt)));
const statePayload = sortedState.map((e) => JSON.stringify(e)).join('\n');
fs.writeFileSync(stateFile, statePayload + (sortedState.length ? '\n' : ''), 'utf8');
const stateKb = (fs.statSync(stateFile).size / 1024).toFixed(1);
console.log(
  `[split]   state${' '.repeat(19)} ${String(stateEntries.length).padStart(7)} -> ${String(stateEntries.length).padStart(7)} 条   ${stateFile} (${stateKb} KB)`,
);
totalIn += stateEntries.length;
totalOut += stateEntries.length;

// ---------- 3. 备份旧文件 ----------
const backup = `${centralPath}.migrated-${Date.now()}.json`;
fs.renameSync(centralPath, backup);
console.log(`[split] 原文件已备份为 ${backup}`);

// ---------- 4. 汇总 ----------
console.log('---------------------------------------------');
console.log(`[split] 完成：${totalIn} 条 -> ${totalOut} 条（追加类已按上限裁剪）`);
console.log(`[split] 输出目录：${outDir}`);
