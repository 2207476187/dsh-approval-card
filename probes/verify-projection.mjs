/**
 * 校验宿主投影 `usageCost`：把整份会话事件流折叠一遍，看它算出多少钱、多少 token、峰谷怎么分。
 *
 * 用法：node probes/verify-projection.mjs <session.v4.jsonl.zstd>
 *
 * 为什么需要它：浏览器算的「会话累计」只统计已物化的轮，往上翻会变大。投影必须在宿主里折叠
 * **全部**事件，所以先用离线折叠验证口径（tokens 应与 `tokenUsage` 投影同量级、金额应与账本对得上），
 * 再让客户端改成读投影。
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const DSH = (process.env.DSH_HOME ?? join(homedir(), '.dsh')).replace(/\\/g, '/')
const moduleUrl = new URL(`file:///${DSH}/profiles/desktop/plugins/dsh-usage-cost/src/index.mjs`)
const { __test } = await import(moduleUrl.href)

/** 多帧 zstd：会话文件是逐帧拼接的，`zstdDecompressSync` 只解第一帧。 */
function decodeAll(file) {
	const buffer = readFileSync(file)
	const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
	const offsets = []
	let at = buffer.indexOf(magic, 0)
	while (at !== -1) {
		offsets.push(at)
		at = buffer.indexOf(magic, at + 4)
	}
	const parts = []
	for (let index = 0; index < offsets.length; index += 1) {
		const end = index + 1 < offsets.length ? offsets[index + 1] : buffer.length
		try {
			parts.push(zstdDecompressSync(buffer.subarray(offsets[index], end)))
		} catch {
			// 尾帧可能不完整，跳过。
		}
	}
	return Buffer.concat(parts).toString('utf8')
}

const file = process.argv[2]
if (file === undefined) {
	console.error('用法：node probes/verify-projection.mjs <session.v4.jsonl.zstd>')
	process.exit(2)
}

const events = []
for (const line of decodeAll(file).split('\n')) {
	if (line === '') continue
	try {
		events.push(JSON.parse(line))
	} catch {
		// 截断的尾行忽略。
	}
}

let state = __test.zeroState()
const sizes = new Map()
for (const record of events) {
	const event = record.event ?? record
	const type = event?.type ?? record?.type
	if (typeof type === 'string') sizes.set(type, (sizes.get(type) ?? 0) + 1)
	state = __test.fold(state, { ...event, type })
}

// 用投影自己的 stateSchema 验一遍，确认折叠出来的形状能被持久化/反序列化。
const parsed = __test.definition.stateSchema.parse(state)
const view = __test.definition.wire.view(parsed)
__test.definition.wire.viewSchema.parse(view)

const ledgerPath = join(DSH, '.dshw-usage.json')
let ledger = null
try {
	ledger = JSON.parse(readFileSync(ledgerPath, 'utf8'))
} catch {
	// 没有账本就算了。
}

const money = (value) => `¥${value.toFixed(4)}`
console.log('事件总数        ', events.length)
console.log('assistant/message', sizes.get('assistant/message') ?? 0, '| assistant/attempt', sizes.get('assistant/attempt') ?? 0, '| llm/retry-started', sizes.get('llm/retry-started') ?? 0)
console.log('投影 turns      ', view.turns)
console.log('投影 tokens     ', view.tokens.toLocaleString('en-US'))
console.log('其中高峰        ', view.peakTokens.toLocaleString('en-US'), `（${((view.peakTokens / Math.max(1, view.tokens)) * 100).toFixed(1)}%）`)
console.log('其中空闲        ', view.idleTokens.toLocaleString('en-US'), `（${((view.idleTokens / Math.max(1, view.tokens)) * 100).toFixed(1)}%）`)
console.log('投影金额        ', money(view.cost))
if (ledger !== null) {
	console.log('账本 todayUsage ', money(Number(ledger.todayUsage ?? 0)), '| 余额', money(Number(ledger.lastBalance ?? 0)), '| dayStart', money(Number(ledger.dayStart ?? 0)))
	const history = ledger.history ?? {}
	console.log('账本逐日        ', Object.entries(history).map(([day, amount]) => `${day}=${money(Number(amount))}`).join(' '))
	const total = Object.values(history).reduce((sum, amount) => sum + Number(amount || 0), 0)
	console.log('账本累计        ', money(total), '（账号级，含其他会话与工具调用）')
}
