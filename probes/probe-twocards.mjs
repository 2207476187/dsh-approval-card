// 分析「一次操作弹两张卡」：同一 callId 的多次 approval/asked 的顺序、时间差、决策结果与形态。
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

let best = null
for (const d of readdirSync(ROOT, { withFileTypes: true }).filter((x) => x.isDirectory())) {
	try {
		const t = decode(join(ROOT, d.name, 'session.v4.jsonl.zstd'))
		if (!best || t.length > best.length) best = t
	} catch {}
}
const ev = []
for (const line of best.split('\n')) {
	if (line.trim() === '') continue
	try {
		ev.push(JSON.parse(line))
	} catch {}
}

const shape = (reason) => (/^escalate sandbox to /i.test(reason) ? 'escalation' : /^目标含工作区外路径/.test(reason) ? 'gate-outside' : 'other')
const kindOf = (reason) => {
	if (/^escalate sandbox to /i.test(reason)) return 'escalation'
	if (/^目标含工作区外路径/.test(reason)) return 'gate-outside'
	if (/^escalate sandbox/i.test(reason)) return 'escalation'
	return 'gate-other'
}

const asked = ev.filter((e) => e.type === 'approval/asked')
const decided = ev.filter((e) => e.type === 'approval/decided')
const byId = new Map()
for (const e of decided) byId.set(e.data?.id ?? e.data?.callId, e.data)

const perCall = new Map()
for (const e of asked) {
	const d = e.data ?? {}
	const list = perCall.get(d.callId) ?? []
	list.push({ t: e.time, kind: kindOf(String(d.reason ?? '')), id: d.id, tool: d.toolName, reason: String(d.reason ?? '').slice(0, 70) })
	perCall.set(d.callId, list)
}

const patterns = new Map()
const gaps = []
for (const [, list] of perCall) {
	if (list.length < 2) continue
	const seq = list.map((x) => x.kind).join('>')
	patterns.set(seq, (patterns.get(seq) ?? 0) + 1)
	for (let i = 1; i < list.length; i++) gaps.push(list[i].t - list[i - 1].t)
}
console.log('asked=', asked.length, 'calls=', perCall.size, '多卡 calls=', [...perCall.values()].filter((l) => l.length > 1).length)
console.log('形态分布:', [...patterns.entries()].map(([k, v]) => `${k}×${v}`).join('  '))
gaps.sort((a, b) => a - b)
const q = (p) => gaps[Math.min(gaps.length - 1, Math.floor(gaps.length * p))]
console.log('两次审批间隔 ms: min', gaps[0], 'p50', q(0.5), 'p90', q(0.9), 'max', gaps[gaps.length - 1])

// 决策结果统计 + 一个样本的完整序列
const outs = new Map()
for (const e of decided) {
	const d = e.data ?? {}
	const k = `${kindOf(String(d.reason ?? ''))}:${d.outcome ?? d.decision ?? d.result ?? '?'}`
	outs.set(k, (outs.get(k) ?? 0) + 1)
}
console.log('决策结果:', [...outs.entries()].map(([k, v]) => `${k}×${v}`).join('  '))
console.log('decided data keys:', Object.keys(decided[0]?.data ?? {}).join(','))

let sample = null
for (const [cid, list] of perCall) {
	if (list.length >= 2 && list.some((x) => x.kind === 'gate-outside') && list.some((x) => x.kind === 'escalation')) {
		sample = { cid, list }
		break
	}
}
if (sample) {
	console.log('\n样本 callId:', sample.cid)
	for (const x of sample.list) console.log(' ', new Date(x.t).toISOString(), x.kind, x.tool, '|', x.reason)
	const related = ev.filter((e) => JSON.stringify(e.data ?? {}).includes(sample.cid) && e.type !== 'tool/result')
	for (const e of related) console.log('   >', e.type, new Date(e.time).toISOString(), JSON.stringify(e.data).slice(0, 120))
}
