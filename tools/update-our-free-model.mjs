#!/usr/bin/env node
/**
 * 用插件自带的更新清单（feed/manifest.json）把 dsh-our-free-model 升到作者发布的最新版。
 *
 * 为什么不用 npm / 插件市场：这个包在 npm 上只发到 2.1.0，作者的后续版本走自己的
 * feed 通道（src/updater.js 里 REPO = 'Ebony-Vinyl/dsh-our-free-model'，清单在
 * <repo>/main/feed/manifest.json，每个文件带 sha256）。本脚本复刻那条通道：
 * 拉清单 → 逐文件下载 → 校验 size+sha256 → 落盘。校验不过就不写，写前先备份。
 *
 * 用法（在任意目录）：
 *   node tools/update-our-free-model.mjs             # 真升级
 *   node tools/update-our-free-model.mjs --dry-run   # 只报告差异，不落盘
 *   node tools/update-our-free-model.mjs --dir <包目录>
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync, cpSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'

const REPO = 'Ebony-Vinyl/dsh-our-free-model'
const BRANCH = 'main'
const MANIFEST_URL = `https://raw.githubusercontent.com/${REPO}/${BRANCH}/feed/manifest.json`

const argv = process.argv.slice(2)
const dryRun = argv.includes('--dry-run')
const dirFlag = argv.indexOf('--dir')
const packageDir = resolve(
  dirFlag >= 0 && argv[dirFlag + 1]
    ? argv[dirFlag + 1]
    : join(homedir(), '.dsh', 'profiles', 'desktop', 'node_modules', 'dsh-our-free-model'),
)

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex')
const kb = (n) => `${(n / 1024).toFixed(1)} KB`

async function get(url, asBuffer) {
  const response = await fetch(url, { headers: { 'user-agent': 'dsh-ofm-updater' } })
  if (!response.ok) throw new Error(`HTTP ${response.status} ${url}`)
  return asBuffer ? Buffer.from(await response.arrayBuffer()) : await response.text()
}

const manifest = JSON.parse(await get(MANIFEST_URL, false))
if (!Array.isArray(manifest.files) || manifest.files.length === 0) throw new Error('清单里没有 files[]')
const baseUrl = new URL(manifest.base ?? '../', MANIFEST_URL).href

const installedPath = join(packageDir, 'package.json')
const installedVersion = existsSync(installedPath)
  ? JSON.parse(readFileSync(installedPath, 'utf8')).version
  : '(未安装)'

console.log(`包目录   ${packageDir}`)
console.log(`已安装   ${installedVersion}`)
console.log(`清单版本 ${manifest.version}  (${manifest.publishedAt})`)

const same = installedVersion === manifest.version
if (same) {
  console.log('版本相同，无事可做。')
  process.exit(0)
}

if (!existsSync(installedPath)) throw new Error(`目标不是插件包目录：${packageDir}`)

if (dryRun) {
  console.log(`\n[dry-run] 将要写入 ${manifest.files.length} 个文件，合计 ${kb(manifest.files.reduce((s, f) => s + f.size, 0))}`)
  process.exit(0)
}

// 整目录备份（插件自己的安装器也保留备份，便于回滚）
const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
const backupDir = `${packageDir}.bak-${stamp}`
cpSync(packageDir, backupDir, { recursive: true })
console.log(`备份     ${backupDir}`)

let written = 0
let bytes = 0
const failures = []
for (const file of manifest.files) {
  const url = `${baseUrl}${file.path}`
  try {
    const body = await get(url, true)
    if (body.length !== file.size) throw new Error(`size ${body.length} != ${file.size}`)
    if (sha256(body) !== file.sha256) throw new Error('sha256 mismatch')
    const target = join(packageDir, file.path)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, body)
    written += 1
    bytes += body.length
  } catch (error) {
    failures.push(`${file.path}: ${error.message}`)
  }
}

console.log(`\n写入 ${written}/${manifest.files.length} 个文件，${kb(bytes)}`)
if (failures.length > 0) {
  console.log(`失败 ${failures.length} 个：`)
  for (const line of failures.slice(0, 20)) console.log(`  ${line}`)
  console.log(`\n备份仍在 ${backupDir}；如需回滚：把备份目录内容拷回 ${packageDir}`)
  process.exit(1)
}
console.log(`磁盘版本现在是 ${JSON.parse(readFileSync(installedPath, 'utf8')).version}`)
console.log(`旧版整目录已备份在 ${backupDir}，确认新版可用后可自行删除`)
