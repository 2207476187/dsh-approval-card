/**
 * dsh-hooks-shim 自测 —— 验证与官方 @deepseek-ai/dsh-hooks-claude-code 的行为一致性。
 *
 * 跑法（无需安装任何依赖）：
 *   node test/selftest.mjs
 *
 * ⚠ 本机 DSH 沙箱的关键限制：
 *   Node 的 child_process.spawn 用 stdio:'pipe' 会被直接判 EPERM（沙箱禁命名管道），
 *   只有 stdio:'inherit' / 'ignore' 能起来。所以这里注入一个「假 shell 服务」——
 *   它正是生产环境里的真实形态（shim 声明 inject:['shell']，优先走 shell.execute），
 *   内部用 stdio:'ignore' + 重定向到文件来捕获 stdout/stderr。
 *
 * 覆盖：
 *   1. hooks.json 解析（matcher / match-all 哨兵 / 无 matcher 事件 / 非 command / 坏 JSON）
 *   2. 输出解码（exit 2 = block、结构化 JSON、hookEventName 门控）
 *   3. 决策合并（deny > ask > allow）
 *   4. PreToolUse 的返回值映射 —— 审批卡的入口
 *   5. 其余扩展点（agent/pre-step reject、tools/post-execute block）
 */

import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, basename } from 'node:path'
import { spawnSync } from 'node:child_process'

const mod = await import('../src/index.mjs')
const { apply, name, inject } = mod

let pass = 0
const failures = []

async function test(label, fn) {
  try {
    await fn()
    pass++
    console.log(`  ok   ${label}`)
  } catch (error) {
    failures.push({ label, error })
    console.log(`  FAIL ${label}`)
    const msg = error && error.message ? String(error.message) : String(error)
    console.log(`       ${msg.split('\n').slice(0, 6).join('\n       ')}`)
  }
}

/* ================================================================== */
/* 假 shell 服务 —— 复刻 ctx.shell.execute / ctx.shell.resolve 契约      */
/* ================================================================== */

/**
 * 生产环境里 ctx.shell.execute(ctx.shell.resolve(request)) 返回一个
 * 带 .result() 的句柄，result() 解析成 {exitCode, stdout:{text}, stderr:{text}}。
 *
 * 这里用 spawnSync（同步、stdio 走默认 pipe…也不允许），所以改用
 * stdio:'ignore' 的子进程 + cmd 重定向把输出落到文件。这是沙箱下唯一可行解。
 */
let tmpSeq = 0

/**
 * 一个「无管道」的 spawn 包装。
 *
 * 沙箱禁命名管道，stdio:'pipe' 必然 EPERM，所以只能：
 *   · 把 stdin 预写成文件，脚本里 `< in.txt` 重定向；
 *   · 用 `> out.txt 2> err.txt` 收输出；
 *   · 退出码用**两行**的 .bat 抓（`call` + `%ERRORLEVEL%`）。
 *
 * ★ 关键坑（已实测）：`cmd /c "a.exe & echo %ERRORLEVEL%"` 里 `%ERRORLEVEL%`
 *   会在**整行解析时**就被展开成调用前的旧值（0），拿不到 a.exe 的退出码。
 *   即使写成两行 bat，`echo %ERRORLEVEL%` 也会在**复合行的第一时间**展开，
 *   结果同一个 0。唯一可靠写法是 `call echo %%ERRORLEVEL%%` 走二次解析。
 */
const NO_PIPE_HELPER = '__no_pipe_spawn__'

function shellQuoteForCmd(text) {
  // 只用于我们自造的临时路径，全部是 ASCII 且无空格以外特殊字符
  return `"${text}"`
}

function buildBat({ command, stdinFile, outFile, errFile, codeFile }) {
  return (
    [
      '@echo off',
      `${command} < ${shellQuoteForCmd(stdinFile)} > ${shellQuoteForCmd(outFile)} 2> ${shellQuoteForCmd(errFile)}`,
      // `set RC=%ERRORLEVEL%` 解析这一行时就展开了 → 拿到的是上一条命令的真实值
      'set RC=%ERRORLEVEL%',
      `> ${shellQuoteForCmd(codeFile)} echo %RC%`,
    ].join('\r\n') + '\r\n'
  )
}

function makeFakeShell() {
  const runs = []
  return {
    runs,
    /** 与真实 ctx.shell.resolve 同形：把请求规整成可执行句柄描述。 */
    resolve(request) {
      return request
    },
    /** 与真实 ctx.shell.execute 同形：返回 { result: async () => {...} }。 */
    async execute(request) {
      return {
        async result() {
          const outDir = mkdtempSync(join(tmpdir(), 'shim-cap-'))
          const n = ++tmpSeq
          const outFile = join(outDir, `o${n}.txt`)
          const errFile = join(outDir, `e${n}.txt`)
          const codeFile = join(outDir, `c${n}.txt`)
          const inFile = join(outDir, `i${n}.txt`)
          const batFile = join(outDir, `r${n}.bat`)
          try {
            writeFileSync(inFile, request.stdin ?? '')
            writeFileSync(
              batFile,
              buildBat({ command: String(request.command), stdinFile: inFile, outFile, errFile, codeFile }),
              'latin1',
            )

            /**
             * ★ 关键坑（已实测两轮）：
             *   ① `cmd /d /s /c "<绝对路径>.bat"` —— node 的 spawnSync 在 Windows 上
             *      会做一层「参数里的双引号转义」，cmd 收到的实际是
             *      `\"C:\...\r1.bat\"`，于是 `'\"r1.bat\"' is not recognized`，
             *      退出码 1、stderr 为空、四个捕获文件全空。这就是前两轮
             *      11 passed / 10 failed 的真因，跟 shim 逻辑无关。
             *   ② 换成 `cd /d "dir" & "r1.bat"` 也会因为同样的转义把 `&` 前的
             *      引号打乱。
             *   唯一稳的形态：**绝对路径、不加引号**（临时目录名不含空格）。
             */
            const batInvocation = `${outDir}\\${basename(batFile)}`

            const child = spawnSync(
              'cmd.exe',
              ['/d', '/s', '/c', batInvocation],
              {
                cwd: request.workdir,
                env: { ...process.env, ...(request.env ?? {}) },
                windowsHide: true,
                stdio: 'ignore', // ★ 沙箱只在 ignore/inherit 下允许 spawn
                timeout: request.timeoutMs,
              },
            )

            runs.push({ command: String(request.command), status: child.status, error: child.error ? String(child.error) : undefined })

            const read = (p) => {
              try {
                return existsSync(p) ? readFileSync(p, 'utf8') : ''
              } catch {
                return ''
              }
            }

            if (process.env.SHIM_DEBUG_FAKESHELL) {
              const cmdText = String(request.command)
              const hookPath = (cmdText.match(/"([^"]+\.cjs)"/) || [])[1]
              console.log(`[fakeshell] execPath=${JSON.stringify(process.execPath)}`)
              console.log(`[fakeshell] hookPath=${JSON.stringify(hookPath)} exists=${hookPath ? existsSync(hookPath) : 'n/a'}`)
              console.log(`[fakeshell] cmd=${JSON.stringify(cmdText)}`)
              console.log(`[fakeshell] child.status=${child.status} error=${child.error ? String(child.error) : 'none'} signal=${child.signal}`)
              console.log(`[fakeshell] out=${JSON.stringify(read(outFile))} err=${JSON.stringify(read(errFile))} code=${JSON.stringify(read(codeFile))}`)
            }
            const exitRaw = read(codeFile).trim()
            let exitCode
            if (exitRaw !== '' && Number.isFinite(Number(exitRaw))) exitCode = Number(exitRaw)
            else if (typeof child.status === 'number') exitCode = child.status

            return {
              exitCode,
              stdout: { text: read(outFile) },
              stderr: { text: read(errFile) },
            }
          } finally {
            rmSync(outDir, { recursive: true, force: true })
          }
        },
      }
    },
  }
}

/* ================================================================== */
/* 假 ctx                                                             */
/* ================================================================== */

/**
 * ★ 极小的事件总线。官方 cordis 的 `ctx.on()` 返回 disposer、`ctx.get()` 取服务。
 * 第一版这里把 handler 存进 Map，同一事件被注册两次时后者覆盖前者 —— 于是
 * 「两条 hook 组」的合并用例永远只跑到一条，全部假性通过/假性失败。
 * 改成数组，语义与 cordis 一致（多监听器按注册序全部保留）。
 */
function fakeCtx(logs, shell) {
  const handlers = new Map() // event -> [fn, ...]
  const push = (level) => (msg) => logs.push(`${level}: ${msg}`)
  return {
    logger: { info: push('info'), warn: push('warn'), error: push('error'), debug: push('debug') },
    on(event, fn) {
      const list = handlers.get(event) ?? []
      list.push(fn)
      handlers.set(event, list)
      return () => {
        const cur = handlers.get(event) ?? []
        const i = cur.indexOf(fn)
        if (i >= 0) cur.splice(i, 1)
      }
    },
    get(service) {
      if (service === 'shell') return shell
      return undefined
    },
    /** 取该事件的「主处理器」：本插件每一类事件只注册一次，多余的是测试自己加的。 */
    handlers,
    first(event) {
      const list = handlers.get(event)
      return list && list.length > 0 ? list[0] : undefined
    },
  }
}

/* ================================================================== */
/* 临时 hook 脚本                                                      */
/* ================================================================== */

let seq = 0

/**
 * 造一个 hook 脚本：从 stdin 读 payload，按参数输出。
 * __EVENT__ 会被替换成 payload.hook_event_name（用于测 hookEventName 门控）。
 */
function makeHook({ stdoutText = '', stderrText = '', exitCode = 0, sleepMs = 0 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'shim-hook-'))
  const file = join(dir, `h${++seq}.cjs`)
  const body = `
let raw = ''
process.stdin.on('data', (d) => { raw += d })
process.stdin.on('end', async () => {
  let payload = null
  try { payload = JSON.parse(raw) } catch {}
  const ev = payload && payload.hook_event_name ? payload.hook_event_name : ''
  const out = ${JSON.stringify(stdoutText)}
  const err = ${JSON.stringify(stderrText)}
  ${sleepMs > 0 ? `await new Promise((r) => setTimeout(r, ${sleepMs}))` : ''}
  if (out) process.stdout.write(out.split('__EVENT__').join(ev))
  if (err) process.stderr.write(err)
  process.exit(${exitCode})
})
// 保活，等 stdin EOF
setTimeout(() => {}, 120000)
`
  writeFileSync(file, body)
  return { dir, command: `"${process.execPath}" "${file}"` }
}

/* ================================================================== */
/* 驱动                                                               */
/* ================================================================== */

function makeEnv(hooksJson, config = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'shim-run-'))
  writeFileSync(join(dir, 'hooks.json'), JSON.stringify(hooksJson))
  const logs = []
  const shell = makeFakeShell()
  const ctx = fakeCtx(logs, shell)
  apply(ctx, { hooksFile: 'hooks.json', hooksDir: dir, ...config })
  return { dir, logs, shell, ctx }
}

async function runPreToolUse({ hooksJson, config = {}, toolName = 'pwsh' }) {
  const env = makeEnv(hooksJson, config)
  try {
    const preExecute = env.ctx.first('tools/pre-execute')
    if (!preExecute) throw new Error(`tools/pre-execute 未注册；日志：${env.logs.join(' | ')}`)
    const result = await preExecute(
      {
        name: toolName,
        arguments: { command: 'echo hi' },
        callId: 'call-1',
        signal: undefined,
        agent: { session: { header: { id: 'sess-1', cwd: env.dir } } },
      },
      async () => ({ kind: 'allow' }),
    )
    return { result, logs: env.logs, shell: env.shell }
  } finally {
    rmSync(env.dir, { recursive: true, force: true })
  }
}

const preDeny = () =>
  JSON.stringify({
    hookSpecificOutput: { hookEventName: '__EVENT__', permissionDecision: 'deny', permissionDecisionReason: 'nope' },
  })

const preAsk = () =>
  JSON.stringify({
    hookSpecificOutput: { hookEventName: '__EVENT__', permissionDecision: 'ask', permissionDecisionReason: '请人工确认' },
  })

/* ================================================================== */
/* 1. 配置解析                                                         */
/* ================================================================== */

console.log('\n[1] hooks.json 解析')

await test('带外层 hooks 键的 Claude 结构', async () => {
  const h = makeHook({})
  const env = makeEnv({ hooks: { PreToolUse: [{ matcher: 'pwsh', hooks: [{ type: 'command', command: h.command, timeout: 5 }] }] } })
  try {
    assert.ok(env.logs.some((l) => l.includes('loaded 1 hook group')), env.logs.join(' | '))
  } finally {
    rmSync(env.dir, { recursive: true, force: true })
  }
})

await test('不带 hooks 键的裸事件表', async () => {
  const h = makeHook({})
  const env = makeEnv({ PostToolUse: [{ matcher: '*', hooks: [{ command: h.command }] }] })
  try {
    assert.ok(env.logs.some((l) => l.includes('loaded 1 hook group')), env.logs.join(' | '))
  } finally {
    rmSync(env.dir, { recursive: true, force: true })
  }
})

await test('matcher "*" 是 match-all，不是非法正则', async () => {
  const h = makeHook({ stdoutText: preDeny() })
  const { result } = await runPreToolUse({
    hooksJson: { hooks: { PreToolUse: [{ matcher: '*', hooks: [{ command: h.command }] }] } },
  })
  assert.equal(result.kind, 'deny')
})

await test('matcher "" 也是 match-all', async () => {
  const h = makeHook({ stdoutText: preDeny() })
  const { result } = await runPreToolUse({
    hooksJson: { hooks: { PreToolUse: [{ matcher: '', hooks: [{ command: h.command }] }] } },
  })
  assert.equal(result.kind, 'deny')
})

await test('非 command 类型被跳过并告警', async () => {
  const env = makeEnv({ hooks: { PreToolUse: [{ hooks: [{ type: 'prompt', command: 'ignored' }] }] } })
  try {
    assert.ok(env.logs.some((l) => l.includes('skipping unsupported "prompt"')), env.logs.join(' | '))
  } finally {
    rmSync(env.dir, { recursive: true, force: true })
  }
})

await test('配置缺失时静默不注册', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'shim-none-'))
  try {
    const logs = []
    assert.doesNotThrow(() => apply(fakeCtx(logs, makeFakeShell()), { hooksFile: 'nope.json', hooksDir: dir }))
    assert.ok(logs.some((l) => l.includes('no hook config')), logs.join(' | '))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

await test('坏 JSON 时静默降级，不抛异常', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'shim-bad-'))
  try {
    writeFileSync(join(dir, 'hooks.json'), '{ this is not json')
    const logs = []
    assert.doesNotThrow(() => apply(fakeCtx(logs, makeFakeShell()), { hooksFile: 'hooks.json', hooksDir: dir }))
    assert.ok(logs.some((l) => l.includes('could not load hook config')), logs.join(' | '))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

await test('UserPromptSubmit 上的 matcher 被丢弃（无 matcher 主体）', async () => {
  const h = makeHook({})
  const env = makeEnv({ hooks: { UserPromptSubmit: [{ matcher: 'never-matches', hooks: [{ command: h.command }] }] } })
  try {
    const preStep = env.ctx.first('agent/pre-step')
    assert.ok(preStep, 'agent/pre-step 应被注册')
    const out = await preStep(
      { agent: { session: { header: { id: 's', cwd: env.dir } } }, messages: [{ content: [{ type: 'text', text: 'hi' }] }], turn: 1 },
      async () => ({ kind: 'enter', messages: [] }),
    )
    assert.equal(out.kind, 'enter') // matcher 被丢弃 ⇒ hook 照跑；hook 无输出 ⇒ 不阻断
  } finally {
    rmSync(env.dir, { recursive: true, force: true })
  }
})

/* ================================================================== */
/* 2 & 4. PreToolUse 返回值映射                                        */
/* ================================================================== */

console.log('\n[2] PreToolUse 返回值映射（审批卡的入口）')

await test('permissionDecision=deny → {kind:"deny"}', async () => {
  const h = makeHook({ stdoutText: preDeny() })
  const { result, logs } = await runPreToolUse({
    hooksJson: { hooks: { PreToolUse: [{ matcher: 'pwsh', hooks: [{ command: h.command }] }] } },
  })
  assert.equal(result.kind, 'deny', `日志：${logs.slice(-3).join(' | ')}`)
  assert.match(String(result.reason), /nope/)
})

await test('permissionDecision=ask → {kind:"ask"}', async () => {
  const h = makeHook({ stdoutText: preAsk() })
  const { result } = await runPreToolUse({
    hooksJson: { hooks: { PreToolUse: [{ matcher: 'pwsh', hooks: [{ command: h.command }] }] } },
  })
  assert.equal(result.kind, 'ask')
  assert.match(String(result.reason), /请人工确认/)
})

await test('无输出 → next()，即 {kind:"allow"}', async () => {
  const h = makeHook({})
  const { result } = await runPreToolUse({
    hooksJson: { hooks: { PreToolUse: [{ matcher: 'pwsh', hooks: [{ command: h.command }] }] } },
  })
  assert.equal(result.kind, 'allow')
})

await test('exit code 2 → 折成 deny，reason 取 stderr', async () => {
  const h = makeHook({ stderrText: 'blocked by exit 2', exitCode: 2 })
  const { result } = await runPreToolUse({
    hooksJson: { hooks: { PreToolUse: [{ matcher: 'pwsh', hooks: [{ command: h.command }] }] } },
  })
  assert.equal(result.kind, 'deny')
  assert.match(String(result.reason), /blocked by exit 2/)
})

await test('hookEventName 不匹配 → 事件字段被丢弃', async () => {
  const h = makeHook({
    stdoutText: JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PostToolUse', permissionDecision: 'deny', permissionDecisionReason: 'wrong event' },
    }),
  })
  const { result } = await runPreToolUse({
    hooksJson: { hooks: { PreToolUse: [{ matcher: 'pwsh', hooks: [{ command: h.command }] }] } },
  })
  assert.equal(result.kind, 'allow', '错事件的 permissionDecision 不应生效')
})

await test('命令不存在 → 不阻断（failMode 默认 open）', async () => {
  const { result } = await runPreToolUse({
    hooksJson: { hooks: { PreToolUse: [{ matcher: 'pwsh', hooks: [{ command: 'definitely-not-real-cmd-xyz --flag' }] }] } },
  })
  assert.equal(result.kind, 'allow')
})

/* ================================================================== */
/* 3. 决策合并                                                         */
/* ================================================================== */

console.log('\n[3] 决策合并（deny > ask > allow）')

await test('allow + deny 并存 → 取 deny', async () => {
  const h1 = makeHook({
    stdoutText: JSON.stringify({ hookSpecificOutput: { hookEventName: '__EVENT__', permissionDecision: 'allow' } }),
  })
  const h2 = makeHook({
    stdoutText: JSON.stringify({ hookSpecificOutput: { hookEventName: '__EVENT__', permissionDecision: 'deny', permissionDecisionReason: 'second says no' } }),
  })
  const { result } = await runPreToolUse({
    hooksJson: {
      hooks: {
        PreToolUse: [
          { matcher: 'pwsh', hooks: [{ command: h1.command }] },
          { matcher: 'pwsh', hooks: [{ command: h2.command }] },
        ],
      },
    },
  })
  assert.equal(result.kind, 'deny')
  assert.match(String(result.reason), /second says no/)
})

await test('ask + deny 并存 → 取 deny', async () => {
  const h1 = makeHook({ stdoutText: preAsk() })
  const h2 = makeHook({ stderrText: 'deny-reason', exitCode: 2 })
  const { result } = await runPreToolUse({
    hooksJson: {
      hooks: {
        PreToolUse: [
          { matcher: 'pwsh', hooks: [{ command: h1.command }] },
          { matcher: 'pwsh', hooks: [{ command: h2.command }] },
        ],
      },
    },
  })
  assert.equal(result.kind, 'deny')
})

await test('matcher 不匹配则不执行', async () => {
  const h = makeHook({ stdoutText: preDeny() })
  const { result } = await runPreToolUse({
    hooksJson: { hooks: { PreToolUse: [{ matcher: 'bash', hooks: [{ command: h.command }] }] } },
    toolName: 'pwsh',
  })
  assert.equal(result.kind, 'allow')
})

await test('matcher 用 | 分隔的候选列表能命中', async () => {
  const h = makeHook({ stdoutText: preDeny() })
  const { result } = await runPreToolUse({
    hooksJson: { hooks: { PreToolUse: [{ matcher: 'bash|pwsh', hooks: [{ command: h.command }] }] } },
    toolName: 'pwsh',
  })
  assert.equal(result.kind, 'deny')
})

/* ================================================================== */
/* 5. 其余扩展点                                                       */
/* ================================================================== */

console.log('\n[4] 其余扩展点')

await test('7 个扩展点全部注册', async () => {
  const env = makeEnv({ hooks: { PreToolUse: [] } })
  try {
    for (const pt of [
      'agent/created',
      'agent/pre-step',
      'tools/pre-execute',
      'tools/post-execute',
      'agent/turn-stopping',
      'subagent/start',
      'subagent/end',
    ]) {
      assert.ok(env.ctx.handlers.has(pt), `缺少扩展点 ${pt}`)
    }
  } finally {
    rmSync(env.dir, { recursive: true, force: true })
  }
})

await test('agent/pre-step deny → {kind:"reject"}', async () => {
  const h = makeHook({ stdoutText: preDeny() })
  const env = makeEnv({ hooks: { UserPromptSubmit: [{ hooks: [{ command: h.command }] }] } })
  try {
    const preStep = env.ctx.first('agent/pre-step')
    const out = await preStep(
      { agent: { session: { header: { id: 's', cwd: env.dir } } }, messages: [{ content: [{ type: 'text', text: 'hi' }] }], turn: 1 },
      async () => ({ kind: 'enter', messages: [] }),
    )
    assert.equal(out.kind, 'reject')
  } finally {
    rmSync(env.dir, { recursive: true, force: true })
  }
})

await test('tools/post-execute deny → {kind:"block"} 且带 feedback', async () => {
  const h = makeHook({
    stdoutText: JSON.stringify({ hookSpecificOutput: { hookEventName: '__EVENT__', permissionDecision: 'deny', permissionDecisionReason: 'post blocked' } }),
  })
  const env = makeEnv({ hooks: { PostToolUse: [{ matcher: 'pwsh', hooks: [{ command: h.command }] }] } })
  try {
    const postExec = env.ctx.first('tools/post-execute')
    const out = await postExec(
      { name: 'pwsh', arguments: {}, callId: 'c1', signal: undefined, agent: { session: { header: { id: 's', cwd: env.dir } } } },
      { content: [{ type: 'text', text: 'result' }] },
      async () => ({ kind: 'accept' }),
    )
    assert.equal(out.kind, 'block')
    assert.equal(out.feedback[0].text, 'post blocked')
  } finally {
    rmSync(env.dir, { recursive: true, force: true })
  }
})

/* ================================================================== */

const fail = failures.length
console.log(`\n================  ${pass} passed, ${fail} failed  ================`)
if (fail > 0) {
  console.log('\n失败详情：')
  for (const f of failures) {
    console.log(`- ${f.label}`)
    console.log(`  ${f.error && f.error.stack ? f.error.stack.split('\n').slice(0, 5).join('\n  ') : String(f.error)}`)
  }
  process.exitCode = 1
}
