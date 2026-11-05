/**
 * 看 turn-tail 节点里到底有哪些字段（尤其是时间戳），为「按峰谷计价」找依据。
 * 同时统计：有多少轮节点的 tokenUsage 里带 routes / 时间。
 */
import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

function decodeFrames(buffer) {
	const offsets = []
	for (let i = 0; i + 4 <= buffer.length; i += 1) {
		if (buffer[i] === MAGIC[0] && buffer[i + 1] === MAGIC[1] && buffer[i + 2] === MAGIC[2] && buffer[i + 3] === MAGIC[3]) {
			offsets.push(i)
		}
	}
	let out = ''
	for (let i = 0; i < offsets.length; i += 1) {
		const slice = buffer.subarray(offsets[i], i + 1 < offsets.length ? offsets[i + 1] : buffer.length)
		try {
			out += zstdDecompressSync(slice).toString('utf8')
		} catch {
			// 尾部半帧忽略
		}
	}
	return out
}

const raw = decodeFrames(readFileSync(process.argv[2]))
for (const line of raw.split('\n')) {
	if (!line.includes('"turn-tail"')) continue
	let event
	try {
		event = JSON.parse(line)
	} catch {
		continue
	}
	const node = event.data?.node ?? event.data
	const data = node?.data ?? {}
	console.log('顶层键:', Object.keys(event).join(','), '| node.data 键:', Object.keys(data).join(','))
	console.log('closing 键:', Object.keys(data.closing ?? {}).join(','))
	console.log('tokenUsage 键:', Object.keys(data.tokenUsage ?? {}).join(','))
	console.log('时间类字段:', Object.entries(data).filter(([k]) => /time|at|stamp/i.test(k)).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(' | '))
	break
}
