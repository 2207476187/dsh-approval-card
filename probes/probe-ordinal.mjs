/**
 * 用真实会话验证「同一调用的第 N 个审批请求」编号。
 *
 * 会话日志 session.v4.jsonl.zstd 是多帧 zstd 拼接（每帧几百字节），Node 的
 * zstdDecompressSync 只吃一帧，所以按 magic 28 b5 2f fd 切段逐帧解再拼。
 * 然后把 approval/asked 按出现顺序喂给插件入口的同款逻辑（计数 + 标记），
 * 断言：reason 不被改动、只有第 2 个及以后的请求带编号。
 *
 * 跑：node probes/probe-ordinal.mjs <session.v4.jsonl.zstd>
 */
import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'
import { pathToFileURL } from 'node:url'

const PLUGIN = 'C:/Users/<user>/.dsh/profiles/desktop/plugins/dsh-approval-card/src/text.mjs'
const file = process.argv[2]
if (file === undefined) {
	console.error('用法: node probes/probe-ordinal.mjs <session.v4.jsonl.zstd>')
	process.exit(2)
}

const { applySummaryText, markRepeatOrdinal, DISPLAY_BREAK } = await import(pathToFileURL(PLUGIN).href)

/** 多帧 zstd → 事件数组。 */
function readEvents(path) {
	const buf = readFileSync(path)
	const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
	const offsets = []
	for (let i = 0; i + 4 <= buf.length; i += 1) {
		if (buf[i] === magic[0] && buf[i + 1] === magic[1] && buf[i + 2] === magic[2] && buf[i + 3] === magic[3]) offsets.push(i)
	}
	const events = []
	for (let k = 0; k < offsets.length; k += 1) {
		const slice = buf.subarray(offsets[k], k + 1 < offsets.length ? offsets[k + 1] : buf.length)
		let text
		try {
			text = zstdDecompressSync(slice).toString('utf8')
		} catch {
			continue
		}
		for (const line of text.split('\n')) {
			if (line.trim() === '') continue
			try {
				events.push(JSON.parse(line))
			} catch {
				// 跨帧截断的残行
			}
		}
	}
	return events
}

const events = readEvents(file)
const session = events.find((ev) => ev?.type === 'session')
const cwd = session?.data?.header?.cwd ?? session?.data?.cwd ?? ''

/** 同 index.mjs：callId → 已流到插件的请求数。 */
const seen = new Map()
const nextOrdinal = (callId) => {
	if (callId === undefined || callId === null) return 1
	const key = String(callId)
	const n = (seen.get(key) ?? 0) + 1
	seen.set(key, n)
	return n
}

const argsByCall = new Map()
for (const ev of events) {
	if (ev?.type !== 'tool/call' || ev.data?.callId === undefined) continue
	try {
		argsByCall.set(String(ev.data.callId), typeof ev.data.arguments === 'string' ? JSON.parse(ev.data.arguments) : ev.data.arguments)
	} catch {
		// 参数坏了就只是少一条精确目标
	}
}

const samples = []
let asks = 0
let rewritten = 0
let marked = 0
let reasonTouched = 0
const byOrdinal = new Map()

for (const ev of events) {
	if (ev?.type !== 'approval/asked') continue
	const data = ev.data ?? {}
	asks += 1
	const req = {
		toolName: data.toolName,
		callId: data.callId,
		reason: data.reason,
		displayReason: data.displayReason === undefined ? undefined : { ...data.displayReason }
	}
	const before = req.reason
	const ordinal = nextOrdinal(req.callId)
	byOrdinal.set(ordinal, (byOrdinal.get(ordinal) ?? 0) + 1)
	let zh = applySummaryText(req, {
		args: argsByCall.get(String(req.callId)) ?? null,
		argsSource: argsByCall.has(String(req.callId)) ? 'callId' : 'none',
		cwd,
		env: process.env
	})
	if (zh === '') continue
	rewritten += 1
	const markedText = markRepeatOrdinal(zh, ordinal)
	if (markedText !== zh) {
		marked += 1
		req.displayReason = { ...req.displayReason, zh: markedText }
		zh = markedText
		if (samples.length < 3) samples.push({ ordinal, zh })
	}
	if (req.reason !== before) reasonTouched += 1
}

console.log(`asks=${asks} rewritten=${rewritten} marked=${marked} reasonTouched=${reasonTouched}`)
console.log(`按序号分布: ${[...byOrdinal.entries()].sort((a, b) => a[0] - b[0]).map(([k, v]) => `#${k}=${v}`).join(' ')}`)
for (const sample of samples) {
	console.log(`--- 第 ${sample.ordinal} 个请求 ---`)
	console.log(sample.zh.split('\n').map((line) => '  ' + line).join('\n'))
}
