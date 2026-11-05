/**
 * 用「真实账单」反推单价。
 *
 * 思路：鲸鱼挂件（dsh-whale-widget）按余额差记账，`.dshw-usage.json` 的 events 里每条都是
 * 「某一天、某模型、多少 token、扣了多少钱」。会话日志里每一轮有完整的四个计费桶。把两边按
 * token 总数对上，就能拿真实扣费去解单价，而不是我凭记忆写一张价目表。
 *
 * 输出：最小二乘拟合的 input / cacheRead / output 三档单价（元/百万 token），以及残差。
 *
 * 用法：node probes/fit-usage-price.mjs <session.v4.jsonl.zstd>
 */
import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** 多帧 zstd：逐帧解压再拼起来（DSH 的会话文件是逐条追加的多帧流）。 */
function decodeFrames(buffer) {
	const parts = []
	let start = -1
	for (let i = 0; i + 4 <= buffer.length; i += 1) {
		if (buffer.compare(MAGIC, 0, 4, i, i + 4) !== 0) continue
		if (start >= 0) parts.push(buffer.subarray(start, i))
		start = i
	}
	if (start >= 0) parts.push(buffer.subarray(start))
	const text = parts
		.map((part) => {
			try {
				return zstdDecompressSync(part).toString('utf8')
			} catch {
				return ''
			}
		})
		.join('')
	return text
}

const sessionPath = process.argv[2]
if (sessionPath === undefined) {
	console.error('用法：node probes/fit-usage-price.mjs <session.v4.jsonl.zstd>')
	process.exit(2)
}
const raw = decodeFrames(readFileSync(sessionPath))
const events = raw
	.split('\n')
	.filter((line) => line.trim() !== '')
	.map((line) => {
		try {
			return JSON.parse(line)
		} catch {
			return null
		}
	})
	.filter((event) => event !== null)

/** 收集每一轮的四个计费桶。 */
const turns = []
const seen = new Set()
for (const event of events) {
	if (event.type !== 'turn/end' && event.type !== 'assistant/message') continue
	const usage = event.data?.tokenUsage ?? event.data?.usage
	if (usage === undefined || usage === null) continue
	const key = JSON.stringify(usage)
	if (seen.has(key)) continue
	seen.add(key)
	turns.push(usage)
}

const bucketsOf = (usage) => ({
	uncached: usage.uncachedInputTokens ?? usage.inputTokens ?? 0,
	cacheRead: usage.cacheReadTokens ?? 0,
	cacheWrite: usage.cacheWriteTokens ?? 0,
	output: usage.outputTokens ?? 0
})
const totalOf = (usage) => {
	const b = bucketsOf(usage)
	return b.uncached + b.cacheRead + b.cacheWrite + b.output
}

const ledger = JSON.parse(readFileSync(process.env.DSHW_USAGE ?? `${process.env.USERPROFILE}/.dsh/.dshw-usage.json`, 'utf8'))
const rows = []
for (const item of ledger.events ?? []) {
	const tokens = Number(item.tokens)
	const cost = Number(item.cost)
	if (!Number.isFinite(tokens) || !Number.isFinite(cost) || tokens <= 0) continue
	// 账本的 token 数与单轮总数常常差一点点（账本含工具轮/子代理），按最近邻 + 容差配。
	let match
	let best = Number.POSITIVE_INFINITY
	for (const usage of turns) {
		const delta = Math.abs(totalOf(usage) - tokens)
		if (delta < best && delta / tokens <= 0.02) {
			best = delta
			match = usage
		}
	}
	if (match === undefined) continue
	const b = bucketsOf(match)
	rows.push({ ...b, cost })
}

console.error(`轮次=${turns.length} 账本事件=${(ledger.events ?? []).length} 成功配对=${rows.length}`)
if (rows.length < 3) {
	console.error('配对太少，放弃拟合')
	process.exit(3)
}

// 最小二乘：cost = (input*uncached + cacheRead*cacheRead + cacheWrite*cacheWrite + output*output) / 1e6
// 用正规方程解 4 个未知数（cacheWrite 与 input 常常共线，这里约束 cacheWrite = input）。
const names = ['input', 'cacheRead', 'output']
const A = rows.map((row) => [row.uncached + row.cacheWrite, row.cacheRead, row.output].map((value) => value / 1e6))
const y = rows.map((row) => row.cost)
const n = names.length
const ata = Array.from({ length: n }, () => new Array(n).fill(0))
const aty = new Array(n).fill(0)
for (let r = 0; r < A.length; r += 1) {
	for (let i = 0; i < n; i += 1) {
		aty[i] += A[r][i] * y[r]
		for (let j = 0; j < n; j += 1) ata[i][j] += A[r][i] * A[r][j]
	}
}
/** 高斯消元（带部分主元）。 */
function solve(matrix, vector) {
	const m = matrix.map((row, i) => [...row, vector[i]])
	for (let col = 0; col < n; col += 1) {
		let pivot = col
		for (let r = col + 1; r < n; r += 1) if (Math.abs(m[r][col]) > Math.abs(m[pivot][col])) pivot = r
		;[m[col], m[pivot]] = [m[pivot], m[col]]
		const lead = m[col][col]
		if (Math.abs(lead) < 1e-12) continue
		for (let c = col; c <= n; c += 1) m[col][c] /= lead
		for (let r = 0; r < n; r += 1) {
			if (r === col) continue
			const factor = m[r][col]
			if (factor === 0) continue
			for (let c = col; c <= n; c += 1) m[r][c] -= factor * m[col][c]
		}
	}
	return m.map((row) => row[n])
}

const solution = solve(ata, aty)
console.log('拟合结果（元/百万 token）：')
names.forEach((name, i) => {
	console.log(`  ${name.padEnd(10)} ¥${solution[i].toFixed(4)}`)
})
let sumAbs = 0
let sumRel = 0
for (let r = 0; r < rows.length; r += 1) {
	const predicted = A[r].reduce((acc, value, i) => acc + value * solution[i], 0)
	sumAbs += Math.abs(predicted - y[r])
	sumRel += Math.abs(predicted - y[r]) / Math.max(y[r], 1e-9)
}
console.log(`平均绝对误差 ¥${(sumAbs / rows.length).toFixed(6)}  平均相对误差 ${(sumRel / rows.length * 100).toFixed(1)}%`)
