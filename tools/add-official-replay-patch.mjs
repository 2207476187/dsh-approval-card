#!/usr/bin/env node
/**
 * 给 purge 的 #1 补「官方原文 → 强引导语」替换规则。
 *
 * 为什么需要：DSH 升级会把 @deepseek-ai/dsh-agent-instructions/lib/index.js
 * 换回官方弱措辞（"may be relevant / guidance when applicable"）。#1 原本的
 * pattern 只有 STRONG_INTRO_V1 / STRONG_INTRO_V2 两种中间态，匹配不到官方原文，
 * 于是只会显示 skipped —— 不报错，但 AGENTS.md 的引导语从「必须执行」静默退回
 * 「仅供参考」。补上这条规则后，升级后点一次 purge「应用」就能打回去。
 *
 * 用法：
 *   node tools/add-official-replay-patch.mjs [--dry-run]
 *
 * 幂等：已存在则直接报告，不重复插入。写盘前备份 core.js.bak-<stamp>-official-replay。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const DRY = process.argv.includes('--dry-run')

const CORE = process.env.PURGE_CORE || path.join(
  os.homedir(),
  '.dsh', 'profiles', 'desktop', 'vendor', 'dsh-purge', 'lib', 'core.js',
)

// 锚点：#1 现有最后一条 replacement（AGENT_INSTRUCTIONS_INTRO 的 V2 态）
const ANCHOR = `      {
        pattern:
          "const AGENT_INSTRUCTIONS_INTRO = " +
          '"' + STRONG_INTRO_V2 + '"',
        replace:
          "const AGENT_INSTRUCTIONS_INTRO = " +
          '"' + STRONG_INTRO + '"',
      },
    ],`

const INSERT = `      {
        pattern:
          "const AGENT_INSTRUCTIONS_INTRO = " +
          '"' + STRONG_INTRO_V2 + '"',
        replace:
          "const AGENT_INSTRUCTIONS_INTRO = " +
          '"' + STRONG_INTRO + '"',
      },
      {
        // 官方原文 → 强引导语：宿主被上游升级覆盖后，点「应用」可直接补回。
        pattern:
          "const WORKSPACE_CONTEXT_INTRO = " +
          '"' + OFFICIAL_REPLACEMENT_BODY + '"',
        replace:
          "const WORKSPACE_CONTEXT_INTRO = " +
          '"' + STRONG_INTRO + '"',
      },
      {
        pattern:
          "const AGENT_INSTRUCTIONS_INTRO = " +
          '"' + OFFICIAL_REPLACEMENT_BODY + '"',
        replace:
          "const AGENT_INSTRUCTIONS_INTRO = " +
          '"' + STRONG_INTRO + '"',
      },
    ],`

function fail(msg) {
  console.error(`✗ ${msg}`)
  process.exit(3)
}

if (!fs.existsSync(CORE)) fail(`找不到 core.js：${CORE}`)

const before = fs.readFileSync(CORE, 'utf8')

// 幂等判据：两条 OFFICIAL_REPLACEMENT_BODY pattern 都已存在
const OFFICIAL_MARK = `'"' + OFFICIAL_REPLACEMENT_BODY + '"'`
const hits = before.split(OFFICIAL_MARK).length - 1
if (hits >= 2) {
  console.log('✓ 已经补过（OFFICIAL_REPLACEMENT_BODY pattern 存在 2 处），无需改动。')
  process.exit(0)
}
if (hits === 1) fail(`只找到 1 处 OFFICIAL_REPLACEMENT_BODY pattern，状态不完整，先人工核对`)

const at0 = (() => {
  // core.js 在 Windows 上是 CRLF，锚点按 LF 写，需跟随文件自身的换行风格
  const eol = before.includes('\r\n') ? '\r\n' : '\n'
  const anchor = ANCHOR.replace(/\n/g, eol)
  const insert = INSERT.replace(/\n/g, eol)
  const idx = before.indexOf(anchor)
  if (idx < 0) fail('找不到锚点（#1 的 AGENT_INSTRUCTIONS_INTRO / STRONG_INTRO_V2 块）')
  if (before.indexOf(anchor, idx + 1) >= 0) fail('锚点出现多次，拒绝猜测')
  return { idx, anchor, insert }
})()

const after = before.slice(0, at0.idx) + at0.insert + before.slice(at0.idx + at0.anchor.length)

// 结构自检：这是纯插入，前缀与后缀必须逐字保留
if (!after.startsWith(before.slice(0, at0.idx))) fail('插入后前缀不一致')
if (!after.endsWith(before.slice(at0.idx + at0.anchor.length))) fail('插入后后缀不一致')

// 新片段的两条 pattern 必须都在
const expect = [
  ['WORKSPACE pattern', `"const WORKSPACE_CONTEXT_INTRO = " +`],
  ['AGENT pattern', `'"' + OFFICIAL_REPLACEMENT_BODY + '"'`],
  ['注释', '官方原文 → 强引导语'],
]
for (const [name, needle] of expect) {
  if (!after.includes(needle)) fail(`插入后缺少 ${name}`)
}
if (after.split(OFFICIAL_MARK).length - 1 < 2) fail('插入后 OFFICIAL pattern 不足 2 处')

if (DRY) {
  console.log('[dry-run] 将插入以下片段：\n')
  console.log(INSERT)
  console.log(`\n[dry-run] ${before.length} → ${after.length} 字节，未写盘。`)
  process.exit(0)
}

// 备份
const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
const bak = `${CORE}.bak-${stamp}-official-replay`
fs.copyFileSync(CORE, bak)
console.log(`备份：${bak}（${fs.statSync(bak).size} B）`)

fs.writeFileSync(CORE, after, 'utf8')
console.log(`✓ 已写入 core.js：${before.length} → ${after.length} 字节`)
console.log('  语法请自己过一遍：node --check "<core.js 路径>"')
console.log('  然后重启 DSH，或在 purge 面板点一次「应用」验证 #1 仍为 applied。')
