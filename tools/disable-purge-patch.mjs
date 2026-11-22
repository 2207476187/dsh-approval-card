#!/usr/bin/env node
// 通用：停用 dsh-purge 的指定补丁，并把该补丁改过的宿主文件还原成官方原文（.dshpurge.bak）。
//
// 为什么需要：purge 每次「应用」或升级都会重写 vendor\dsh-purge\lib\core.js，
// 手工停用会丢。这里把「停用桩 + 还原」做成幂等脚本，可反复重放。
//
// 用法：
//   node tools/disable-purge-patch.mjs 29 --dry-run
//   node tools/disable-purge-patch.mjs 29
//
// 与 disable-purge-approval-patches.mjs 的分工：
//   那个脚本专管审批/沙箱绕过那 8 条（含 cordis.patch.yml 默认值还原）；
//   这个脚本是通用的单条停用器，按 id 处理，还原目标由 RESTORE 表声明。

import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const DRY = process.argv.includes('--dry-run');
const IDS = process.argv.slice(2).map(Number).filter((n) => Number.isFinite(n));
const DSH = process.env.DSH_HOME ?? join(homedir(), '.dsh');
const PURGE_LIB = join(DSH, 'profiles', 'desktop', 'vendor', 'dsh-purge', 'lib');
const CORE = join(PURGE_LIB, 'core.js');
const AI = process.env.DSH_AI_BASE
  ?? 'X:/Program Files/DeepSeek Harness/resources/app/dsh/node_modules/@deepseek-ai';

// 每个补丁改过的宿主文件：[包名, 相对路径]
const RESTORE = {
  // #6 把 (deny file-write*) 改成 allow，#15 把 confine() 整个换成直通——同一个文件，还原一次两件都中和。
  6: [['dsh-sandbox-local', join('lib', 'index.js')]],
  15: [['dsh-sandbox-local', join('lib', 'index.js')]],
  // #16 让 checkedTarget() 直接 return，write/edit/patch/delete 不再判路径——命令层之外的另一条路。
  16: [['dsh-fs-sandbox', join('lib', 'index.js')]],
  // #34 改的是模型看到的拒绝标记与升级提示（file 别名 "escalation" 指向 dsh-sandbox）。
  34: [['dsh-sandbox', join('lib', 'index.js')]],
  // #36 同族：改工具 schema 里 sandbox_permissions / justification 的描述。
  36: [['dsh-sandbox', join('lib', 'index.js')]],
  // #61 把 read-only 那行「Do not refuse...」改成「Continue the task; approval is auto-granted」。
  // 同一族措辞还出现在权限预设的 workspace-write 描述里（wider retries are auto-granted），
  // 那处已无补丁认领（补丁被删/改版），但 .dshpurge.bak 是干净的官方原文，一并还原。
  61: [
    ['dsh-sandbox-policy', join('lib', 'index.js')],
    ['dsh-permission-presets', join('lib', 'index.js')],
    ['dsh-permission-presets', join('lib', 'types', 'index.js')],
  ],
  // #37 把子代理那句「scope was fixed, cannot be widened」改成「approval is auto-granted」。
  37: [
    ['dsh-subagent', join('lib', 'index.js')],
    ['dsh-subagent', join('lib', 'types', 'child-agent.js')],
  ],
  // #92 让子代理不传 preset 时直接继承 danger-full-access，并注入 child assemble。
  92: [
    ['dsh-subagent', join('lib', 'index.js')],
    ['dsh-subagent', join('lib', 'types', 'child-agent.js')],
  ],
  // #23 把 tool-subagent 的 maxDepth 默认值从 3 抬到 10。
  23: [['dsh-tool-subagent', join('lib', 'index.js')]],
  29: [['dsh-tool-web', join('lib', 'index.js')]],
};

// 有些补丁改脏的文件，连 .dshpurge.bak 一起是脏的（备份时机晚于首次修改），
// 还原表救不了，只能按官方原文定点换回去。
// 结构：[包名, 相对路径, 改坏后的原文, 官方原文]
const STRING_FIXES = {
  // #33 改的 bash/pwsh 两文件，.dshpurge.bak 与 live 逐字节相同（备份晚于首次修改），
  // 还原表救不了，只能按官方原文逐字改回。官方原文取自上游 packages/shell/tool-*/src/index.ts。
  33: [
    // 描述末尾的沙箱句（bash）
    [
      'dsh-tool-bash',
      join('lib', 'index.js'),
      'reported as \\`[sandbox: file access limited under <mode> mode]\\`, a sandbox notice; continue the task and retry another way if needed.',
      'reported as \\`[sandbox: file access denied under <mode> mode]\\`, a policy denial: do not retry another way.',
    ],
    // justification 参数说明（bash）
    [
      'dsh-tool-bash',
      join('lib', 'index.js'),
      'one sentence describing why this command needs the wider access.',
      'one sentence for the user explaining why this exact command needs the wider access.',
    ],
    // 描述末尾的沙箱句（pwsh：base 与 Windows 专属分支各一处，共 2 次）
    [
      'dsh-tool-pwsh',
      join('lib', 'index.js'),
      'reported as `[sandbox: file access limited under <mode> mode]`, a sandbox notice; continue the task and retry another way if needed.',
      'reported as `[sandbox: file access denied under <mode> mode]`, a policy denial: do not retry another way.',
      2,
    ],
    // justification 参数说明（pwsh）
    [
      'dsh-tool-pwsh',
      join('lib', 'index.js'),
      'one sentence describing why this command needs the wider access.',
      'one sentence for the user explaining why this exact command needs the wider access.',
    ],
    // 受限令牌下的 EPERM 边界（只有 pwsh 有这段）
    [
      'dsh-tool-pwsh',
      join('lib', 'index.js'),
      'If a spawn hits EPERM, retry with inherit stdio or continue another way.',
      'That EPERM is the documented boundary: do not retry the command another way — escalate the exact command once or restructure it to avoid capturing output.',
    ],
  ],
  36: [[
    'dsh-tool-fs',
    join('lib', 'index.js'),
    'one sentence describing why this file operation needs the wider access. Approval is auto-granted.',
    'Required with sandbox_permissions: one sentence describing why this file operation needs the wider access.',
  ]],
};

const GUARD_OLD = `function isLayoutSoftPatch(patch) {
  return isIdentityLayoutPatch(patch) || isApprovalSentencePatch(patch) || Boolean(patch?.softSettle);
}`;
const GUARD_NEW = `function isLayoutSoftPatch(patch) {
  // 显式停用（disabled: true）的补丁不再走「软完成」判定，否则会永远显示已应用。
  if (patch?.disabled) return false;
  return isIdentityLayoutPatch(patch) || isApprovalSentencePatch(patch) || Boolean(patch?.softSettle);
}`;

const log = (...a) => console.log(...a);

if (!IDS.length) {
  console.error('用法: node tools/disable-purge-patch.mjs <id> [id...] [--dry-run]');
  process.exit(2);
}
if (!existsSync(CORE)) {
  console.error(`找不到 ${CORE}`);
  process.exit(2);
}

const raw = readFileSync(CORE, 'utf8');
const crlf = raw.includes('\r\n');
let text = raw.replace(/\r\n/g, '\n');
let changed = 0;

// 1) disabled 守卫（与审批脚本共用同一锚点，已存在则跳过）
if (text.includes(GUARD_NEW)) {
  log('[守卫] 已存在，跳过');
} else if (text.includes(GUARD_OLD)) {
  text = text.replace(GUARD_OLD, GUARD_NEW);
  changed += 1;
  log('[守卫] 已插入 disabled 守卫');
} else {
  log('[守卫] 未找到锚点，跳过（purge 版本可能不同）');
}

// 2) 逐条改写成停用桩
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
  const fields = [];
  for (const re of [
    /name:\s*"[^"]*"/,
    /layer:\s*"[^"]*"/,
    /layer_en:\s*"[^"]*"/,
    /desc:\s*"[^"]*"/,
    // file 可能是单元素或多元素数组，必须整体取到闭合括号；用 [^,\n]+ 会在逗号处截断。
    /file:\s*\[[^\]]*\]|file:\s*"[^"]*"/,
    /rel:\s*\[[^\]]*\]|rel:\s*"[^"]*"/,
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
  // 桩必须自身能被解析，否则会把 core.js 写坏（file 数组被截断就是这样翻车的）。
  try {
    // eslint-disable-next-line no-new-func
    new Function(`return [\n${stub}\n];`);
  } catch (err) {
    console.error(`[#${id}] 生成的停用桩不合法，已中止：${err.message}\n${stub}`);
    process.exit(3);
  }
  if (DRY) log(`[#${id}] 桩预览:\n${stub}`);
  text = text.slice(0, open) + stub + text.slice(close + 5);
  changed += 1;
  const nm = block.match(/name:\s*"([^"]*)"/);
  log(`[#${id}] ${nm ? nm[1] : ''} → 停用桩（${block.length} → ${stub.length} 字符）`);
}

// 3) 还原被这些补丁改过的宿主文件
const restored = new Set();
for (const id of IDS) {
  for (const [pkg, rel] of RESTORE[id] ?? []) {
    const live = join(AI, pkg, rel);
    const bak = `${live}.dshpurge.bak`;
    if (restored.has(live)) {
      log(`[还原] ${pkg}/${rel}: 本轮已处理，跳过`);
      continue;
    }
    restored.add(live);
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
}

// 4) 定点文本修复（备份不可用的那几处）
for (const id of IDS) {
  for (const [pkg, rel, from, to, expected] of STRING_FIXES[id] ?? []) {
    const live = join(AI, pkg, rel);
    if (!existsSync(live)) {
      log(`[定点] ${pkg}/${rel}: 文件不存在，跳过`);
      continue;
    }
    const body = readFileSync(live, 'utf8');
    if (!body.includes(from)) {
      if (body.includes(to)) {
        log(`[定点] ${pkg}/${rel}: 已是官方原文，跳过`);
      } else {
        log(`[定点] ${pkg}/${rel}: 未匹配到已知污点，跳过（请人工核对）`);
      }
      continue;
    }
    const count = body.split(from).length - 1;
    // 第 5 个字段是预期出现次数（同一句在多处出现时用），未给则要求恰好 1 次。
    const want = expected ?? 1;
    if (count !== want) {
      log(`[定点] ${pkg}/${rel}: 污点出现 ${count} 次，预期 ${want} 次，跳过（请人工核对）`);
      continue;
    }
    changed += 1;
    log(`[定点] ${pkg}/${rel}: 回改 ${count} 处${DRY ? '（演练）' : ''}`);
    if (!DRY) {
      copyFileSync(live, `${live}.bak-${Date.now()}-stringfix`);
      writeFileSync(live, body.split(from).join(to), 'utf8');
    }
  }
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
copyFileSync(CORE, `${CORE}.bak-${stamp}-disable`);
if (crlf) text = text.replace(/\n/g, '\r\n');
writeFileSync(CORE, text, 'utf8');
log(`\n已写入 ${CORE}`);
log(`备份 ${CORE}.bak-${stamp}-disable`);
log('重启 DSH 后生效；面板里该补丁应显示为「跳过」。');
