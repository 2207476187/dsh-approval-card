// 找出「改写落到 cwd 兜底」的审批，检查同 callId 的 tool 调用事件是否真的存在。
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
console.log('session:', best.file, 'events:', events.length)

// 1) 所有事件类型
const types = new Map()
for (const e of events) types.set(e.type ?? e.kind ?? '?', (types.get(e.type ?? e.kind ?? '?') ?? 0) + 1)
console.log('types:', [...types.entries()].map(([k, v]) => `${k}=${v}`).join(' '))

// 2) 找 19:18:15Z 前后的审批，打印 callId 与同 callId 的 tool 事件
const askedList = events.filter((e) => String(e.type ?? '').includes('approval/asked'))
console.log('asked:', askedList.length)
for (const a of askedList.slice(-6)) {
	const ts = a.time ?? a.at ?? a.timestamp ?? ''
	const cid = a.callId ?? a.data?.callId
	const argsJson = JSON.stringify(a.data?.args ?? a.args ?? null).slice(0, 200)
	console.log('\n--- asked', ts, 'tool=', a.toolName ?? a.data?.toolName, 'callId=', cid)
	console.log('    reason=', String(a.reason ?? a.data?.reason ?? '').slice(0, 160))
	console.log('    keys=', Object.keys(a).join(','), ' dataKeys=', a.data ? Object.keys(a.data).join(',') : '-')
	const hits = events.filter((e) => JSON.stringify(e).includes(String(cid)))
	console.log('    含该 callId 的事件数=', hits.length, hits.map((e) => e.type ?? e.kind).join('|'))
}
