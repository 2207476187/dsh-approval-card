/**
 * 按小时看真实单价：账本每条事件有 ts + tokens + cost，反推每条的 ¥/百万 token，
 * 按「北京时间小时」分桶，看是否存在峰谷差。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ledgerPath = join(process.env.DSH_HOME ?? '', '.dshw-usage.json')
const ledger = JSON.parse(readFileSync(ledgerPath, 'utf8'))
const events = Array.isArray(ledger.events) ? ledger.events : []

/** @type {Map<number, {tokens: number, cost: number, n: number}>} */
const byHour = new Map()
for (const event of events) {
	const tokens = Number(event.tokens)
	const cost = Number(event.cost)
	if (!Number.isFinite(tokens) || !Number.isFinite(cost) || tokens <= 0) continue
	const date = new Date(Number(event.ts))
	// 北京时间整点
	const hour = (date.getUTCHours() + 8) % 24
	const bucket = byHour.get(hour) ?? { tokens: 0, cost: 0, n: 0 }
	bucket.tokens += tokens
	bucket.cost += cost
	bucket.n += 1
	byHour.set(hour, bucket)
}

const rows = [...byHour.entries()].sort((a, b) => a[0] - b[0])
console.log('北京时间小时  事件数     tokens        实扣        ¥/百万')
for (const [hour, bucket] of rows) {
	const perM = (bucket.cost / bucket.tokens) * 1e6
	console.log(
		`${String(hour).padStart(2, '0')}:00       ${String(bucket.n).padStart(3)}   ${String(bucket.tokens).padStart(12)}   ${bucket.cost.toFixed(4).padStart(8)}   ${perM.toFixed(4)}`
	)
}

// 粗分「谷段（00:30-08:30 北京）」与「峰段」
let valley = { tokens: 0, cost: 0 }
let peak = { tokens: 0, cost: 0 }
for (const event of events) {
	const tokens = Number(event.tokens)
	const cost = Number(event.cost)
	if (!Number.isFinite(tokens) || !Number.isFinite(cost) || tokens <= 0) continue
	const date = new Date(Number(event.ts))
	const minutes = ((date.getUTCHours() + 8) % 24) * 60 + date.getUTCMinutes()
	const isValley = minutes >= 30 && minutes < 8 * 60 + 30
	const target = isValley ? valley : peak
	target.tokens += tokens
	target.cost += cost
}
console.log('')
console.log(`谷段（北京 00:30–08:30）：tokens=${valley.tokens} 实扣=${valley.cost.toFixed(4)} → ¥${((valley.cost / valley.tokens) * 1e6).toFixed(4)}/M`)
console.log(`峰段（其余时段）        ：tokens=${peak.tokens} 实扣=${peak.cost.toFixed(4)} → ¥${((peak.cost / peak.tokens) * 1e6).toFixed(4)}/M`)
