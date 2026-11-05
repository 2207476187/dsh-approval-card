// 端到端验证：两种审批请求形态在卡片上显示成什么。
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'

const home = process.env.DSH_HOME ?? 'C:/Users/<user>/.dsh'
const mod = await import(pathToFileURL(join(home, 'profiles/desktop/plugins/dsh-approval-zh/src/approval-zh.mjs')).href)
const { applySummaryText } = mod

/** 造一个只暴露 sessionEvents()/header.cwd 的假会话。 */
function sessionWith(events, cwd) {
	return { header: { cwd }, snapshotEvents: () => events }
}

const callEvent = (callId, name, args) => ({
	type: 'tool/call',
	data: { callId, name, arguments: JSON.stringify(args) }
})

function show(label, req) {
	applySummaryText(req)
	const en = req.displayReason?.en
	const zh = req.displayReason?.zh
	console.log(`--- ${label}`)
	console.log(`    reason(host)  : ${req.reason}`)
	console.log(`    displayReason : ${zh === undefined ? '(未设置，卡片将继续显示 reason)' : JSON.stringify(zh)}`)
	console.log(`    en            : ${en === undefined ? '(none)' : JSON.stringify(String(en).slice(0, 60))}`)
}

// A. 宿主模板提权（带 displayReason）
show('A 提权模板 / write', {
	toolName: 'write',
	callId: 'c1',
	reason: 'escalate sandbox to workspace-write: 需要把审计结果写进 device-audit',
	displayReason: {
		en: 'Allow this operation with workspace-write permissions: 需要把审计结果写进 device-audit',
		zh: '允许本次操作使用 workspace-write 权限：需要把审计结果写进 device-audit'
	},
	agent: { session: sessionWith([callEvent('c1', 'write', { file_path: 'D:\\DeepSeek Harness工作目录\\DeepSeek\\device-audit\\report.json' })], 'D:\\DeepSeek Harness工作目录\\DeepSeek') }
})

// B. 审批门转人工（没有 displayReason，reason 是它自己的中文说明）—— 用户抱怨的那一类
show('B 审批门 / pwsh 带空格路径', {
	toolName: 'pwsh',
	callId: 'c2',
	reason: '目标含工作区外路径 1 处：C:\\Windows\\Temp',
	agent: { session: sessionWith([callEvent('c2', 'pwsh', { command: "Get-Content 'D:\\DeepSeek Harness工作目录\\DeepSeek\\device-audit\\props.txt'" })], 'D:\\DeepSeek Harness工作目录\\DeepSeek') }
})

// C. 审批门 / edit，路径在工作区外（正是弹卡的常见情形）
show('C 审批门 / edit 工作区外', {
	toolName: 'edit',
	callId: 'c3',
	reason: '目标含工作区外路径 2 处：/proc/cmdline , D:\\DeepSeek',
	agent: { session: sessionWith([callEvent('c3', 'edit', { file_path: 'C:\\Users\\Administrator\\.dsh\\profiles\\desktop\\cordis.patch.yml' })], 'D:\\DeepSeek Harness工作目录\\DeepSeek') }
})

// D. 幂等：已经带总结的文案不应再叠加
show('D 幂等检查', {
	toolName: 'edit',
	callId: 'c4',
	reason: '目标含工作区外路径 1 处：D:\\DeepSeek',
	displayReason: { en: 'x', zh: '对 D:\\x 进行修改文件 [ 修改 ]\n权限：仅工作区可写（工作区外仍被拒绝）' },
	agent: { session: sessionWith([callEvent('c4', 'edit', { file_path: 'D:\\DeepSeek Harness工作目录\\DeepSeek\\a.md' })], 'D:\\DeepSeek Harness工作目录\\DeepSeek') }
})

// E. 看不见真实操作（无参数、无模式）：必须原样不动
show('E 无信息时不改', { toolName: 'unknown_tool', callId: 'c5', reason: '某处需要人工确认', agent: { session: sessionWith([], '') } })
