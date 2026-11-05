/**
 * 用插件自己的计价函数对账：分时（工作日 9-12/14-18 = 高峰×2）vs 账本。
 * 用法：node probes/verify-peak-pricing.mjs <session.v4.jsonl.zstd>
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

const raw = decodeRaw(readFileSync(process.argv[2]))
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
	samples.set(`${event.data?.turn ?? event.turn ?? 0}:${event.data?.step ?? event.step ?? 0}`, {
		at: Number(event.time ?? event.data?.time ?? 0) || 0,
		uncachedInputTokens: usage.uncachedInputTokens ?? usage.inputTokens ?? 0,
		cacheReadTokens: usage.cacheReadTokens ?? 0,
		cacheWriteTokens: usage.cacheWriteTokens ?? 0,
		outputTokens: usage.outputTokens ?? 0
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
const { costOf, priceAt, isPeakAt, ACTIVE } = captured.__test

let total = 0
let allPeak = 0
let tokens = 0
let idleTokens = 0
let peakTurns = 0
const byDay = new Map()
for (const sample of samples.values()) {
	const used =
		sample.uncachedInputTokens + sample.cacheReadTokens + sample.cacheWriteTokens + sample.outputTokens
	if (used === 0) continue
	tokens += used
	const peak = isPeakAt(sample.at)
	if (!peak) idleTokens += used
	else peakTurns += 1
	const cost = costOf(sample, priceAt(sample.at)).total
	total += cost
	allPeak += costOf(sample, { ...ACTIVE, input: ACTIVE.input * 2, cacheRead: ACTIVE.cacheRead * 2, cacheWrite: ACTIVE.cacheWrite * 2, output: ACTIVE.output * 2 }).total
	const day = new Date(sample.at + 8 * 3600_000).toISOString().slice(0, 10)
	byDay.set(day, (byDay.get(day) ?? 0) + cost)
}

console.log(`样本 ${samples.size}，计费 ${peakTurns} 条落在高峰`)
console.log(`tokens=${tokens}（空闲 ${((idleTokens / tokens) * 100).toFixed(1)}%）`)
console.log(`分时计价 ¥${total.toFixed(4)}   全按高峰 ¥${allPeak.toFixed(4)}`)

const ledger = JSON.parse(readFileSync(`${process.env.USERPROFILE}/.dsh/.dshw-usage.json`, 'utf8'))
console.log('\n日期         本插件     账本      差额')
for (const [day, value] of [...byDay].sort()) {
	const expected = Number(ledger.history?.[day] ?? 0)
	console.log(`${day}  ¥${value.toFixed(4)}  ¥${expected.toFixed(4)}  ${(((value - expected) / expected) * 100).toFixed(1)}%`)
}
console.log(`\n账本余额 ¥${ledger.lastBalance}`)
