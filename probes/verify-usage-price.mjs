/**
 * 用真实账本校验单价表：拿账本里「某轮总 token + 实际扣费」去比对新价目表算出来的金额。
 * 用法：node probes/verify-usage-price.mjs <session.v4.jsonl.zstd>
 */
import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'
import { pathToFileURL } from 'node:url'

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
function decodeRaw(buffer) {
	const parts = []
	let start = -1
	for (let i = 0; i + 4 <= buffer.length; i += 1) {
		if (buffer.compare(MAGIC, 0, 4, i, i + 4) !== 0) continue
		if (start >= 0) parts.push(buffer.subarray(start, i))
		start = i
	}
	if (start >= 0) parts.push(buffer.subarray(start))
	let text = ''
	for (const part of parts) {
		try {
			text += zstdDecompressSync(part).toString('utf8')
		} catch {}
	}
	return text
}

const sessionPath = process.argv[2]
const raw = decodeRaw(readFileSync(sessionPath))
/** 按「轮:步」去重后求和 —— 与宿主 tokenUsage 投影一致（同一步重复上报是替换，不是累加）。 */
const samples = new Map()
for (const line of raw.split('\n')) {
	if (line.trim() === '') continue
	let event
	try {
		event = JSON.parse(line)
	} catch {
		continue
	}
	if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt' && event.type !== 'turn/end') continue
	const usage = event.data?.tokenUsage ?? event.data?.usage
	if (usage === undefined || usage === null) continue
	const key = `${event.data?.turn ?? event.turn ?? 0}:${event.data?.step ?? event.step ?? 0}`
	samples.set(key, {
		uncachedInputTokens: usage.uncachedInputTokens ?? usage.inputTokens ?? 0,
		cacheReadTokens: usage.cacheReadTokens ?? 0,
		cacheWriteTokens: usage.cacheWriteTokens ?? 0,
		outputTokens: usage.outputTokens ?? 0
	})
}
const totals = { uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 }
for (const sample of samples.values()) {
	for (const key of Object.keys(totals)) totals[key] += sample[key]
}
const turns = [...samples.values(), totals]
console.log(`会话累计（同投影口径）tokens=${totals.uncachedInputTokens + totals.cacheReadTokens + totals.cacheWriteTokens + totals.outputTokens}`)

const pluginUrl = pathToFileURL(`${process.env.DSH_HOME}/profiles/desktop/plugins/dsh-usage-cost/client.js`).href
// client.js 头部只定义常量与纯函数，需要先把 __ModuleLoader__ 拦下来。
let captured
globalThis.window = {
	__ModuleLoader__: {
		load(definition) {
			const stub = new Proxy(
				{},
				{
					get: (_target, key) => {
						if (key === 'jsx' || key === 'jsxs') return () => null
						if (key === 'useRef') return () => ({ current: null })
						return () => {}
					}
				}
			)
			captured = definition.factory(() => stub)
		}
	}
}
await import(pluginUrl)
const { costOf, ACTIVE } = captured.__test

const ledger = JSON.parse(readFileSync(`${process.env.USERPROFILE}/.dsh/.dshw-usage.json`, 'utf8'))
const today = (ledger.events ?? []).filter((item) => item.day === '2026-11-06')
let worst = 0
for (const item of today) {
	let best
	let bestDelta = Number.POSITIVE_INFINITY
	for (const turn of turns) {
		const total = turn.uncachedInputTokens + turn.cacheReadTokens + turn.cacheWriteTokens + turn.outputTokens
		const delta = Math.abs(total - item.tokens)
		if (delta < bestDelta) {
			bestDelta = delta
			best = turn
		}
	}
	const total = best.uncachedInputTokens + best.cacheReadTokens + best.cacheWriteTokens + best.outputTokens
	const cost = costOf(best).total
	const error = Math.abs(cost - item.cost) / item.cost
	worst = Math.max(worst, error)
	console.log(
		`账本 tokens=${String(item.tokens).padStart(9)} 实扣 ¥${item.cost.toFixed(6)}  ` +
			`| 最近的轮 tokens=${String(total).padStart(9)}（差 ${((bestDelta / item.tokens) * 100).toFixed(2)}%）` +
			` 命中率=${((best.cacheReadTokens / Math.max(total, 1)) * 100).toFixed(1)}%  ` +
			`本表算得 ¥${cost.toFixed(6)}  偏差 ${(error * 100).toFixed(1)}%`
	)
}
console.log(`最高偏差 ${(worst * 100).toFixed(1)}%（价目表 ${ACTIVE.tag}）`)
