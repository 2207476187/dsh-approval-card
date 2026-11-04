/**
 * 对比「审批门写进 reason 的原文」与「插件改写后卡片上实际显示的文本」，
 * 找出被丢掉的那条路径。
 *
 *   node probes/probe-lastcard.mjs [分钟数]
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

const minutes = Number(process.argv[2] ?? 30)
const dshHome = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? '', '.dsh')
const eventsPath = join(dshHome, 'auto-approve', 'events.jsonl')

const pluginDir = join(dshHome, 'profiles', 'desktop', 'plugins', 'dsh-approval-card')
const { applySummaryText, trimDownstreamReason, targetFor } = await import(
  new URL('file:///' + join(pluginDir, 'src', 'text.mjs').replace(/\\/g, '/')).href
)

const since = new Date(Date.now() - minutes * 60_000).toISOString()
const lines = readFileSync(eventsPath, 'utf8').trim().split('\n')
const events = lines
  .map((l) => {
    try {
      return JSON.parse(l)
    } catch {
      return null
    }
  })
  .filter(Boolean)
  .filter((e) => e.ts >= since && e.reason && e.verdict !== 'scope')

console.log(`最近 ${minutes} 分钟的审批事件：${events.length} 条\n`)

for (const ev of events) {
  const req = {
    toolName: ev.tool,
    callId: ev.callId,
    reason: ev.reason,
    displayReason: undefined,
  }
  const facts = { args: ev.facts?.command ? { command: ev.facts.command } : null, argsSource: 'event', cwd: ev.facts?.cwd ?? '' }
  const after = applySummaryText(req, facts)
  console.log('─'.repeat(100))
  console.log('时间     :', ev.ts, '| 工具:', ev.tool, '| 判定:', ev.verdict, '| path:', ev.path ?? '-')
  console.log('门记目标 :', JSON.stringify(ev.targets ?? []))
  console.log('门原文   :', JSON.stringify(ev.reason))
  console.log('卡片显示 :', JSON.stringify(after === '' ? '(未改写，沿用原文)' : after))
  const card = after === '' ? String(ev.reason) : after
  const tokens = (text) =>
    [...String(text).matchAll(/[A-Za-z]:[\\/][^，,、；;\s"'`]+|\/(?:[^\s"'`，,、；;]){3,}/g)]
      .map((m) => m[0].replace(/\\\\/g, '\\').toLowerCase())
  const cardTokens = tokens(card)
  // 卡片上写得更细也算「有」：`…\src\paths.mjs` 覆盖了门里的 `…\src` 这种截断写法。
  const lost = tokens(ev.reason).filter((t) => !cardTokens.some((c) => c === t || c.startsWith(t)))
  if (lost.length) console.log('⚠ 门给了但卡片上没有的路径:', JSON.stringify(lost))
  console.log()
}
