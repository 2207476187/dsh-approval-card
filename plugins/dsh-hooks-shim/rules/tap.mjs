/**
 * tap.mjs —— 探针 hook：只记录「我被调用了」，不做任何判定
 *
 * 用途：验证 dsh-hooks-shim 挂在 tools/pre-execute 上的钩子是否真的会被宿主执行。
 * 判据：只要 `hook-calls.jsonl` 出现新行，就说明：
 *   ① 插件被加载了
 *   ② 扩展点 armed 了
 *   ③ hooks.json 的 command 被执行了
 *   ④ stdin 的 payload 契约对得上
 *
 * 它 **永远输出空**（= 无意见），不影响任何工具调用。
 * 验证完就把 hooks.json 里的命令换回 gate-bridge.mjs。
 */

import { appendFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const logPath = join(here, '..', 'hook-calls.jsonl')

let raw = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (c) => {
  raw += c
})
process.stdin.on('error', () => process.exit(0))
process.stdin.on('end', () => {
  try {
    const payload = JSON.parse(raw || '{}')
    const line = JSON.stringify({
      at: new Date().toISOString(),
      event: payload.hook_event_name ?? null,
      tool: payload.tool_name ?? null,
      toolUseId: payload.tool_use_id ?? null,
      cwd: payload.cwd ?? null,
      sessionId: payload.session_id ? String(payload.session_id).slice(0, 24) : null,
      rawBytes: raw.length,
      // 只留 key 结构，不落具体命令内容
      inputKeys: payload.tool_input && typeof payload.tool_input === 'object' ? Object.keys(payload.tool_input) : [],
    })
    mkdirSync(dirname(logPath), { recursive: true })
    appendFileSync(logPath, line + '\n', 'utf8')
  } catch {
    // 记录失败也绝不影响会话
  }
  process.exit(0)
})

setTimeout(() => process.exit(0), 8000).unref()
