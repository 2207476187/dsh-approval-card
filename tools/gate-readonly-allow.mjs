#!/usr/bin/env node
/**
 * 给审批门加 R0：纯只读命令不再因为「工作区外路径」弹卡。
 *
 * 背景：gate-bridge.mjs 的 R1 只做字符串扫描，`Get-Content X:\a.js` 与
 * `Set-Content X:\a.js` 被判成同一件事，于是只读排查每次都要人点一下。
 *
 * 判据（必须全部满足才放行）：
 *   1. 工具是 exec 类（pwsh/bash/...）
 *   2. 唯一的 ask 理由是「目标含工作区外路径」（R2 破坏性 / R3 凭据 / R4 外发全无）
 *   3. 命令按 ; && || | 分段后，每段首个 token 都在 READ_CMDS 白名单里
 *   4. 全文不含 WRITE_VERBS（Set-/Remove-/Out-/Invoke- 等）、不含重定向、不含
 *      子表达式 $( ... )、不含反引号、不含 Invoke-Expression / Start-Process
 *
 * 凭据路径仍走 R3，永远弹卡。
 *
 * 用法：
 *   node tools/gate-readonly-allow.mjs            # 预览（打印将要插入的代码块）
 *   node tools/gate-readonly-allow.mjs --apply    # 写入（先备份）
 *
 * 幂等：文件里已经出现 isPureReadCommand 就跳过。
 */

import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';

const APPLY = process.argv.includes('--apply');
const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);

const GATE =
  process.env.GATE_BRIDGE ||
  'C:\\Users\\Administrator\\.dsh\\profiles\\desktop\\plugins\\dsh-hooks-shim\\rules\\gate-bridge.mjs';

/* ---------------------------------------------------------------- 代码块 */

const CONST_BLOCK = `
/* ============================ R0 只读放行 ============================ */

/**
 * 只读命令白名单。
 *
 * ★ 为什么需要它：R1 只做字符串扫描，不区分读与写。读一条源码和写同一条
 *   源码在它眼里完全一样，于是查一行代码也要人点一次卡。这个白名单把
 *   「纯读」从 R1 里摘出来。
 *
 * ★ 为什么用白名单而不是黑名单：漏放的代价是多弹一次卡，误放的代价是
 *   一次静默写入。白名单写错只会打扰，黑名单写错会放行。
 */
const READ_CMDS = new Set([
  // 读文件
  'get-content', 'gc', 'cat', 'type', 'more', 'head', 'tail', 'wc',
  // 搜文本
  'select-string', 'sls', 'findstr', 'grep', 'rg', 'egrep', 'fgrep',
  // 列目录 / 取项
  'get-childitem', 'gci', 'ls', 'dir', 'get-item', 'gi', 'get-itemproperty', 'gp',
  // 校验 / 路径
  'get-filehash', 'test-path', 'resolve-path', 'split-path', 'join-path', 'convert-path',
  // 环境与元信息
  'get-command', 'get-help', 'get-member', 'get-date', 'get-location', 'pwd', 'get-process',
  // 管道里的纯计算
  'measure-object', 'select-object', 'sort-object', 'group-object',
  'format-table', 'format-list', 'format-wide',
  'out-string', 'convertto-json', 'convertfrom-json', 'compare-object', 'diff',
  'echo',
])

/**
 * 出现即判「不是纯读」的构造。
 *
 * 分段白名单挡不住括号里的嵌套命令（Get-Content (Set-Content ...) 的首 token
 * 仍是 Get-Content），所以用 WRITE_VERBS 全文兜一层。
 */
const WRITE_VERBS =
  /\\b(Set|Add|Remove|New|Clear|Move|Copy|Rename|Out|Invoke|Start|Stop|Restart|Register|Unregister|Enable|Disable|Import|Export|Install|Uninstall|Update|Save|Write|Edit|Patch|Delete|Mount|Dismount|Restore|Backup|Compress|Expand|Tee|Join|Split|ConvertTo-SecureString)-[A-Za-z]+\\b/i

const NOT_PURE_READ = [
  /[>]{1,2}\\s*\\S/, // > file / >> file
  /<{1,2}\\s*\\S/, // 输入重定向
  /\\$\\(/, // 子表达式 $( ... )
  /\`/, // 反引号可拼命令名
  /&\\s*\\$/, // & $var 调用运算符
  /\\bInvoke-Expression\\b/i,
  /\\biex\\b/i,
  /\\bStart-Process\\b/i,
  /\\bStart-Job\\b/i,
  /\\bForEach-Object\\b/i,
  /\\|\\s*%\\s/, // | % { ... }
]

/** 按 ; && || | 切段；先挖掉引号内容，避免引号里的分隔符把命令切错。 */
function splitSegments(text) {
  const stripped = String(text).replace(/"[^"]*"/g, '""').replace(/'[^']*'/g, "''")
  return stripped
    .split(/\\|\\||&&|;|\\|/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

/** 取一段的首个 token（跳过 & 前缀与空白）。 */
function firstToken(segment) {
  const m = segment.replace(/^&\\s*/, '').match(/^([A-Za-z][\\w.-]*)/)
  return m ? m[1].toLowerCase() : ''
}

/**
 * 判断一条命令是否「纯只读」。
 * @param text 命令全文（flattenInput 的结果）
 * @returns true = 只读，可以放行
 */
function isPureReadCommand(text) {
  const raw = String(text ?? '')
  if (raw.length === 0) return false
  if (WRITE_VERBS.test(raw)) return false
  for (const re of NOT_PURE_READ) if (re.test(raw)) return false
  const segs = splitSegments(raw)
  if (segs.length === 0) return false
  for (const seg of segs) {
    const tok = firstToken(seg)
    if (!tok || !READ_CMDS.has(tok)) return false
  }
  return true
}
`;

const DECIDE_BLOCK = `  // ---- R0：纯只读命令放行 ----
  // 唯一理由是「工作区外路径」、且命令每段首 token 都在 READ_CMDS 里时才跳过。
  // R2（破坏性）/ R3（凭据）/ R4（外发）只要有任何命中，上面就会多一条 reason，
  // 这里自然不成立，照旧弹卡。
  if (
    isExec &&
    outside.length > 0 &&
    reasons.length === 1 &&
    reasons[0].startsWith('目标含工作区外路径') &&
    isPureReadCommand(text)
  ) {
    return { decision: 'none', reason: '只读命令（R0 放行）' }
  }

`;

const HEADER_OLD = ' *   R4 网络外发（curl/wget/Invoke-WebRequest 等）';
const HEADER_NEW = ` *   R4 网络外发（curl/wget/Invoke-WebRequest 等）
 *   R0 纯只读命令放行：唯一理由是工作区外路径、且命令只由只读 cmdlet 组成时不问
 *      （读一条源码和写同一条源码在 R1 眼里没有区别，这条规则把「读」摘出来；
 *       凭据仍在 R3 兜底）`;

/* ---------------------------------------------------------------- 执行 */

if (!existsSync(GATE)) {
  console.error(`找不到 gate 文件：${GATE}`);
  process.exit(2);
}

const original = readFileSync(GATE, 'utf8');
if (original.includes('isPureReadCommand')) {
  console.log('已注入过（文件里有 isPureReadCommand），跳过。');
  process.exit(0);
}

const eol = original.includes('\r\n') ? '\r\n' : '\n';
let text = original.replace(/\r\n/g, '\n');

// 1) 头注释
if (!text.includes(HEADER_OLD)) {
  console.error('锚点缺失：头注释 R4 行');
  process.exit(3);
}
text = text.replace(HEADER_OLD, HEADER_NEW);

// 2) 常量与函数：插在 EXEC_TOOLS 定义之后
const anchorExec = 'const EXEC_TOOLS = /(pwsh|powershell|bash|sh|zsh|shell|exec|run|terminal|cmd)/i';
if (!text.includes(anchorExec)) {
  console.error('锚点缺失：EXEC_TOOLS 定义');
  process.exit(3);
}
text = text.replace(anchorExec, `${anchorExec}\n${CONST_BLOCK}`);

// 3) decide() 里的放行块：插在「没有理由就放行」之前
const anchorNone = "  if (reasons.length === 0) return { decision: 'none' }";
if (!text.includes(anchorNone)) {
  console.error('锚点缺失：reasons.length === 0 返回点');
  process.exit(3);
}
text = text.replace(anchorNone, `${DECIDE_BLOCK}${anchorNone}`);

// 基本结构校验：三个新片段都在，且只出现一次
for (const [label, needle, want] of [
  ['isPureReadCommand 定义', 'function isPureReadCommand', 1],
  ['R0 放行块', '只读命令（R0 放行）', 1],
  ['READ_CMDS', 'const READ_CMDS = new Set', 1],
]) {
  const n = text.split(needle).length - 1;
  if (n !== want) {
    console.error(`校验失败：${label} 出现 ${n} 次，预期 ${want}`);
    process.exit(3);
  }
}

const out = text.split('\n').join(eol);

if (!APPLY) {
  console.log('=== 预览（未写盘）===');
  console.log(`原 ${original.length} 字符 → 新 ${out.length} 字符（+${out.length - original.length}）`);
  console.log(`行数 ${original.split(/\r?\n/).length} → ${out.split(/\r?\n/).length}`);
  console.log('\n--- 插入位置 1：头注释 ---');
  console.log(HEADER_NEW);
  console.log('\n--- 插入位置 2：常量与函数（在 EXEC_TOOLS 之后）---');
  console.log(CONST_BLOCK.trim().split('\n').slice(0, 12).join('\n') + '\n  …（略）');
  console.log('\n--- 插入位置 3：decide() 放行块 ---');
  console.log(DECIDE_BLOCK.trim());
  console.log('\n（加 --apply 写入）');
  process.exit(0);
}

const backup = `${GATE}.bak-${stamp}-readonly`;
copyFileSync(GATE, backup);
writeFileSync(GATE, out, 'utf8');
console.log(`已写入 ${GATE}`);
console.log(`备份 ${backup}`);
console.log(`原 ${original.length} → 新 ${out.length} 字符`);
console.log('下一步：node --check 校验语法，再跑 tools/verify-gate-readonly.ps1 做新旧对照。');
