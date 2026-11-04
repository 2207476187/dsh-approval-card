// 临时探针：解开本会话的 session.v4.jsonl.zstd，打印 approval/asked 与 tool/call 的形状。
import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

const file = process.argv[2]
const raw = zstdDecompressSync(readFileSync(file)).toString('utf8')
const lines = raw.split('\n').filter((l) => l.trim() !== '')
console.log('events =', lines.length)
for (const line of lines) {
  let ev
  try {
    ev = JSON.parse(line)
  } catch {
    continue
  }
  const type = ev.type ?? ev.event?.type
  if (type === 'approval/asked' || type === 'approval/decided') {
    console.log('ASKED', JSON.stringify(ev).slice(0, 600))
  }
}
// 末尾 3 条事件类型，确认流形状
console.log('--- last types ---')
for (const line of lines.slice(-3)) {
  try {
    const ev = JSON.parse(line)
    console.log(Object.keys(ev).join(','), '|', (ev.type ?? ev.event?.type ?? '').toString())
  } catch {}
}
