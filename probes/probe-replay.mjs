import { pathToFileURL } from 'node:url'
const DSH = (process.env.DSH_HOME ?? `${(process.env.USERPROFILE ?? '').replace(/\\/g, '/')}/.dsh`).replace(/\\/g, '/')
// 回放探针：把会话里真实发生过的 approval/asked 事件喂给最新 text.mjs，对比改写前后。
// 用途：不起 GUI、不重启，就能验证卡片文案在真实请求上是否正确。
import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

const { applySummaryText } = await import(pathToFileURL(`${DSH}/profiles/desktop/plugins/dsh-approval-card/src/text.mjs`).href)

const buf = readFileSync(process.argv[2])
const magic = [0x28, 0xb5, 0x2f, 0xfd]
const offsets = []
for (let i = 0; i + 3 < buf.length; i += 1) {
	if (buf[i] === magic[0] && buf[i + 1] === magic[1] && buf[i + 2] === magic[2] && buf[i + 3] === magic[3]) offsets.push(i)
}
const chunks = []
for (let k = 0; k < offsets.length; k += 1) {
	const start = offsets[k]
	const end = k + 1 < offsets.length ? offsets[k + 1] : buf.length
	try {
		chunks.push(zstdDecompressSync(buf.subarray(start, end)).toString('utf8'))
	} catch {}
}
const events = []
for (const line of chunks.join('').split('\n')) {
	if (line.trim() === '') continue
	try {
		events.push(JSON.parse(line))
	} catch {}
}

let cwd = ''
for (const ev of events) {
	if (ev.type === 'session') cwd = ev.data?.header?.cwd ?? ev.data?.cwd ?? cwd
}

const argsById = new Map()
for (const ev of events) {
	if (ev.type !== 'tool/call') continue
	const d = ev.data ?? {}
	if (typeof d.callId !== 'string') continue
	try {
		argsById.set(d.callId, JSON.parse(d.arguments))
	} catch {}
}

const asked = events.filter((ev) => ev.type === 'approval/asked')
console.log(`cwd=${cwd} asked=${asked.length} calls=${argsById.size}\n`)

let changed = 0
for (const ev of asked) {
	const d = ev.data ?? {}
	const req = { toolName: d.toolName, callId: d.callId, reason: d.reason }
	const args = argsById.get(d.callId) ?? null
	const after = applySummaryText(req, { args, argsSource: args === null ? 'none' : 'callId', cwd, env: process.env })
	if (after !== '') changed += 1
	console.log(`### ${d.toolName}  args=${args === null ? '(无)' : JSON.stringify(args).slice(0, 120)}`)
	console.log(`BEFORE: ${String(d.reason ?? '').replace(/\n/g, ' ⏎ ')}`)
	console.log(`AFTER : ${after === '' ? '(不改)' : after.replace(/ \n/g, ' ⏎ ')}`)
	console.log(`reason 未被改动: ${req.reason === d.reason}\n`)
}
console.log(`改写数=${changed}/${asked.length}`)
