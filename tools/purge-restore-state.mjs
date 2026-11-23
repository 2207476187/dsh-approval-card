#!/usr/bin/env node
// 一条命令把 purge 与宿主文件恢复到「当前这套状态」。
//
// 用法：
//   node tools/purge-restore-state.mjs            # 预览（每步都带演练参数）
//   node tools/purge-restore-state.mjs --apply    # 真写盘（需要 danger-full-access）
//
// 用途：DSH 升级把 @deepseek-ai/* 与 dsh-purge/core.js 换回官方版之后，
// 跑这个脚本，再点面板「应用」，结果就是 22 应用 / 47 跳过。
//
// 顺序不能乱：
//   1-3 先把宿主文件定点还原成官方原文（否则后面点应用会被旧 pattern 打回脏）
//   4   造停用桩 + 用 .dshpurge.bak 整文件还原 + STRING_FIXES 定点回改
//   5   #42 legacy 设置写盘改成原子写
//   6   #1 补「官方原文 → STRONG_INTRO」重放规则
//   7   让「应用」跳过 disabled（否则前面 47 条会被一键打回）

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const APPLY = process.argv.includes('--apply');
const DRY = !APPLY;

const DSH = process.env.DSH_HOME || join(process.env.USERPROFILE || '', '.dsh');
const CORE_VENDOR = join(DSH, 'profiles', 'desktop', 'vendor', 'dsh-purge', 'lib', 'core.js');
const CORE_NM = join(DSH, 'profiles', 'desktop', 'node_modules', 'dsh-purge', 'lib', 'core.js');

// 停用清单：与 tools/README.md 里那条重放命令保持一致。
const DISABLED_IDS = [6, 15, 16, 22, 23, 24, 29, 33, 34, 36, 37, 38, 39, 48, 55, 59, 61, 72, 78, 89, 92];

/** 每步：脚本名、参数（不含 --apply/--dry-run，由本脚本追加）、说明 */
const STEPS = [
  {
    title: '还原 #63 的对话同意条款（四个 preset yml）',
    script: 'restore-plan-mode-first-clause.mjs',
    args: [],
  },
  {
    title: '还原 #55 / #72：系统提示改回追加',
    script: 'restore-system-prompt-append.mjs',
    args: [],
  },
  {
    title: '还原 #89：系统提示回到 messages',
    script: 'restore-system-field-extract.mjs',
    args: [],
  },
  {
    title: `造停用桩并还原宿主文件（${DISABLED_IDS.length} 条）`,
    script: 'disable-purge-patch.mjs',
    args: DISABLED_IDS.map(String),
  },
  {
    title: '加固 #42：legacy 设置写盘改原子写',
    script: 'harden-legacy-write.mjs',
    args: [],
  },
  {
    title: '给 #1 补「官方原文 → STRONG_INTRO」重放规则',
    script: 'add-official-replay-patch.mjs',
    args: [],
  },
  {
    title: '让「应用」跳过已停用的补丁',
    script: 'purge-skip-disabled.mjs',
    args: [],
  },
];

function stateLine() {
  if (!existsSync(CORE_VENDOR)) return '  core.js 不存在（purge 未安装？）';
  const a = readFileSync(CORE_VENDOR);
  const b = existsSync(CORE_NM) ? readFileSync(CORE_NM) : null;
  const same = b && a.length === b.length && a.equals(b);
  return `  core.js vendor ${a.length.toLocaleString()} B / node_modules ${b ? b.length.toLocaleString() : '缺失'} B  同步=${same ? '是' : '否'}`;
}

function argFor(script) {
  // 三个 restore-* 与 harden 用「默认预览、--apply 才写」；
  // disable / add-official-replay / purge-skip-disabled 用「默认写、--dry-run 预览」。
  const previewByDefault = /^restore-|^harden-/.test(script);
  return previewByDefault ? (APPLY ? ['--apply'] : []) : (DRY ? ['--dry-run'] : []);
}

console.log(`== purge 状态恢复 ${APPLY ? '（实际写入）' : '（演练，不写盘）'} ==`);
console.log(`DSH_HOME = ${DSH}`);
console.log(stateLine());
console.log('');

let failed = 0;
for (const [i, step] of STEPS.entries()) {
  const file = join(HERE, step.script);
  const label = `[${i + 1}/${STEPS.length}] ${step.title}`;
  console.log(`\n──── ${label} ────`);
  if (!existsSync(file)) {
    console.log(`  跳过：脚本不存在 ${step.script}`);
    continue;
  }
  const args = [...step.args, ...argFor(step.script)];
  console.log(`  node tools/${step.script} ${args.join(' ')}`.trimEnd());
  // stdio: 'inherit' —— 受限令牌下 pipe 会 EPERM，inherit 才起得来。
  const r = spawnSync(process.execPath, [file, ...args], { cwd: ROOT, stdio: 'inherit' });
  if (r.error) {
    console.log(`  失败：${r.error.message}`);
    failed += 1;
    break;
  }
  if (r.status !== 0) {
    console.log(`  失败：退出码 ${r.status}（就此停下，后面的步骤没有执行）`);
    failed += 1;
    break;
  }
}

console.log('\n== 结束 ==');
console.log(stateLine());
if (failed) {
  console.log('\n有步骤失败。修掉再跑；本脚本是幂等的，重复执行不会叠加改动。');
  process.exit(1);
}
if (APPLY) {
  console.log('\n下一步：重启 DSH，然后在 purge 面板点一次「应用」——');
  console.log('它应当把已停用的 47 条全部跳过，只把仍在生效的那些补上。');
  console.log('核对：面板显示 22 应用 / 47 跳过 / 16 不适用 / 1 文件缺失。');
} else {
  console.log('\n这是演练。加 --apply 才写盘（写宿主与 ~/.dsh 需要 danger-full-access）。');
}
