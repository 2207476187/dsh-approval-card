#!/usr/bin/env node
/**
 * 给 dsh-approval-gate 打一个本地补丁：结构化路径字段不再走文本提取器。
 *
 * 病因（2026-11-04 取证）：
 *   resolveToolCallTargets() 对 edit/write 的 `file_path` 也调用 extractAbsolutePaths()，
 *   而那是一个**文本**提取器（ABS_PATH_TOKEN_RE 遇空白即停）。工作区路径
 *   `D:\DeepSeek Harness工作目录\DeepSeek\...` 被截成 `D:\DeepSeek`，定域判成
 *   「工作区外」→ 每次改工作区内文件都要人工审批。
 *
 * 修法：结构化字段（整条就是一个路径）直接当一条绝对路径收下；命令类字段仍走文本提取。
 *   只动这一个函数，不碰裁决顺序、不碰任何判定逻辑。
 *
 * 上游是 git 依赖，`pnpm install` / 更新会覆盖 → 更新后重跑本脚本即可（幂等）。
 *
 * 用法：
 *   node tools/patch-approval-gate.mjs            # 打补丁
 *   node tools/patch-approval-gate.mjs --dry-run  # 只看会改什么
 *   node tools/patch-approval-gate.mjs --status    # 只报是否已打
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { execFileSync } from 'node:child_process'

const PROFILE = 'C:\\Users\\Administrator\\.dsh\\profiles\\desktop'
const MARKER = 'addStructured'

function gateDir() {
  const req = createRequire(join(PROFILE, 'package.json'))
  const entry = req.resolve('dsh-approval-gate')
  // …\dsh-approval-gate\src\index.mjs → …\dsh-approval-gate
  return dirname(dirname(entry))
}

// 1) 新增 addStructured，保留 add 给命令文本用
const OLD_ADD = `  const add = (text) => {
    if (found.length >= 24) return
    for (const p of extractAbsolutePaths(text)) {
      if (seen.has(p.path)) continue
      seen.add(p.path)
      found.push(p)
    }
  }`

const NEW_ADD = `  const add = (text) => {
    if (found.length >= 24) return
    for (const p of extractAbsolutePaths(text)) {
      if (seen.has(p.path)) continue
      seen.add(p.path)
      found.push(p)
    }
  }
  // 结构化路径字段：整条值就是一条路径，不能交给文本提取器切分。
  // extractAbsolutePaths() 的词法遇空白即停：带空格的绝对路径只会取到第一个空格之前那段，
  // 定域随即判成「工作区外」——工作区路径带空格时每次写文件都中招。
  // kind 仍需按 paths.mjs 的口径分档：设备是内核接口、程序安装根是「程序在哪」，
  // 两者都不算数据目标；直接标成 data 会让读 C:/Windows/System32、X:/Program Files/... 变成越界。
  const addStructured = (value) => {
    if (typeof value !== 'string') return
    if (found.length >= 24) return
    const raw = value.trim()
    if (!raw) return
    // 小写 + 正斜杠只用于分类判断，raw 原样保留（审计记录要能看出原始写法）
    const low = raw.toLowerCase().split('\\\\').join('/')
    // 非绝对形态（相对路径、变量拼出的片段）仍交回文本提取，行为不变
    if (!/^(?:[a-z]:|~)?\\//.test(low)) { add(raw); return }
    const kind = /^\\/(?:dev|proc|sys)(?:\\/|$)/.test(low) ? 'device'
      : (/^[a-z]:\\/windows\\/(?:system32|syswow64)\\//.test(low)
        || /^[a-z]:\\/program files(?: \\(x86\\))?\\//.test(low)
        || /^\\/(?:usr\\/)?(?:local\\/)?s?bin\\//.test(low)
        || low.startsWith('/opt/homebrew/bin/')
        || low.startsWith('/system/') || low.startsWith('/library/'))
        ? 'program' : 'data'
    if (seen.has(raw)) return
    seen.add(raw)
    found.push({ raw, path: raw, kind })
  }`

// 2) 显式文件字段改用 addStructured
const OLD_LOOP = `    if (Array.isArray(v)) v.forEach((one) => { if (typeof one === 'string') add(one) })
    else if (typeof v === 'string') add(v)`

const NEW_LOOP = `    if (Array.isArray(v)) v.forEach(addStructured)
    else addStructured(v)`

const mode = process.argv.includes('--dry-run') ? 'dry'
  : process.argv.includes('--status') ? 'status' : 'apply'

const dir = gateDir()
const file = join(dir, 'src', 'index.mjs')
if (!existsSync(file)) {
  console.error(`找不到审批门源码：${file}`)
  process.exit(1)
}
const src = readFileSync(file, 'utf8')
const patched = src.includes(MARKER)
// 文件是 CRLF 时锚点也要跟着换行，否则一处都匹配不上（别为了匹配去改整份文件的换行）
const eol = src.includes('\r\n') ? '\r\n' : '\n'
const withEol = (block) => block.split('\n').join(eol)

console.log(`审批门：${dir}`)
console.log(`目标文件：${file}（${src.length} 字节）`)
console.log(`当前状态：${patched ? '已打补丁' : '未打补丁'}`)

if (mode === 'status') process.exit(0)
if (patched) {
  console.log('无需重复修改。')
  process.exit(0)
}

const countOf = (hay, needle) => hay.split(needle).length - 1
const oAdd = withEol(OLD_ADD)
const nAdd = withEol(NEW_ADD)
const oLoop = withEol(OLD_LOOP)
const nLoop = withEol(NEW_LOOP)
const a = countOf(src, oAdd)
const b = countOf(src, oLoop)
console.log(`匹配：add 块 ${a} 处 / 文件字段循环 ${b} 处`)
if (a !== 1 || b !== 1) {
  console.error('锚点不唯一或已变化，放弃修改（避免改错位置）。')
  process.exit(2)
}

let out = src.replace(oAdd, nAdd).replace(oLoop, nLoop)
const lines = out.split('\n').length
console.log(`预计行数：${src.split('\n').length} → ${lines}`)

if (mode === 'dry') {
  console.log('--dry-run：未写入。')
  process.exit(0)
}

const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14)
const bak = `${file}.bak-targets-${stamp}`
writeFileSync(bak, src, 'utf8')
writeFileSync(file, out, 'utf8')
console.log(`已备份：${bak}`)
console.log(`已写入：${file}`)

try {
  execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' })
  console.log('语法检查：通过')
} catch (err) {
  console.error(`语法检查失败，正在回滚：${String(err.stderr || err)}`)
  writeFileSync(file, src, 'utf8')
  process.exit(3)
}
console.log('完成。重启 DSH 后生效。')
