// 针对最近若干审批：打印 tool/call 的真实 arguments + 我们算出来的文案，定位 args 缺失与目标挑选问题。
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const ROOT = 'C:\\Users\\Administrator\\.dsh\\sessions\\--D-DeepSeek~0020Harness~5DE5~4F5C~76EE~5F55-DeepSeek--'

function decode(file) {
	const buf = readFileSync(file)
	const frames = []
	let start = 0
	for (let i = 0; i + 4 <= buf.length; i++) {
		if (buf[i] === 0x28 && buf[i + 1] === 0xb5 && buf[i + 2] === 0x2f && buf[i + 3] === 0xfd) {
			if (i > start) frames.push(buf.subarray(start, i))
			start = i
		}
	}
	if (start < buf.length) frames.push(buf.subarray(start))
	const out = []
	for (const f of frames) {
		try {
			out.push(zstdDecompressSync(f).toString('utf8'))
		} catch {}
	}
	return out.join('')
}

const dirs = readdirSync(ROOT, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
let best = null
for (const d of dirs) {
	const f = join(ROOT, d, 'session.v4.jsonl.zstd')
	try {
		const text = decode(f)
		if (best === null || text.length > best.text.length) best = { file: f, text }
	} catch {}
}
const events = []
for (const line of best.text.split('\n')) {
	if (line.trim() === '') continue
	try {
		events.push(JSON.parse(line))
	} catch {}
}

// tool/call 事件结构
const callEvent = events.find((e) => e.type === 'tool/call')
console.log('tool/call keys:', Object.keys(callEvent).join(','), '| data keys:', Object.keys(callEvent.data ?? {}).join(','))

const calls = new Map()
for (const e of events) {
	if (e.type !== 'tool/call') continue
	const d = e.data ?? {}
	calls.set(d.callId ?? d.id, d)
}
const cwdEvent = events.find((e) => e.type === 'session')
const cwd = cwdEvent?.data?.header?.cwd ?? cwdEvent?.data?.cwd ?? '?'
console.log('cwd:', cwd)

const { applySummaryText } = await import('file:///C:/Users/<user>/.dsh/profiles/desktop/plugins/dsh-approval-card/src/text.mjs')

const asked = events.filter((e) => e.type === 'approval/asked')
for (const a of asked.slice(-8)) {
	const d = a.data ?? {}
	const call = calls.get(d.callId)
	let args = null
	let source = 'none'
	if (call !== undefined) {
		source = 'callId'
		try {
			args = typeof call.arguments === 'string' ? JSON.parse(call.arguments) : call.arguments
		} catch {
			args = null
		}
	}
	const req = { toolName: d.toolName, callId: d.callId, reason: d.reason }
	const out = applySummaryText(req, { args, argsSource: source, cwd, env: process.env })
	console.log('\n===== ', d.toolName, d.callId, 'source=', source)
	console.log('reason:', String(d.reason).slice(0, 140))
	console.log('args  :', JSON.stringify(args)?.slice(0, 240))
	console.log('OUT   :', JSON.stringify(out))
}
