// 临时探针：看某次 pwsh 下载命令的 args 与 targetFor 的取值优先级。
import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

const { extractPaths, matchOperation, targetFor } = await import(
	'file:///C:/Users/<user>/.dsh/profiles/desktop/plugins/dsh-approval-card/src/text.mjs'
)

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
for (const line of chunks.join('').split('\n')) {
	if (!line.includes('Invoke-WebRequest')) continue
	let ev
	try {
		ev = JSON.parse(line)
	} catch {}
	if (ev?.type !== 'tool/call') continue
	const args = JSON.parse(ev.data.arguments)
	console.log('ARGS', JSON.stringify(args))
	const cmd = String(args.command ?? '')
	console.log('PATHS', JSON.stringify(extractPaths(cmd, 3)))
	console.log('HIT', JSON.stringify(matchOperation(cmd)))
	console.log('TARGET', targetFor({ args, command: cmd, justification: '', cwd: 'D:\\x' }))
}
