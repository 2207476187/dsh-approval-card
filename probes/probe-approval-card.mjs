/**
 * dsh-approval-card 端到端探针：不重启 DSH，直接把插件挂到一个假 ctx 上跑一次审批请求。
 * 验证四件事：prepend 注册、会话里能取到工具参数、displayReason.zh 被写成两行、reason 原样不动。
 */
const DSH_HOME = process.env.DSH_HOME
const PLUGIN = `file:///${DSH_HOME.replace(/\\/g, '/')}/profiles/desktop/plugins/dsh-approval-card/src/index.mjs`
const WORK = 'D:\\DeepSeek Harness工作目录\\DeepSeek'

/** 抓出插件注册的审批处理器。 */
const handlers = []
const ctx = {
	on(name, fn, opts) {
		handlers.push({ name, fn, opts })
	}
}

const mod = await import(PLUGIN)
mod.default.apply(ctx)

const reg = handlers.find((h) => h.name === 'approval/request')
console.log('register:', reg ? `ok prepend=${String(reg.opts?.prepend)}` : 'MISSING')

/** 造一个最小会话：两条 tool/call 事件。 */
function makeSession() {
	const events = [
		{ type: 'tool/call', data: { callId: 'c-old', name: 'pwsh', arguments: '{"command":"Get-ChildItem"}' } },
		{
			type: 'tool/call',
			data: {
				callId: 'c-1',
				name: 'write',
				arguments: JSON.stringify({ file_path: `${WORK}\\device-audit\\report-2026-11.json`, content: 'x' })
			}
		}
	]
	return { header: { cwd: WORK }, snapshotEvents: () => events }
}

async function run(label, req) {
	let nextCalls = 0
	await reg.fn(req, () => {
		nextCalls += 1
		return 'downstream'
	})
	console.log(`\n--- ${label} ---`)
	console.log('next() 调用次数:', nextCalls)
	console.log('reason 是否原样:', req.reason)
	if (req.displayReason === undefined) {
		console.log('displayReason: (未改动)')
		return
	}
	for (const line of req.displayReason.zh.split(' \n')) console.log('zh|', line)
}

// 1) 审批门转人工（正文来自 gate，没有 displayReason，且路径被判为工作区外）
await run('gate 转人工', {
	toolName: 'write',
	callId: 'c-1',
	reason: '目标含工作区外路径 1 处：C:\\Windows\\Temp',
	agent: { session: makeSession() }
})

// 2) 宿主提权模板（displayReason 已是英文/中文模板，中文里 mode 未翻译）
await run('宿主提权模板', {
	toolName: 'pwsh',
	callId: 'no-such-call',
	reason: 'escalate sandbox to workspace-write: 需要在工作区外读 adb 属性',
	displayReason: {
		en: 'Allow this operation with workspace-write permissions: 需要在工作区外读 adb 属性',
		zh: '允许本次操作使用 workspace-write 权限：需要在工作区外读 adb 属性'
	},
	agent: { session: makeSession() }
})

// 3) 完全拿不到信息：必须一动不动
await run('无信息', {
	toolName: 'some_tool',
	callId: 'c-none',
	reason: '需要人工确认',
	agent: { session: { header: { cwd: '' }, snapshotEvents: () => [] } }
})
