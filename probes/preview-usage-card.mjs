/** 预览：最近一轮在卡片上会显示成什么样（消息行 + 悬停明细 + 会话累计药丸）。 */
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

const raw = decodeRaw(readFileSync(process.argv[2]))
const turns = []
for (const line of raw.split('\n')) {
	if (line.trim() === '') continue
	let event
	try {
		event = JSON.parse(line)
	} catch {
		continue
	}
	if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') continue
	const usage = event.data?.tokenUsage ?? event.data?.usage
	if (usage === undefined || usage === null) continue
	const used =
		(usage.uncachedInputTokens ?? usage.inputTokens ?? 0) +
		(usage.cacheReadTokens ?? 0) +
		(usage.cacheWriteTokens ?? 0) +
		(usage.outputTokens ?? 0)
	if (used === 0) continue
	turns.push({
		at: Number(event.time ?? 0) || 0,
		usage: {
			uncachedInputTokens: usage.uncachedInputTokens ?? usage.inputTokens ?? 0,
			cacheReadTokens: usage.cacheReadTokens ?? 0,
			cacheWriteTokens: usage.cacheWriteTokens ?? 0,
			outputTokens: usage.outputTokens ?? 0
		},
		model: event.data?.routes?.[0]?.model ?? event.data?.model ?? 'deepseek-flash'
	})
}

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
await import(pathToFileURL(`${process.env.DSH_HOME}/profiles/desktop/plugins/dsh-usage-cost/client.js`).href)
const { costOf, priceAt, formatMoney, breakdownText, sessionCostOf, ACTIVE, PEAK_FACTOR } = captured.__test

const last = turns[turns.length - 1]
const price = priceAt(last.at)
const cost = costOf(last.usage, price)
console.log('消息行显示：')
console.log(`  用量 ${(cost.tokens / 1e6).toFixed(1)}M tok ¥${formatMoney(cost.total)}`)
console.log('\n悬停明细：')
for (const line of breakdownText(cost, price, last.model).split('\n')) console.log(`  ${line}`)
console.log('\n会话累计药丸标题：')
const summary = sessionCostOf({ nodes: new Map(turns.map((t, i) => [`t${i}`, { kind: 'turn-tail', time: t.at, data: { tokenUsage: t.usage } }])) })
console.log(`  合计 ¥${formatMoney(summary.total)}（${summary.turns} 轮，${summary.tokens} tokens）`)
console.log(
	`  其中空闲时段 ${summary.idleTokens} tokens（${((summary.idleTokens / summary.tokens) * 100).toFixed(0)}%，按半价）`
)
console.log(`  价目表 ${ACTIVE.tag}；高峰 = 空闲价 × ${PEAK_FACTOR}`)
