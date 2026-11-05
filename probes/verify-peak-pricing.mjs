/**
 * 校验峰谷计价：按每一轮自己的时间戳取价，再与会话日志、真实账本对账。
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
	const key = `${event.data?.turn ?? event.turn ?? 0}:${event.data?.step ?? event.step ?? 0}`
	const at = Number(event.time ?? event.data?.time ?? 0) || 0
	samples.set(key, {
		at,
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
const { costOf, priceAt, offPeakAt, ACTIVE } = captured.__test

let total = 0
let peakOnly = 0
let tokens = 0
let offPeakTokens = 0
let stamped = 0
const byDay = new Map()
for (const sample of samples.values()) {
	const used = sample.uncachedInputTokens + sample.cacheReadTokens + sample.cacheWriteTokens + sample.outputTokens
	if (used === 0) continue
	tokens += used
	if (offPeakAt(sample.at)) offPeakTokens += used
	if (sample.at > 0) stamped += 1
	const price = priceAt(sample.at)
	total += costOf(sample, price).total
	peakOnly += costOf(sample, ACTIVE).total
	const day = sample.at > 0 ? new Date(sample.at).toLocaleDateString('sv-SE') : 'unknown'
	byDay.set(day, (byDay.get(day) ?? 0) + costOf(sample, price).total)
}

console.log(`样本 ${samples.size} 条，其中带时间戳 ${stamped} 条`)
console.log(`tokens=${tokens}（谷段 ${offPeakTokens}，占 ${((offPeakTokens / tokens) * 100).toFixed(1)}%）`)
console.log(`峰谷分时计价 ¥${total.toFixed(4)}`)
console.log(`全按峰段计价 ¥${peakOnly.toFixed(4)}（差 ${(((peakOnly - total) / total) * 100).toFixed(1)}%）`)
console.log('按天：')
for (const [day, value] of [...byDay].sort()) console.log(`  ${day}  ¥${value.toFixed(4)}`)

const ledger = JSON.parse(readFileSync(`${process.env.USERPROFILE}/.dsh/.dshw-usage.json`, 'utf8'))
console.log('账本按天：')
for (const [day, value] of Object.entries(ledger.history ?? {}).sort()) console.log(`  ${day}  ¥${Number(value).toFixed(4)}`)
console.log(`账本余额 ¥${ledger.lastBalance}`)
