// 临时探针：列出会话事件类型直方图，并抽样打印与 tool/approval 有关的事件形状。
import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

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
const lines = chunks.join('').split('\n').filter((l) => l.trim() !== '')
const hist = new Map()
const samples = new Map()
for (const line of lines) {
	let ev
	try {
		ev = JSON.parse(line)
	} catch {
		continue
	}
	const type = String(ev.type ?? '?')
	hist.set(type, (hist.get(type) ?? 0) + 1)
	if (!samples.has(type)) samples.set(type, ev)
}
console.log('--- types ---')
for (const [type, n] of [...hist].sort((a, b) => b[1] - a[1])) console.log(n, type)
console.log('--- samples (tool/approval) ---')
for (const [type, ev] of samples) {
	if (!/tool|approval|call/i.test(type)) continue
	console.log(type, JSON.stringify(ev).slice(0, 700))
}
