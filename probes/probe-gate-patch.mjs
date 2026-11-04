#!/usr/bin/env node
/**
 * 验证 tools/patch-approval-gate.mjs 打上的补丁行为（不需要重启 DSH）。
 *
 * 做法：从门的源码里把 addStructured 函数体原样抠出来，用真实依赖
 * （paths.mjs 的 extractAbsolutePaths / classifyPathScope / resolveRoots）跑一遍，
 * 断言「结构化字段整条收下、kind 分档不变、定域结果正确」。
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { extractAbsolutePaths, classifyPathScope, resolveRoots } from 'file:///C:/Users/Administrator/.dsh/profiles/desktop/node_modules/dsh-approval-gate/src/paths.mjs'

const PROFILE = 'C:\\Users\\Administrator\\.dsh\\profiles\\desktop'
const WS = 'D:\\DeepSeek Harness工作目录\\DeepSeek'
const req = createRequire(join(PROFILE, 'package.json'))
const src = readFileSync(join(dirname(dirname(req.resolve('dsh-approval-gate'))), 'src', 'index.mjs'), 'utf8')

const START = 'const addStructured = (value) => {'
const END = "  for (const k of ['file_path'"
const i = src.indexOf(START)
const j = src.indexOf(END, i)
if (i < 0 || j < 0) {
  console.error('补丁未打：源码里找不到 addStructured')
  process.exit(1)
}
const body = src.slice(i, j)
const make = new Function('found', 'seen', 'add', 'extractAbsolutePaths', `${body}\n return addStructured`)

const roots = resolveRoots(WS, { dshHome: 'C:\\Users\\Administrator\\.dsh' })

function run(value) {
  const found = []
  const seen = new Set()
  const add = (text) => {
    for (const p of extractAbsolutePaths(text)) {
      if (seen.has(p.path)) continue
      seen.add(p.path)
      found.push(p)
    }
  }
  make(found, seen, add, extractAbsolutePaths)(value)
  const scope = classifyPathScope(found, roots)
  return { found, scope: scope.scope, outside: scope.outside }
}

const cases = [
  ['工作区内文件（路径含空格，之前的病根）', 'D:\\DeepSeek Harness工作目录\\DeepSeek\\docs\\devlog\\2026-11.md', 'data', 'inside'],
  ['工作区根下的探针', 'D:\\DeepSeek Harness工作目录\\DeepSeek\\probes\\probe-handler.mjs', 'data', 'inside'],
  ['DSH 程序目录（程序路径不算数据目标）', 'X:\\Program Files\\DeepSeek Harness\\resources\\app\\dsh\\index.js', 'program', 'unknown'],
  ['系统目录', 'C:\\Windows\\System32\\drivers\\etc\\hosts', 'program', 'unknown'],
  ['UNC 共享', '\\\\server\\share\\a.txt', 'data', 'outside'],
  ['POSIX 根', '/data/adb/modules', 'data', 'outside'],
  ['设备/伪文件', '/proc/cmdline', 'device', 'unknown'],
  ['相对路径（交回文本提取，取不到绝对路径）', 'src/text.mjs', null, 'unknown'],
  ['真实工作区外路径仍要拦', 'C:\\Users\\Administrator\\.ssh\\id_rsa', 'data', 'outside'],
]

let fail = 0
for (const [label, value, wantKind, wantScope] of cases) {
  const { found, scope } = run(value)
  const kind = found.length === 1 ? found[0].kind : (found.length === 0 ? null : `多值:${found.map((f) => f.kind)}`)
  const okKind = kind === wantKind
  const okScope = scope === wantScope
  if (!okKind || !okScope) fail += 1
  console.log(`${okKind && okScope ? 'PASS' : 'FAIL'}  ${label}`)
  console.log(`      value = ${value}`)
  console.log(`      entries = ${found.length}  kind = ${kind}  scope = ${scope}`)
  if (found.length > 0) console.log(`      raw = ${found[0].raw}`)
}
console.log(fail === 0 ? '\n断言: 全部通过' : `\n断言: ${fail} 条不符`)
process.exit(fail === 0 ? 0 : 1)
