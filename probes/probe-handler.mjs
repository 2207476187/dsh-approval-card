import { pathToFileURL } from 'node:url'
const DSH = (process.env.DSH_HOME ?? `${(process.env.USERPROFILE ?? '').replace(/\\/g, '/')}/.dsh`).replace(/\\/g, '/')
/**
 * 端到端校验插件入口（不只是纯函数）：用假 ctx 抓出 approval/request 处理器，
 * 对同一个 callId 连喂两条请求，看第二张卡是否自报序号、是否始终 return next()。
 *
 * 跑：node probes/probe-handler.mjs
 */
const mod = await import(pathToFileURL(`${DSH}/profiles/desktop/plugins/dsh-approval-card/src/index.mjs`).href)
const plugin = mod.default ?? mod

let handler = null
let registered = null
const ctx = {
	on(name, fn, opts) {
		registered = { name, prepend: opts?.prepend === true }
		handler = fn
	}
}

plugin.apply(ctx)
console.log('注册:', registered?.name, 'prepend=', registered?.prepend)
if (typeof handler !== 'function') throw new Error('没抓到处理器')

/** 一条真实形状的请求：审批门放行后工具再要更大权限。 */
function makeRequest(callId, reason) {
	return {
		toolName: 'pwsh',
		callId,
		reason,
		displayReason: undefined,
		agent: { session: { snapshotEvents: () => [] } }
	}
}

let nextCalls = 0
const next = async () => {
	nextCalls += 1
	return 'next-result'
}

const callId = 'call_probe_' + Date.now()
const first = makeRequest(callId, 'escalate sandbox to danger-full-access: 需要写系统临时目录里的校验文件')
const r1 = await handler(first, next)
console.log('\n--- 第 1 条请求 ---')
console.log('  next() 调用次数:', nextCalls, '| 返回:', JSON.stringify(r1))
console.log('  reason 未改:', first.reason)
console.log('  displayReason.zh =', JSON.stringify(first.displayReason?.zh))
console.log('  displayReason.en =', JSON.stringify(first.displayReason?.en))

const second = makeRequest(callId, 'escalate sandbox to danger-full-access: 需要写系统临时目录里的校验文件')
const r2 = await handler(second, next)
console.log('\n--- 第 2 条请求（同 callId）---')
console.log('  next() 调用次数:', nextCalls, '| 返回:', JSON.stringify(r2))
console.log('  reason 未改:', second.reason)
console.log('  displayReason.zh =', JSON.stringify(second.displayReason?.zh))

const third = makeRequest('call_probe_other_' + Date.now(), 'escalate sandbox to workspace-write: 只读目录里补一个文件')
await handler(third, next)
console.log('\n--- 另一个 callId 的第 1 条 ---')
console.log('  displayReason.zh =', JSON.stringify(third.displayReason?.zh))

// 卡片文案本来就合规（本次没改写）：重复请求照样要能标序号。
const preId = 'call_probe_pre_' + Date.now()
const preZh = `对 C:\\tmp\\b.txt 进行写入文件 [ 写入 ]${'\n'}权限：只读（不会修改任何文件）`
const pre1 = { toolName: 'pwsh', callId: preId, reason: '判定器不可用', displayReason: { zh: preZh, en: 'x' }, agent: { session: { snapshotEvents: () => [] } } }
await handler(pre1, next)
const pre2 = { toolName: 'pwsh', callId: preId, reason: '判定器不可用', displayReason: { zh: preZh, en: 'x' }, agent: { session: { snapshotEvents: () => [] } } }
await handler(pre2, next)
console.log('\n--- 文案已合规时：第 1 条 / 第 2 条 ---')
console.log('  第 1 条:', JSON.stringify(pre1.displayReason.zh))
console.log('  第 2 条:', JSON.stringify(pre2.displayReason.zh))

const ok =
	nextCalls === 5 &&
	r1 === 'next-result' &&
	r2 === 'next-result' &&
	first.displayReason?.zh?.includes('进行') &&
	!first.displayReason.zh.includes('个审批请求') &&
	second.displayReason?.zh?.includes('（同一次操作的第 2 个审批请求）') &&
	!third.displayReason?.zh?.includes('个审批请求') &&
	pre1.displayReason.zh.startsWith(preZh.split('\n')[0].trim()) &&
	pre1.displayReason.zh.includes('判定器不可用') &&
	pre2.displayReason.zh.includes('（同一次操作的第 2 个审批请求）')
console.log('\n断言:', ok ? '全部通过' : '有未通过项')
process.exit(ok ? 0 : 1)
