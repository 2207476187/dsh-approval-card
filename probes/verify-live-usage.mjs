/** 用真实会话数据 + 线上 client.js 复核：分时取价、会话累计、当前时段判定。 */
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
const nodes = new Map()
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
	// 模拟聊天快照里的轮节点：kind=turn-tail、time=毫秒、data.tokenUsage
	nodes.set(`turn-${event.data?.turn ?? 0}-${event.data?.step ?? 0}`, {
		kind: 'turn-tail',
		time: Number(event.time ?? event.data?.time ?? 0) || 0,
		// 宿主的轮节点用 `uncachedInputTokens`（见 token-meter 的 turn-usage.js:94），
		// 会话日志里的 assistant/message 事件则叫 `inputTokens`，这里要归一化。
		data: {
			tokenUsage: {
				uncachedInputTokens: usage.uncachedInputTokens ?? usage.inputTokens ?? 0,
				cacheReadTokens: usage.cacheReadTokens ?? 0,
				cacheWriteTokens: usage.cacheWriteTokens ?? 0,
				outputTokens: usage.outputTokens ?? 0
			}
		}
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
const { sessionCostOf, priceAt, isPeakAt, formatMoney, ACTIVE, PEAK_FACTOR } = captured.__test

const summary = sessionCostOf({ nodes })
console.log(`会话累计：¥${formatMoney(summary.total)}  tokens=${summary.tokens}  轮次=${summary.turns}`)
console.log(
	`其中空闲时段 ${summary.idleTokens}（${((summary.idleTokens / summary.tokens) * 100).toFixed(1)}%）`
)
const now = Date.now()
const price = priceAt(now)
console.log(`当前时刻（${new Date(now).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}）`)
console.log(`  判定=${isPeakAt(now) ? '高峰' : '空闲'}  tag=${price.tag}`)
console.log(
	`  单价 input=${price.input} cacheRead=${price.cacheRead} output=${price.output}（基准 ${ACTIVE.input}/${ACTIVE.cacheRead}/${ACTIVE.output}，倍率 ${PEAK_FACTOR}）`
)
// 抽查最近三笔：各自按自己的时间取价
const recent = [...nodes.values()].slice(-3)
for (const node of recent) {
	const p = priceAt(node.time)
	console.log(`  轮 ${new Date(node.time).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })} → ${p.tag}`)
}
