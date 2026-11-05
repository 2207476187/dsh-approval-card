// 临时探针：验证 dsh-approval-zh 的各段函数在真实输入下的输出。
import { pathToFileURL } from 'node:url'

const P = process.env.DSH_HOME + '/profiles/desktop/plugins/dsh-approval-zh/src/approval-zh.mjs'
const m = await import(pathToFileURL(P).href)

const reason = 'escalate sandbox to danger-full-access: 这条命令检查并修复工作区文件夹 D:\\DeepSeek Harness工作目录\\DeepSeek 及其上级目录的 Windows 文件权限：给当前登录用户补上缺失的完全控制权限，并清理其中残留的其它应用包权限项。它不改文件内容和所有者，每条改动都会备份并留下可回滚命令。现在沙箱无法在该工作区读写，必须先修好权限才能继续当前任务。'
const displayZh = '允许本次操作使用 danger-full-access 权限：' + reason.slice(reason.indexOf(': ') + 2)

const MODE_SCOPE = {
  'read-only': 1,
  'workspace-write': 1,
  'danger-full-access': 1
}
const mode = Object.keys(MODE_SCOPE).find((x) => reason.includes(x)) ?? ''
const cut = reason.indexOf(': ')
const justification = cut >= 0 ? reason.slice(cut + 2) : ''

const args = {
  command: "icacls 'D:\\DeepSeek Harness工作目录\\DeepSeek' /grant '<user>:(OI)(CI)F' /T",
  justification,
  sandbox_permissions: 'danger-full-access'
}

const localized = m.localizeSandboxModes(displayZh)
const has = m.hasSummary(localized)
const summary = m.buildSummaryLine({
  toolName: 'pwsh',
  mode,
  justification,
  args,
  argsSource: 'callId',
  cwd: 'D:\\DeepSeek Harness工作目录\\DeepSeek'
})
const zh = m.toDisplayText(`${summary}\n${localized}`)

console.log('mode            =', JSON.stringify(mode))
console.log('hasSummary      =', has)
console.log('summary         =', JSON.stringify(summary))
console.log('segments        =', m.toDisplayText(summary).split(' \n'))
console.log('final zh        =', JSON.stringify(zh))
