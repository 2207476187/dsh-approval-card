import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'
import { applySummaryText, DISPLAY_BREAK } from 'file:///C:/Users/Administrator/.dsh/profiles/desktop/plugins/dsh-approval-card/src/text.mjs'

const buf = readFileSync(process.argv[2])
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const at = []
for (let i = 0; i + 4 <= buf.length; i += 1) if (buf.compare(MAGIC, 0, 4, i, i + 4) === 0) at.push(i)
const chunks = []
for (let k = 0; k < at.length; k += 1) {
	try { chunks.push(zstdDecompressSync(buf.subarray(at[k], k + 1 < at.length ? at[k + 1] : buf.length))) } catch {}
}
const text = Buffer.concat(chunks).toString('utf8')
const events = []
for (const line of text.split('\n')) { const t = line.trim(); if (!t.startsWith('{')) continue; try { events.push(JSON.parse(t)) } catch {} }

let cwd = ''
const calls = new Map()
const asks = []
for (const ev of events) {
	const d = ev.data ?? ev
	if ((ev.type ?? d.type) === 'session') cwd = d.header?.cwd ?? d.cwd ?? cwd
	if ((ev.type ?? d.type) === 'tool/call') calls.set(d.callId, d.arguments)
	if ((ev.type ?? d.type) === 'approval/asked') asks.push(d)
}

const buckets = { 命令: 0, 权限: 0, 原因: 0, 影响: 0, 理由: 0 }
let rewritten = 0
for (const a of asks) {
	const raw = String(a.reason ?? '')
	let args = null
	try { args = JSON.parse(calls.get(a.callId) ?? 'null') } catch {}
	const req = { toolName: a.toolName, callId: a.callId, reason: raw, displayReason: a.displayReason }
	const zh = applySummaryText(req, { args, cwd, env: process.env })
	if (zh === '') continue
	rewritten += 1
	for (const line of zh.split(DISPLAY_BREAK)) {
		for (const key of Object.keys(buckets)) if (line.startsWith(key + '：')) buckets[key] += 1
	}
}
console.log(`asks=${asks.length} rewritten=${rewritten}`)
console.log('输出行计数:', JSON.stringify(buckets))
