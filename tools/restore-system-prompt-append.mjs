#!/usr/bin/env node
/**
 * 恢复「系统提示变化时追加而不是覆盖」的官方行为。
 *
 * 涉及两条 purge 补丁，同一意图的两个层面：
 *   #55 SYSTEM_PROMPT_REPLACE_HEAD   dsh-agent-loop/lib/index.js
 *       inHistory: false, // [dsh-purge] ...
 *       → inHistory: preparedCall?.systemPromptUpdate === "in-history",
 *   #72 MESSAGES_SYSTEM_CURRENT      dsh-llm-deepseek/lib/index.js
 *       if (text.length > 0) historySystem = text; // [dsh-purge] ...
 *       → 官方那段 if (inHistory && messages.length > 0) { ... } else historySystem = text;
 *
 * 官方原文一律从同目录的 .dshpurge.bak 里按行取出，不手抄，避免缩进/转义出错。
 *
 * 用法：
 *   node tools/restore-system-prompt-append.mjs            # 预览
 *   node tools/restore-system-prompt-append.mjs --apply    # 写入
 *
 * 幂等：目标行已不存在（已改成官方形态）时跳过。
 */

import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const APPLY = process.argv.includes('--apply');
const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);

const AI_BASE =
  process.env.DSH_AI_BASE ||
  'X:\\Program Files\\DeepSeek Harness\\resources\\app\\dsh\\node_modules\\@deepseek-ai';

/** [包名, 相对路径, 识别脏行的主键, 官方块的首行主键, 官方块的末行主键（与首行相同时表示单行）] */
const TARGETS = [
  {
    label: '#55 SYSTEM_PROMPT_REPLACE_HEAD',
    pkg: 'dsh-agent-loop',
    rel: ['lib', 'index.js'],
    dirtyKey: '[dsh-purge] system prompt replaces the first node',
    officialFirst: 'inHistory: preparedCall?.systemPromptUpdate === "in-history",',
    officialLast: null, // 单行
  },
  {
    label: '#72 MESSAGES_SYSTEM_CURRENT',
    pkg: 'dsh-llm-deepseek',
    rel: ['lib', 'index.js'],
    dirtyKey: '[dsh-purge] messages system field keeps the current prompt',
    officialFirst: 'if (inHistory && messages.length > 0) {',
    officialLast: '} else historySystem = text;',
  },
];

const eolOf = (text) => (text.includes('\r\n') ? '\r\n' : '\n');

/** 从 lines 里找出从 firstKey 到 lastKey 的那一段（含两端），返回行数组 */
function extractBlock(lines, firstKey, lastKey) {
  const start = lines.findIndex((l) => l.includes(firstKey));
  if (start < 0) return null;
  if (!lastKey) return [lines[start]];
  const end = lines.findIndex((l, i) => i > start && l.includes(lastKey));
  if (end < 0) return null;
  return lines.slice(start, end + 1);
}

const results = [];

for (const t of TARGETS) {
  const live = join(AI_BASE, t.pkg, ...t.rel);
  const bak = `${live}.dshpurge.bak`;

  if (!existsSync(live)) {
    results.push({ label: t.label, status: 'SKIP', note: `文件不存在：${live}` });
    continue;
  }
  if (!existsSync(bak)) {
    results.push({ label: t.label, status: 'FAIL', note: `缺官方备份：${bak}` });
    continue;
  }

  const liveText = readFileSync(live, 'utf8');
  const bakText = readFileSync(bak, 'utf8');
  const eol = eolOf(liveText);

  const dirtyCount = liveText.split(t.dirtyKey).length - 1;
  if (dirtyCount === 0) {
    results.push({ label: t.label, status: 'SKIP', note: '已是官方形态（脏标记 0 处）' });
    continue;
  }
  if (dirtyCount !== 1) {
    results.push({ label: t.label, status: 'FAIL', note: `脏标记出现 ${dirtyCount} 次，预期 1 次` });
    continue;
  }

  const liveLines = liveText.split(/\r?\n/);
  const bakLines = bakText.split(/\r?\n/);

  const official = extractBlock(bakLines, t.officialFirst, t.officialLast);
  if (!official) {
    results.push({
      label: t.label,
      status: 'FAIL',
      note: `官方备份里找不到原文块（首「${t.officialFirst}」末「${t.officialLast ?? '单行'}」）`,
    });
    continue;
  }

  // 脏行所在位置
  const dirtyIdx = liveLines.findIndex((l) => l.includes(t.dirtyKey));
  const indentMatch = liveLines[dirtyIdx].match(/^[\t ]*/);
  const indent = indentMatch ? indentMatch[0] : '';

  // 官方块首行本身的缩进取 bak 的；若 bak 缩进与 live 脏行缩进不同，以 bak 为准（逐字恢复）
  const replacement = official;

  // 用替换前的行数差推导：脏行是 1 行还是多行？
  // #55 脏行 1 行 → 替换 1 行；#72 脏行 1 行 → 替换多行
  const before = liveLines.slice(0, dirtyIdx).concat(liveLines.slice(dirtyIdx + 1));
  const after = liveLines
    .slice(0, dirtyIdx)
    .concat(replacement)
    .concat(liveLines.slice(dirtyIdx + 1));
  const newText = after.join(eol);

  results.push({
    label: t.label,
    status: APPLY ? 'WROTE' : 'READY',
    note: `${liveLines.length} 行 → ${after.length} 行；脏行缩进「${JSON.stringify(indent)}」；官方块 ${replacement.length} 行`,
    file: live,
    newText,
    before,
  });
}

// 写盘（先备份）
for (const r of results) {
  if (r.status !== 'WROTE' && r.status !== 'READY') continue;
  if (!APPLY) continue;
  const bakPath = `${r.file}.bak-${stamp}-append`;
  copyFileSync(r.file, bakPath);
  writeFileSync(r.file, r.newText, 'utf8');
  r.backup = bakPath;
}

// 报告
let fail = 0;
for (const r of results) {
  const tag = r.status === 'FAIL' ? '✗' : r.status === 'SKIP' ? '·' : '✓';
  console.log(`${tag} ${r.label}  ${r.status}`);
  console.log(`    ${r.note}`);
  if (r.backup) console.log(`    备份 ${r.backup}`);
  if (r.status === 'FAIL') fail++;
}

if (!APPLY) console.log('\n（预览模式，加 --apply 写入）');
process.exit(fail > 0 ? 3 : 0);
