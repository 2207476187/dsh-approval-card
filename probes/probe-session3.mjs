// 临时探针 v3：按 zstd 帧逐个解压（拼接帧容器），打印 approval/asked 的 reason。
import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

const buf = readFileSync(process.argv[2])
const magic = [0x28, 0xb5, 0x2f, 0xfd]
const offsets = []
for (let i = 0; i + 3 < buf.length; i += 1) {
  if (buf[i] === magic[0] && buf[i + 1] === magic[1] && buf[i + 2] === magic[2] && buf[i + 3] === magic[3]) offsets.push(i)
}
const chunks = []
let failed = 0
for (let k = 0; k < offsets.length; k += 1) {
  const start = offsets[k]
  const end = k + 1 < offsets.length ? offsets[k + 1] : buf.length
  try {
    chunks.push(zstdDecompressSync(buf.subarray(start, end)).toString('utf8'))
  } catch {
    failed += 1
  }
}
const text = chunks.join('')
const lines = text.split('\n').filter((l) => l.trim() !== '')
console.log(`frames=${offsets.length} failed=${failed} events=${lines.length}`)
for (const line of lines) {
  if (!line.includes('approval/asked')) continue
  try {
    const ev = JSON.parse(line)
    const d = ev.data ?? {}
    console.log('ASKED', JSON.stringify({ type: ev.type, toolName: d.toolName, callId: d.callId, reason: d.reason }))
  } catch {
    console.log('RAW', line.slice(0, 300))
  }
}
