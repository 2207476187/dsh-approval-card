/**
 * 用官方口径（周一至周五 9:00-12:00 / 14:00-18:00 为高峰，其余空闲=半价）
 * 重新切分账本，并对比官方价与拟合价。
 * 用法：node probes/probe-peak2.mjs [session.v4.jsonl.zstd]
 */
import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

const BJ = 8 * 60

/** 官方高峰：周一至周五 9:00–12:00、14:00–18:00（不含法定节假日，这里未扣节假日）。 */
function isPeakBeijing(when) {
	const d = new Date(when)
	const minute = (((d.getUTCHours() * 60 + d.getUTCMinutes() + BJ) % 1440) + 1440) % 1440
	const weekday = (d.getUTCDay() + (d.getUTCHours() * 60 + d.getUTCMinutes() + BJ >= 1440 ? 1 : 0)) % 7
	if (weekday === 0 || weekday === 6) return false
	return (minute >= 9 * 60 && minute < 12 * 60) || (minute >= 14 * 60 && minute < 18 * 60)
}

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

// 1) 账本：官方口径重切
const ledger = JSON.parse(readFileSync(`${process.env.USERPROFILE}/.dsh/.dshw-usage.json`, 'utf8'))
const buckets = { peak: { tokens: 0, cost: 0, n: 0 }, idle: { tokens: 0, cost: 0, n: 0 } }
for (const event of ledger.events ?? []) {
	const bucket = isPeakBeijing(event.ts) ? buckets.peak : buckets.idle
	bucket.tokens += event.tokens
	bucket.cost += event.cost
	bucket.n += 1
}
for (const [name, bucket] of Object.entries(buckets)) {
	const perM = bucket.tokens === 0 ? 0 : bucket.cost / (bucket.tokens / 1e6)
	console.log(
		`账本 ${name === 'peak' ? '高峰' : '空闲'}：${bucket.n} 条  tokens=${bucket.tokens}  ¥${bucket.cost.toFixed(4)}  → ¥${perM.toFixed(4)}/M`
	)
}
if (buckets.idle.tokens > 0 && buckets.peak.tokens > 0) {
	const ratio =
		buckets.peak.cost / (buckets.peak.tokens / 1e6) / (buckets.idle.cost / (buckets.idle.tokens / 1e6))
	console.log(`高峰/空闲 单价比：${ratio.toFixed(3)}（官方应为 2.000）`)
}

if (process.argv[2] === undefined) process.exit(0)

// 2) 会话：官方价 vs 拟合价，逐日对比账本
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
		input: usage.uncachedInputTokens ?? usage.inputTokens ?? 0,
		read: usage.cacheReadTokens ?? 0,
		write: usage.cacheWriteTokens ?? 0,
		output: usage.outputTokens ?? 0
	})
}

const OFFICIAL = { input: 1, cacheRead: 0.02, cacheWrite: 1, output: 4 }
const FITTED = { input: 1.0061, cacheRead: 0.0274, cacheWrite: 1.0061, output: 2.7035 }
const costOf = (s, price) => {
	const factor = isPeakBeijing(s.at) ? 2 : 1
	return (
		((s.input * price.input + s.read * price.cacheRead + s.write * price.cacheWrite + s.output * price.output) / 1e6) *
		factor
	)
}

const byDay = new Map()
let totalOfficial = 0
let totalFitted = 0
let tokens = 0
let idleTokens = 0
for (const sample of samples.values()) {
	const used = sample.input + sample.read + sample.write + sample.output
	if (used === 0) continue
	tokens += used
	if (!isPeakBeijing(sample.at)) idleTokens += used
	const official = costOf(sample, OFFICIAL)
	const fitted = costOf(sample, FITTED)
	totalOfficial += official
	totalFitted += fitted
	const day = new Date(sample.at).toLocaleDateString('sv-SE')
	const bucket = byDay.get(day) ?? { official: 0, fitted: 0 }
	bucket.official += official
	bucket.fitted += fitted
	byDay.set(day, bucket)
}
console.log(`\n会话 tokens=${tokens}（空闲 ${((idleTokens / tokens) * 100).toFixed(1)}%）`)
console.log(`官方价合计 ¥${totalOfficial.toFixed(4)}   拟合价合计 ¥${totalFitted.toFixed(4)}`)
console.log('日期        官方价    拟合价    账本')
for (const [day, bucket] of [...byDay].sort()) {
	const ledgerDay = Number(ledger.history?.[day] ?? 0)
	console.log(
		`${day}  ¥${bucket.official.toFixed(4)}  ¥${bucket.fitted.toFixed(4)}  ¥${ledgerDay.toFixed(4)}`
	)
}
