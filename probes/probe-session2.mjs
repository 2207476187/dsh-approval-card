// 临时探针 v2：流式解 zstd（多帧），打印 approval/asked 事件的 reason 原文。
import { createReadStream } from 'node:fs'
import { createZstdDecompress } from 'node:zlib'
import { createInterface } from 'node:readline'

const file = process.argv[2]
const rl = createInterface({
  input: createReadStream(file).pipe(createZstdDecompress()).pipe(process.stdout),
  crlfDelay: Infinity
})
void rl
