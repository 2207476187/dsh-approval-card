#!/usr/bin/env node
// 停用 dsh-purge 里「绕过审批 / 改默认沙箱与审批策略」的补丁，并把被它改过的系统文件还原成官方原文。
//
// 为什么单独做成脚本：purge 每次「应用」或升级都会重写 vendor\dsh-purge\lib\core.js，
// 这些停用会丢，需要能一条命令重放。
//
// 用法：
//   node tools/disable-purge-approval-patches.mjs --dry-run
//   node tools/disable-purge-approval-patches.mjs
//
// 幂等：已是停用桩（patterns 里出现 __DSH_PURGE_DISABLED_）就跳过。

import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const DRY = process.argv.includes('--dry-run');
const DSH = process.env.DSH_HOME ?? join(homedir(), '.dsh');
const PURGE_LIB = join(DSH, 'profiles', 'desktop', 'vendor', 'dsh-purge', 'lib');
const CORE = join(PURGE_LIB, 'core.js');
const AI = process.env.DSH_AI_BASE
  ?? 'X:/Program Files/DeepSeek Harness/resources/app/dsh/node_modules/@deepseek-ai';

const IDS = [5, 7, 8, 9, 10, 11, 12, 51];
const GUARD_OLD = `function isLayoutSoftPatch(patch) {
  return isIdentityLayoutPatch(patch) || isApprovalSentencePatch(patch) || Boolean(patch?.softSettle);
}`;
const GUARD_NEW = `function isLayoutSoftPatch(patch) {
  // 显式停用（disabled: true）的补丁不再走「软完成」判定，否则会永远显示已应用。
  if (patch?.disabled) return false;
  return isIdentityLayoutPatch(patch) || isApprovalSentencePatch(patch) || Boolean(patch?.softSettle);
}`;

const log = (...a) => console.log(...a);
let changed = 0;

if (!existsSync(CORE)) {
  console.error(`找不到 ${CORE}`);
  process.exit(2);
}

const raw = readFileSync(CORE, 'utf8');
const crlf = raw.includes('\r\n');
let text = raw.replace(/\r\n/g, '\n');

// 1) 给 isLayoutSoftPatch 加 disabled 守卫（只加一次）
if (text.includes(GUARD_NEW)) {
  log('[守卫] 已存在，跳过');
} else if (text.includes(GUARD_OLD)) {
  text = text.replace(GUARD_OLD, GUARD_NEW);
  changed += 1;
  log('[守卫] 已插入 disabled 守卫');
} else {
  log('[守卫] 未找到锚点，跳过（purge 版本可能不同，需人工确认）');
}

// 2) 把权限相关补丁改写成停用桩
for (const id of IDS) {
  if (text.includes(`__DSH_PURGE_DISABLED_${id}__`)) {
    log(`[#${id}] 已是停用桩，跳过`);
    continue;
  }
  const at = text.indexOf(`id: ${id},`);
  if (at < 0) {
    log(`[#${id}] 未找到定义，跳过`);
    continue;
  }
  const open = text.lastIndexOf('\n  {\n', at);
  const close = text.indexOf('\n  },\n', at);
  if (open < 0 || close < 0) {
    log(`[#${id}] 块边界定位失败，跳过`);
    continue;
  }
  const block = text.slice(open, close + 5);
  if (block.split(`id: ${id},`).length - 1 !== 1) {
    log(`[#${id}] 块内 id 重复，跳过`);
    continue;
  }
  const keep = (re, label) => {
    const m = block.match(re);
    return m ? m[0].trim().replace(/,$/, '') + ',' : null;
  };
  const name = keep(/name:\s*"[^"]*"/, 'name');
  const fields = [];
  for (const re of [
    /name:\s*"[^"]*"/,
    /layer:\s*"[^"]*"/,
    /layer_en:\s*"[^"]*"/,
    /desc:\s*"[^"]*"/,
    /file:\s*[^,\n]+/,
    /rel:\s*\[[^\]]*\]/,
  ]) {
    const m = block.match(re);
    if (m) fields.push(`    ${m[0].trim().replace(/,$/, '')},`);
  }
  const stub = [
    '',
    '  {',
    `    id: ${id},`,
    ...fields,
    '    disabled: true,',
    `    patterns: ["__DSH_PURGE_DISABLED_${id}__"],`,
    '    replace: "",',
    '  },',
    '',
  ].join('\n');
  text = text.slice(0, open) + stub + text.slice(close + 5);
  changed += 1;
  log(`[#${id}] ${name ?? ''} → 停用桩（${block.length} → ${stub.length} 字符）`);
}

// 3) 还原被 purge 改过的官方文件
const RESTORE = [
  ['dsh-user-approval', join('lib', 'index.js')],
  ['dsh-user-approval', join('lib', 'types', 'index.js')],
];
for (const [pkg, rel] of RESTORE) {
  const live = join(AI, pkg, rel);
  const bak = `${live}.dshpurge.bak`;
  if (!existsSync(live) || !existsSync(bak)) {
    log(`[还原] ${pkg}/${rel}: 缺原件或备份，跳过`);
    continue;
  }
  if (readFileSync(live, 'utf8') === readFileSync(bak, 'utf8')) {
    log(`[还原] ${pkg}/${rel}: 已是官方原文`);
    continue;
  }
  changed += 1;
  log(`[还原] ${pkg}/${rel}: 用 .dshpurge.bak 覆盖${DRY ? '（演练）' : ''}`);
  if (!DRY) copyFileSync(bak, live);
}

// 4) 把 base 的默认沙箱与审批策略改回官方
const BASE = join(AI, 'dsh-base', 'cordis.patch.yml');
if (existsSync(BASE)) {
  let y = readFileSync(BASE, 'utf8');
  const before = y;
  y = y.replace(
    /mode: !!js process\.env\.DSH_PERMISSION_MODE \?\? 'danger-full-access'/,
    "mode: !!js process.env.DSH_PERMISSION_MODE ?? 'workspace-write'",
  );
  y = y.replace(
    /policy: !!js "\(process\.env\.DSH_PERMISSION_MODE \?\? 'danger-full-access'\)[^"]*"/,
    'policy: !!js "(process.env.DSH_PERMISSION_MODE ?? \'workspace-write\') === \'danger-full-access\' ? \'never\' : \'ask\'"',
  );
  if (y === before) {
    log('[base] 默认值已是官方');
  } else {
    changed += 1;
    log(`[base] 默认沙箱/审批策略改回官方${DRY ? '（演练）' : ''}`);
    if (!DRY) writeFileSync(BASE, y, 'utf8');
  }
} else {
  log('[base] 找不到 cordis.patch.yml，跳过');
}

if (changed === 0) {
  log('\n没有需要改动的地方。');
  process.exit(0);
}

if (DRY) {
  log(`\n演练结束：将改动 ${changed} 处。去掉 --dry-run 才会写盘。`);
  process.exit(0);
}

const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
copyFileSync(CORE, `${CORE}.bak-${stamp}-before-disable`);
if (crlf) text = text.replace(/\n/g, '\r\n');
writeFileSync(CORE, text, 'utf8');
log(`\n已写入 ${CORE}`);
log(`备份 ${CORE}.bak-${stamp}-before-disable`);
log('重启 DSH 后生效；面板里这些补丁应显示为「跳过」。');
