// 验证审批卡片文案修复：路径不再在空白处截断、目标取完整原文。
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'

const home = process.env.DSH_HOME ?? 'C:/Users/Administrator/.dsh'
const mod = await import(pathToFileURL(join(home, 'profiles/desktop/plugins/dsh-approval-zh/src/approval-zh.mjs')).href)

const { extractPaths, buildSummaryLine, hasSummary } = mod

const cases = [
	['未加引号、带空格', '删除 D:\\DeepSeek Harness工作目录\\DeepSeek\\tmp\\a.txt'],
	['单引号整段', "Remove-Item 'D:\\DeepSeek Harness工作目录\\DeepSeek\\tmp\\a.txt' -Force"],
	['双引号整段', 'Set-Content "D:\\DeepSeek Harness工作目录\\DeepSeek\\note b.txt" -Value x'],
	['普通短路径', 'cd C:\\Windows\\Temp && dir'],
	['相对无关', '这是一句没有路径的中文说明']
]

for (const [label, text] of cases) {
	console.log(`--- ${label}`)
	console.log(`    extractPaths -> ${JSON.stringify(extractPaths(text, 2))}`)
}

console.log('\n=== buildSummaryLine ===')
const summaryA = buildSummaryLine({
	toolName: 'write',
	mode: 'workspace-write',
	justification: '需要写审批门自己的日志目录',
	args: { file_path: 'D:\\DeepSeek Harness工作目录\\DeepSeek\\device-audit\\report-2026-11.json' },
	argsSource: 'callId',
	cwd: 'D:\\DeepSeek Harness工作目录\\DeepSeek'
})
console.log('write/mode:', JSON.stringify(summaryA))
console.log('hasSummary:', hasSummary(summaryA))

const summaryB = buildSummaryLine({
	toolName: 'pwsh',
	mode: '',
	justification: '读取 adb 设备属性',
	args: { command: "Get-Content 'D:\\DeepSeek Harness工作目录\\DeepSeek\\device-audit\\props.txt'" },
	argsSource: 'callId',
	cwd: 'D:\\DeepSeek Harness工作目录\\DeepSeek'
})
console.log('pwsh/no-mode:', JSON.stringify(summaryB))

const summaryC = buildSummaryLine({
	toolName: 'edit',
	mode: '',
	justification: '改审批门插件的文案',
	args: { file_path: 'C:\\Users\\Administrator\\.dsh\\profiles\\desktop\\plugins\\dsh-approval-zh\\src\\approval-zh.mjs' },
	argsSource: 'lastSameTool',
	cwd: 'D:\\DeepSeek Harness工作目录\\DeepSeek'
})
console.log('edit/lastSameTool:', JSON.stringify(summaryC))
