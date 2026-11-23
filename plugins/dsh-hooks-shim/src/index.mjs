/**
 * dsh-hooks-shim — standalone hooks bridge for DeepSeek Harness
 * =============================================================
 *
 * 为什么需要它
 * ------------
 * DSH 0.2.1-rc.2 把三个包从内建包里移出去了：
 *
 *   @deepseek-ai/dsh-hook-protocol
 *   @deepseek-ai/dsh-hooks-claude-code
 *   @deepseek-ai/dsh-hooks-codex
 *
 * 其中 dsh-hooks-claude-code 是宿主里**唯一**会把 `tools/pre-execute`
 * 瀑布的返回值映射成 `{kind:'deny'}` / `{kind:'ask'}` 的官方插件：
 *
 *     // 官方 dsh-hooks-claude-code\lib\index.js（还原后的原样）
 *     ctx.on("tools/pre-execute", async (exec, next) => {
 *       ...
 *       if (merged.decision === "deny") return { kind: "deny", reason: ... };
 *       if (merged.decision === "ask")  return { kind: "ask",  reason: ... };
 *       return next();
 *     });
 *
 * 只有拿到 `{kind:'ask'}`，dsh-tools 的 prepareExecution 才会走
 * `serviceAsk()` → `ctx.get('approval').request(...)` → 弹审批卡。
 * 这个包没了 ⇒ hooks 通道整条消失 ⇒ 审批门再也没机会介入。
 *
 * 本文件把那条链在**没有 @deepseek-ai 依赖**的前提下重写了一遍，
 * 用同一个 hooks.json 配置格式、同一个 stdin payload、同一个决策合并规则
 * （deny > ask > allow，block 折成 deny）。
 *
 * 扩展点契约（与官方逐字对齐，来自 0.2.0-rc.2 官方实现）
 * ------------------------------------------------------
 *   agent/created        async ({agent, source, signal}) => void
 *   agent/pre-step       async ({agent, messages, turn, signal}, next) => {kind:'reject'} | next()
 *   tools/pre-execute    async (exec, next) => {kind:'deny'|'ask', reason?} | next()
 *   tools/post-execute   async (exec, result, next) => {kind:'block', feedback, additionalContexts?} | next()
 *   agent/turn-stopping  async ({agent, turn, signal}) => void
 *   subagent/start       (info) => void
 *   subagent/end         (info) => void
 *
 * 刻意**没做**的部分（与官方一致）：
 *   - updatedInput：官方也只 warn + 忽略
 *   - systemMessage：同上
 *   - auto-review / judge：那是审批门自己的事，不在这里
 *
 * 设计约束
 * --------
 *   - 零外部依赖：宿主升级后 @deepseek-ai/* 全换掉也不会断
 *   - 同步可预测：不会因为 hook 脚本卡死而锁死会话（有超时 + 可关闭）
 *   - 失败开放到「不阻断」但不开放到「假放行」：脚本跑挂 = 视为无意见，
 *     而不是视为 allow；真正的 deny 只能来自脚本明确输出
 */

import { readFileSync, existsSync, statSync } from 'node:fs'
import { isAbsolute, resolve, join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { performance } from 'node:perf_hooks'

const NAME = 'dsh-hooks-shim'

/** 支持的 hook 事件（Claude Code 方言）。顺序影响 SessionStart 的 source 判定，保持官方原序。 */
const CLAUDE_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'Stop',
  'SubagentStart',
  'SubagentStop',
]

/** 没有 matcher 主体的事件：官方在这些事件上丢弃 matcher 字段。 */
const MATCHERLESS = new Set(['UserPromptSubmit', 'Stop'])

/** 官方默认单 hook 超时：600 秒（10 分钟）。这里默认压到 60 秒，见 Config.defaultTimeoutMs。 */
const DEFAULT_TIMEOUT_MS = 60_000

/** 进程退出码 2 = 阻断（Claude Code 语义）。 */
const BLOCKING_EXIT_CODE = 2

/** 决策严格度排序：deny > ask > allow，其余为无意见。 */
const RANK = { deny: 3, block: 3, ask: 2, approve: 1, allow: 1 }
const RANK_TO_DECISION = ['none', 'allow', 'ask', 'deny']

/** ============================ 配置 ============================ */

/**
 * Config（宿主用 schemastery 校验时会忽略未知字段；这里手写等价校验）
 *
 * hooksFile      相对 hooks 目录的配置文件名，默认 hooks.json
 * hooksDir       配置所在目录；默认 <profile>\plugins\dsh-hooks-shim
 * projectDir     传给 hook 的 CLAUDE_PROJECT_DIR，默认会话 cwd
 * defaultTimeoutMs 单 hook 超时，默认 60000
 * enabled        总开关，默认 true
 * failMode       'open'（脚本失败=无意见，默认）| 'closed'（脚本失败=deny）
 * logInvocations 是否把每次调用打到宿主 console，默认 false
 */
const DEFAULTS = {
  hooksFile: 'hooks.json',
  hooksDir: '',
  projectDir: '',
  defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
  enabled: true,
  failMode: 'open',
  logInvocations: false,
}

function normalizeConfig(raw) {
  const cfg = { ...DEFAULTS, ...(raw ?? {}) }
  cfg.hooksFile = String(cfg.hooksFile || DEFAULTS.hooksFile)
  cfg.hooksDir = String(cfg.hooksDir || '')
  cfg.projectDir = String(cfg.projectDir || '')
  cfg.defaultTimeoutMs =
    Number.isInteger(cfg.defaultTimeoutMs) && cfg.defaultTimeoutMs > 0
      ? cfg.defaultTimeoutMs
      : DEFAULT_TIMEOUT_MS
  cfg.enabled = cfg.enabled !== false
  cfg.failMode = cfg.failMode === 'closed' ? 'closed' : 'open'
  cfg.logInvocations = cfg.logInvocations === true
  return cfg
}

/** ============================ 配置解析 ============================ */

function asObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : undefined
}

function substituteCommand(command, vars) {
  let out = command
  if (vars.pluginRoot !== undefined) out = out.split('${CLAUDE_PLUGIN_ROOT}').join(vars.pluginRoot)
  if (vars.projectDir !== undefined) out = out.split('${CLAUDE_PROJECT_DIR}').join(vars.projectDir)
  return out
}

/** Claude 方言的 matcher：全字符为词字符 + `|` 时是字面量候选列表，否则当正则。 */
function matchesClaudeMatcher(matcher, query) {
  if (matcher === undefined || matcher === '' || matcher === '*') return true
  const subject = String(query ?? '')
  if (/^[A-Za-z0-9_|]+$/.test(matcher)) {
    return matcher.split('|').some((alt) => alt === subject)
  }
  try {
    return new RegExp(matcher).test(subject)
  } catch {
    return false // 非法正则 = 不匹配（官方同样把非法正则容错成 non-match）
  }
}

/**
 * 解析 hooks.json。结构与 Claude Code 完全一致：
 *   { "hooks": { "PreToolUse": [ { "matcher": "pwsh", "hooks": [ {"type":"command","command":"...","timeout":30} ] } ] } }
 * 也接受不带外层 hooks 键的裸事件表。
 */
function parseHookConfig(raw, vars) {
  const config = {}
  const skipped = []
  const root = asObject(raw)
  const hooksMap = root ? (asObject(root.hooks) ?? root) : undefined
  if (!hooksMap) return { config, skipped }

  for (const event of CLAUDE_EVENTS) {
    const rawGroups = hooksMap[event]
    if (!Array.isArray(rawGroups)) continue
    const groups = []
    for (const rawGroup of rawGroups) {
      const group = asObject(rawGroup)
      if (!group || !Array.isArray(group.hooks)) continue
      const commands = []
      for (const rawHook of group.hooks) {
        const hook = asObject(rawHook)
        if (!hook) continue
        const type = typeof hook.type === 'string' ? hook.type : 'command'
        if (type !== 'command') {
          skipped.push({ event, type })
          continue
        }
        if (typeof hook.command !== 'string') continue
        commands.push({
          command: substituteCommand(hook.command, vars),
          ...(typeof hook.timeout === 'number' ? { timeoutSec: hook.timeout } : {}),
        })
      }
      if (commands.length === 0) continue
      const matcher =
        MATCHERLESS.has(event) || typeof group.matcher !== 'string' ? undefined : group.matcher
      // 校验正则合法性，但 match-all 哨兵（"" / "*"）永远合法 —— 官方 matcherDiagnostic 同样放行它们。
      // 注意：'*' 本身不是合法正则（nothing to repeat），必须先判哨兵再编译。
      if (
        matcher !== undefined &&
        matcher !== '' &&
        matcher !== '*' &&
        !/^[A-Za-z0-9_|]+$/.test(matcher)
      ) {
        try {
          new RegExp(matcher)
        } catch {
          throw new SyntaxError(`invalid matcher ${JSON.stringify(matcher)} on event ${JSON.stringify(event)}`)
        }
      }
      groups.push({ ...(matcher !== undefined ? { matcher } : {}), hooks: commands })
    }
    if (groups.length > 0) config[event] = groups
  }
  return { config, skipped }
}

/** ============================ 输出解码 ============================ */

function strField(obj, key) {
  const v = obj[key]
  return typeof v === 'string' ? v : undefined
}

function boolField(obj, key) {
  const v = obj[key]
  return typeof v === 'boolean' ? v : undefined
}

function topLevelDecision(value) {
  return value === 'approve' || value === 'block' ? value : undefined
}

function permissionDecision(value) {
  return value === 'allow' || value === 'deny' || value === 'ask' ? value : undefined
}

/**
 * 把一次 hook 的进程结果解码成中性输出。
 *   exit 2            → block（stderr 即 reason）
 *   exit 0 + JSON     → 结构化字段（decision / hookSpecificOutput.permissionDecision / additionalContext）
 *   其他              → 纯 stdout，无决策
 */
function decodeHookOutput(exitCode, stdout, stderr, expectedEvent) {
  const trimmedOut = String(stdout ?? '').trim()
  const trimmedErr = String(stderr ?? '').trim()
  const output = { exitCode, stdout: trimmedOut, stderr: trimmedErr }

  if (exitCode === BLOCKING_EXIT_CODE) {
    output.decision = 'block'
    if (trimmedErr.length > 0) output.reason = trimmedErr
  }

  if (exitCode === 0 && trimmedOut.startsWith('{')) {
    let parsed
    try {
      parsed = asObject(JSON.parse(trimmedOut))
    } catch {
      parsed = undefined
    }
    if (parsed) {
      const cont = boolField(parsed, 'continue')
      if (cont !== undefined) output.continue = cont
      const stopReason = strField(parsed, 'stopReason')
      if (stopReason !== undefined) output.stopReason = stopReason
      const sysMsg = strField(parsed, 'systemMessage')
      if (sysMsg !== undefined) output.systemMessage = sysMsg
      const top = topLevelDecision(strField(parsed, 'decision'))
      if (top !== undefined) output.decision = top
      const topReason = strField(parsed, 'reason')
      if (topReason !== undefined) output.reason = topReason

      const hso = asObject(parsed.hookSpecificOutput)
      if (hso) {
        const eventName = strField(hso, 'hookEventName')
        if (eventName !== undefined) output.hookEventName = eventName
        // 事件的字段只对声明了同一事件名的块生效
        if (expectedEvent !== undefined && eventName !== expectedEvent) return output
        const perm = permissionDecision(strField(hso, 'permissionDecision'))
        if (perm !== undefined) output.decision = perm
        const permReason = strField(hso, 'permissionDecisionReason')
        if (permReason !== undefined) output.reason = permReason
        const addCtx = strField(hso, 'additionalContext')
        if (addCtx !== undefined) output.additionalContext = addCtx
        const updated = asObject(hso, 'updatedInput')
        if (updated !== undefined) output.updatedInput = updated
      }
    }
  }
  return output
}

/** 合并多条输出：取最严决策，同档 reason 用空行拼起来；context 累加。 */
function mergeOutputs(outputs) {
  let maxRank = 0
  const reasonsByRank = new Map()
  const additionalContext = []
  const systemMessages = []
  let stop = false
  let stopReason

  for (const out of outputs) {
    const r = RANK[out.decision] ?? 0
    if (r > maxRank) maxRank = r
    if ((r === 3 || r === 2) && typeof out.reason === 'string' && out.reason.length > 0) {
      const list = reasonsByRank.get(r) ?? []
      list.push(out.reason)
      reasonsByRank.set(r, list)
    }
    if (out.continue === false && !stop) {
      stop = true
      if (out.stopReason !== undefined) stopReason = out.stopReason
    }
    if (Array.isArray(out.additionalContext) && out.additionalContext.length > 0) {
      additionalContext.push(...out.additionalContext)
    } else if (typeof out.additionalContext === 'string' && out.additionalContext.length > 0) {
      additionalContext.push(out.additionalContext)
    }
    if (typeof out.systemMessage === 'string' && out.systemMessage.length > 0) {
      systemMessages.push(out.systemMessage)
    }
  }

  const reasons = reasonsByRank.get(maxRank) ?? []
  return {
    decision: RANK_TO_DECISION[maxRank] ?? 'none',
    ...(reasons.length > 0 ? { reason: reasons.join('\n\n') } : {}),
    stop,
    ...(stopReason !== undefined ? { stopReason } : {}),
    additionalContext,
    systemMessages,
  }
}

/** ============================ 执行器 ============================ */

/**
 * 跑一条 hook 命令。
 *
 * 用 ctx.shell（宿主自带，带凭据擦除 / 进程组取消 / 超时）优先；
 * 拿不到 shell 服务时退回 node:child_process.spawn —— 这保证本插件在
 * 极端裁剪的宿主里也能工作。两条路都**不抛异常**，失败一律折成
 * 「无 exitCode 的空输出」。
 */
async function runOneHook(shell, hook, options) {
  const timeoutMs =
    typeof hook.timeoutSec === 'number' ? Math.round(hook.timeoutSec * 1000) : options.defaultTimeoutMs
  const stdin = `${JSON.stringify(options.payload)}\n`

  if (shell && typeof shell.execute === 'function' && typeof shell.resolve === 'function') {
    try {
      const request = {
        command: hook.command,
        timeoutMs,
        stdin,
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
        ...(options.cwd !== undefined ? { workdir: options.cwd } : {}),
        ...(options.env !== undefined ? { env: options.env } : {}),
      }
      const handle = await shell.execute(shell.resolve(request))
      const result = await handle.result()
      return {
        output: decodeHookOutput(
          result.exitCode ?? undefined,
          result.stdout?.text ?? '',
          result.stderr?.text ?? '',
          options.expectedEvent,
        ),
      }
    } catch (error) {
      return {
        output: decodeHookOutput(undefined, '', error instanceof Error ? error.message : String(error), options.expectedEvent),
      }
    }
  }

  // ---- 回退路径：纯 node ----
  return await new Promise((resolvePromise) => {
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      resolvePromise(value)
    }
    let child
    try {
      child = spawn(hook.command, {
        shell: true,
        cwd: options.cwd,
        env: { ...process.env, ...(options.env ?? {}) },
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    } catch (error) {
      finish({
        output: decodeHookOutput(undefined, '', error instanceof Error ? error.message : String(error), options.expectedEvent),
      })
      return
    }
    let out = ''
    let err = ''
    child.stdout?.on('data', (d) => {
      if (out.length < 1_000_000) out += String(d)
    })
    child.stderr?.on('data', (d) => {
      if (err.length < 1_000_000) err += String(d)
    })
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {}
      finish({ output: decodeHookOutput(undefined, out, `${err}\n[dsh-hooks-shim] timeout after ${timeoutMs}ms`, options.expectedEvent) })
    }, timeoutMs)
    if (options.signal && typeof options.signal.addEventListener === 'function') {
      options.signal.addEventListener(
        'abort',
        () => {
          try {
            child.kill()
          } catch {}
          clearTimeout(timer)
          finish({ output: decodeHookOutput(undefined, out, `${err}\n[dsh-hooks-shim] aborted`, options.expectedEvent) })
        },
        { once: true },
      )
    }
    child.on('error', (error) => {
      clearTimeout(timer)
      finish({ output: decodeHookOutput(undefined, out, `${err}\n${String(error)}`, options.expectedEvent) })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      finish({ output: decodeHookOutput(code ?? undefined, out, err, options.expectedEvent) })
    })
    try {
      child.stdin?.end(stdin)
    } catch {}
  })
}

/** ============================ payload 构造 ============================ */

function basePayload(agent, event) {
  return {
    session_id: agent?.session?.header?.id ?? '',
    transcript_path: '',
    cwd: agent?.session?.header?.cwd ?? process.cwd(),
    hook_event_name: event,
  }
}

function blocksToText(blocks) {
  if (!Array.isArray(blocks)) return typeof blocks === 'string' ? blocks : ''
  return blocks
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n')
}

/** ============================ 插件主体 ============================ */

export const name = NAME
export const inject = ['shell']

export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig)

  if (!config.enabled) {
    ctx.logger?.info?.(`${NAME}: disabled by config, no hooks registered`)
    return
  }

  // ---- 定位 hooks.json ----
  // entryDir = src\            （import.meta.url 所在目录）
  // pluginRoot = 插件根目录     （src\..，即 ...\plugins\dsh-hooks-shim）
  // hooks.json 约定放在插件根目录，所以默认 hooksDir = pluginRoot。
  const entryDir = dirname(fileURLToPath(import.meta.url))
  const pluginRoot = resolve(entryDir, '..')
  const hooksDir = config.hooksDir
    ? isAbsolute(config.hooksDir)
      ? config.hooksDir
      : resolve(pluginRoot, config.hooksDir)
    : pluginRoot
  const hooksPath = isAbsolute(config.hooksFile) ? config.hooksFile : join(hooksDir, config.hooksFile)

  let parsed = { config: {}, skipped: [] }
  if (existsSync(hooksPath)) {
    try {
      const text = readFileSync(hooksPath, 'utf8')
      const vars = { pluginRoot }
      if (config.projectDir) vars.projectDir = config.projectDir
      parsed = parseHookConfig(JSON.parse(text), vars)
      for (const s of parsed.skipped) {
        ctx.logger?.warn?.(`${NAME}: skipping unsupported "${s.type}" hook on ${s.event} (only command hooks run)`)
      }
      const total = Object.values(parsed.config).reduce((n, g) => n + g.length, 0)
      ctx.logger?.info?.(`${NAME}: loaded ${total} hook group(s) from ${hooksPath}`)
    } catch (error) {
      // 配置坏了 = 什么都不注册（与官方一致：静默降级，绝不因为配置问题阻断会话）
      ctx.logger?.warn?.(`${NAME}: could not load hook config "${hooksPath}": ${String(error)} — no hooks registered`)
      return
    }
  } else {
    ctx.logger?.info?.(`${NAME}: no hook config at ${hooksPath} — no hooks registered`)
    return
  }

  const shell = ctx.get ? ctx.get('shell') : ctx.shell

  // ---- 统一的 runPoint ----
  async function runPoint(point, matchQuery, payload, opts) {
    const groups = parsed.config[point] ?? []
    const outputs = []
    const workdir = opts.agent?.session?.header?.cwd
    const projectDir = config.projectDir || workdir
    const hookEnv =
      projectDir !== undefined && projectDir !== ''
        ? { CLAUDE_PROJECT_DIR: projectDir, CLAUDE_HOOK_EVENT: point }
        : { CLAUDE_HOOK_EVENT: point }

    for (const group of groups) {
      if (!matchesClaudeMatcher(group.matcher, matchQuery)) continue
      for (const hook of group.hooks) {
        const started = performance.now()
        const { output } = await runOneHook(shell, hook, {
          payload,
          defaultTimeoutMs: config.defaultTimeoutMs,
          env: hookEnv,
          ...(workdir !== undefined ? { cwd: workdir } : {}),
          ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
          expectedEvent: point,
        })
        const durationMs = Math.round(performance.now() - started)
        if (config.logInvocations) {
          ctx.logger?.info?.(
            `${NAME}: ${point} -> ${output.decision ?? 'none'} (${durationMs}ms) ${String(hook.command).slice(0, 80)}`,
          )
        }
        if (output.updatedInput !== undefined) {
          ctx.logger?.warn?.(`${NAME}: ${point} hook requested updatedInput, which is not honored (ignored)`)
        }
        if (output.systemMessage !== undefined) {
          ctx.logger?.warn?.(`${NAME}: ${point} hook emitted a systemMessage, which is not surfaced (ignored)`)
        }
        outputs.push(output)
      }
    }
    return mergeOutputs(outputs)
  }

  /** 把 hook 的 additionalContext 变成宿主能吃的 user 消息。 */
  function contextFrom(merged) {
    if (!Array.isArray(merged.additionalContext) || merged.additionalContext.length === 0) return undefined
    return {
      role: 'user',
      content: merged.additionalContext.map((text) => ({ type: 'text', text })),
      source: { kind: NAME },
    }
  }

  // ================= 扩展点挂载（与官方逐字对齐返回值） =================

  ctx.on('agent/created', async ({ agent, source, signal }) => {
    const merged = await runPoint('SessionStart', source, { ...basePayload(agent, 'SessionStart'), source }, {
      agent,
      signal,
    })
    const context = contextFrom(merged)
    if (context && typeof agent?.inject === 'function') {
      try {
        agent.inject(context)
      } catch (error) {
        ctx.logger?.warn?.(`${NAME}: SessionStart context inject failed: ${String(error)}`)
      }
    }
  })

  ctx.on('agent/pre-step', async ({ agent, messages, turn, signal }, next) => {
    if (Array.isArray(messages) && messages.length === 0) return next()
    const merged = await runPoint(
      'UserPromptSubmit',
      '',
      { ...basePayload(agent, 'UserPromptSubmit'), prompt: blocksToText(messages?.flatMap((m) => m.content ?? []) ?? []) },
      { agent, turn, signal },
    )
    if (merged.decision === 'deny') return { kind: 'reject' }
    const downstream = await next()
    const ours = contextFrom(merged)
    if (!ours || downstream?.kind !== 'enter') return downstream
    return { ...downstream, messages: [...(downstream.messages ?? []), ours] }
  })

  // ★ 这一条就是审批门的命脉：deny → 拒绝，ask → 弹卡
  ctx.on('tools/pre-execute', async (exec, next) => {
    const merged = await runPoint(
      'PreToolUse',
      exec.name,
      {
        ...basePayload(exec.agent, 'PreToolUse'),
        tool_name: exec.name,
        tool_input: exec.arguments,
        tool_use_id: exec.callId,
      },
      { ...(exec.agent ? { agent: exec.agent } : {}), signal: exec.signal },
    )
    if (merged.decision === 'deny') {
      return { kind: 'deny', reason: merged.reason ?? 'blocked by PreToolUse hook' }
    }
    if (merged.decision === 'ask') {
      return { kind: 'ask', ...(merged.reason !== undefined ? { reason: merged.reason } : {}) }
    }
    return next()
  })

  ctx.on('tools/post-execute', async (exec, result, next) => {
    const merged = await runPoint(
      'PostToolUse',
      exec.name,
      {
        ...basePayload(exec.agent, 'PostToolUse'),
        tool_name: exec.name,
        tool_input: exec.arguments,
        tool_use_id: exec.callId,
        tool_response: blocksToText(result?.content),
      },
      { ...(exec.agent ? { agent: exec.agent } : {}), signal: exec.signal },
    )
    const context = contextFrom(merged)
    if (merged.decision === 'deny' || merged.decision === 'block') {
      return {
        kind: 'block',
        feedback: [{ type: 'text', text: merged.reason ?? 'blocked by PostToolUse hook' }],
        ...(context ? { additionalContexts: [context] } : {}),
      }
    }
    const downstream = await next()
    if (!context) return downstream
    return {
      ...downstream,
      additionalContexts: [context, ...(downstream?.additionalContexts ?? [])],
    }
  })

  ctx.on('agent/turn-stopping', async ({ agent, turn, signal }) => {
    const merged = await runPoint('Stop', '', { ...basePayload(agent, 'Stop'), stop_hook_active: false }, {
      agent,
      turn,
      signal,
    })
    if (merged.decision === 'deny') {
      const text = merged.reason ?? 'continue: blocked by Stop hook'
      try {
        agent?.steer?.({
          role: 'user',
          content: [{ type: 'text', text }],
          source: { kind: NAME },
        })
      } catch (error) {
        ctx.logger?.warn?.(`${NAME}: Stop steer failed: ${String(error)}`)
      }
    }
  })

  // subagent 点：官方在子 agent 可用时会传 child；拿不到就传 undefined
  const subagentPayload = (event, info) => ({
    ...basePayload(info?.agent, event),
    agent_type: info?.type ?? 'general-purpose',
    agent_id: info?.id ?? '',
    ...(event === 'SubagentStop' ? { stop_hook_active: false } : {}),
  })

  ctx.on('subagent/start', (info) => {
    const child = ctx.get?.('agents')?.get?.(info?.id)
    void runPoint('SubagentStart', info?.type ?? '', subagentPayload('SubagentStart', info), {
      ...(child ? { agent: child } : {}),
    }).catch((error) => {
      ctx.logger?.warn?.(`${NAME}: SubagentStart hook failed: ${String(error)}`)
    })
  })

  ctx.on('subagent/end', (info) => {
    const child = ctx.get?.('agents')?.get?.(info?.id)
    void runPoint('SubagentStop', info?.type ?? '', subagentPayload('SubagentStop', info), {
      ...(child ? { agent: child } : {}),
    }).catch((error) => {
      ctx.logger?.warn?.(`${NAME}: SubagentStop hook failed: ${String(error)}`)
    })
  })

  ctx.logger?.info?.(`${NAME}: armed on 7 extension points (agent/created, agent/pre-step, tools/pre-execute, tools/post-execute, agent/turn-stopping, subagent/start, subagent/end)`)
}

export default { name, inject, apply }
