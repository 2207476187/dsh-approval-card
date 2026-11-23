/**
 * gate-bridge.mjs —— PreToolUse hook：把「工作区外 / 危险动作」变成 ask
 *
 * 定位
 * ----
 * 这是 dsh-hooks-shim 的一条 hook 脚本，跑在 `tools/pre-execute` 阶段。
 * 它**不做最终判定**——批不批是 dsh-approval-gate 的事。它只负责一件事：
 * 让本该弹卡的调用，在老版本会弹、在新版本（内建 hooks 包被移除后）
 * 也能走到门面前。
 *
 * 契约
 * ----
 *   stdin  : {session_id, transcript_path, cwd, hook_event_name,
 *             tool_name, tool_input, tool_use_id}
 *   stdout : 无输出 = 无意见（放行）；或
 *            {"hookSpecificOutput":{"hookEventName":"PreToolUse",
 *             "permissionDecision":"ask"|"deny", "permissionDecisionReason":"..."}}
 *   exit 2 : 阻断（stderr 作 reason）
 *
 * 判据（任一命中即 ask）
 *   R1 命令/参数里出现工作区之外的绝对路径
 *   R2 命中破坏性动作词表
 *   R3 命中凭据/密钥相关路径
 *   R4 网络外发（curl/wget/Invoke-WebRequest 等）
 *   R0 纯只读命令放行：唯一理由是工作区外路径、且命令只由只读 cmdlet 组成时不问
 *      （读一条源码和写同一条源码在 R1 眼里没有区别，这条规则把「读」摘出来；
 *       凭据仍在 R3 兜底）
 *
 * 设计取舍：默认 **ask 而不是 deny**。
 * 理由：deny 是硬拒，模型无法通过正常途径继续；ask 才是「让门来决定」。
 * 只有明确命中最危险的组合（删除 + 系统路径）才直接 deny。
 *
 * 零依赖：只用 node 内置模块。
 */

import { readdirSync, statSync } from 'node:fs'
import { isAbsolute, join, resolve, sep, dirname } from 'node:path'

/* ============================ 配置 ============================ */

/** 破坏性动作词表。故意用宽泛匹配——误报的代价是弹一次卡，漏报的代价是数据没了。 */
const DESTRUCTIVE = [
  /\brm\s+-[rRf]*[rR][fF]?\s+\//, // rm -rf /
  /\brm\s+-[rRf]*[rR][fF]?\b/,
  /\bRemove-Item\b.*-Recurse/i,
  /\brmdir\s+\/(s|q)/i,
  /\brd\s+\/s/i,
  /\bdel\s+\/[sfq]/i,
  /\bformat\s+[a-z]:/i,
  /\bmkfs(\.\w+)?\b/i,
  /\bdd\s+if=.*of=\/dev\//i,
  /\b(shutdown|reboot|halt|poweroff)\b/i,
  /\bStop-Computer\b|\bRestart-Computer\b/i,
  /\bdiskpart\b/i,
  /\bvssadmin\s+delete/i,
  /\bbcdedit\b/i,
  /\breg\s+delete\b/i,
  /\bgit\s+push\s+.*--force\b/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bnpm\s+publish\b/i,
  /\bpip\s+install\s+--break-system/i,
]

/** 凭据 / 密钥：读到就是敏感，写更是。 */
const CREDENTIAL = [
  /\.ssh[\\/]/i,
  /\.aws[\\/]/i,
  /\.dsh[\\/]\.?credentials/i,
  /\bcredentials\.ya?ml\b/i,
  /\bid_rsa\b|\bid_ed25519\b|\bid_ecdsa\b/i,
  /\b\.env(\.\w+)?$/i,
  /\bsecurity_token\b/i,
  /\bAK_?SK\b/i,
  /\.npmrc\b/i,
  /\.pypirc\b/i,
  /\bnetrc\b/i,
  /\bcookies?\b.*\.(txt|json|sqlite)/i,
  /\blogin\s+data\b/i,
]

/** 网络外发：数据出去就回不来。 */
const EGRESS = [
  /\bcurl\b/i,
  /\bwget\b/i,
  /\bInvoke-WebRequest\b/i,
  /\bInvoke-RestMethod\b/i,
  /\biwr\b|\birm\b/i,
  /\bnc\s+-/i,
  /\bnetcat\b/i,
  /\bscp\b|\bsftp\b|\brsync\b/i,
  /\bssh\s+\S+@/i,
  /\bfetch\s*\(/i,
  /\baxios\b/i,
]

/**
 * 会执行命令的工具名（含带命名空间的变体）。
 * 只有它们的参数里「混着命令与路径」才是正常形态，
 * 全文扫描（R1 的路径解析、R4 的外发检查）也只对它们生效。
 */
const EXEC_TOOLS = /(pwsh|powershell|bash|sh|zsh|shell|exec|run|terminal|cmd)/i

/* ============================ R0 只读放行 ============================ */

/**
 * 只读命令白名单。
 *
 * ★ 为什么需要它：R1 只做字符串扫描，不区分读与写。读一条源码和写同一条
 *   源码在它眼里完全一样，于是查一行代码也要人点一次卡。这个白名单把
 *   「纯读」从 R1 里摘出来。
 *
 * ★ 为什么用白名单而不是黑名单：漏放的代价是多弹一次卡，误放的代价是
 *   一次静默写入。白名单写错只会打扰，黑名单写错会放行。
 */
const READ_CMDS = new Set([
  // 读文件
  'get-content', 'gc', 'cat', 'type', 'more', 'head', 'tail', 'wc',
  // 搜文本
  'select-string', 'sls', 'findstr', 'grep', 'rg', 'egrep', 'fgrep',
  // 列目录 / 取项
  'get-childitem', 'gci', 'ls', 'dir', 'get-item', 'gi', 'get-itemproperty', 'gp',
  // 校验 / 路径
  'get-filehash', 'test-path', 'resolve-path', 'split-path', 'join-path', 'convert-path',
  // 环境与元信息
  'get-command', 'get-help', 'get-member', 'get-date', 'get-location', 'pwd', 'get-process',
  // 管道里的纯计算
  'measure-object', 'select-object', 'sort-object', 'group-object',
  'format-table', 'format-list', 'format-wide',
  'out-string', 'convertto-json', 'convertfrom-json', 'compare-object', 'diff',
  'echo',
])

/**
 * 出现即判「不是纯读」的构造。
 *
 * 分段白名单挡不住括号里的嵌套命令（Get-Content (Set-Content ...) 的首 token
 * 仍是 Get-Content），所以用 WRITE_VERBS 全文兜一层。
 */
const WRITE_VERBS =
  /\b(Set|Add|Remove|New|Clear|Move|Copy|Rename|Out|Invoke|Start|Stop|Restart|Register|Unregister|Enable|Disable|Import|Export|Install|Uninstall|Update|Save|Write|Edit|Patch|Delete|Mount|Dismount|Restore|Backup|Compress|Expand|Tee|Join|Split|ConvertTo-SecureString)-[A-Za-z]+\b/i

const NOT_PURE_READ = [
  /[>]{1,2}\s*\S/, // > file / >> file
  /<{1,2}\s*\S/, // 输入重定向
  /\$\(/, // 子表达式 $( ... )
  /`/, // 反引号可拼命令名
  /&\s*\$/, // & $var 调用运算符
  /\bInvoke-Expression\b/i,
  /\biex\b/i,
  /\bStart-Process\b/i,
  /\bStart-Job\b/i,
  /\bForEach-Object\b/i,
  /\|\s*%\s/, // | % { ... }
]

/** 按 ; && || | 切段；先挖掉引号内容，避免引号里的分隔符把命令切错。 */
function splitSegments(text) {
  const stripped = String(text).replace(/"[^"]*"/g, '""').replace(/'[^']*'/g, "''")
  return stripped
    .split(/\|\||&&|;|\|/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

/** 取一段的首个 token（跳过 & 前缀与空白）。 */
function firstToken(segment) {
  const m = segment.replace(/^&\s*/, '').match(/^([A-Za-z][\w.-]*)/)
  return m ? m[1].toLowerCase() : ''
}

/**
 * 判断一条命令是否「纯只读」。
 * @param text 命令全文（flattenInput 的结果）
 * @returns true = 只读，可以放行
 */
function isPureReadCommand(text) {
  const raw = String(text ?? '')
  if (raw.length === 0) return false
  if (WRITE_VERBS.test(raw)) return false
  for (const re of NOT_PURE_READ) if (re.test(raw)) return false
  const segs = splitSegments(raw)
  if (segs.length === 0) return false
  for (const seg of segs) {
    const tok = firstToken(seg)
    if (!tok || !READ_CMDS.has(tok)) return false
  }
  return true
}


/**
 * 标记在「读后写得穿」的场景：这些工具的参数不是 shell 命令，
 * 但里面可能带路径。挨个看一遍。
 */
const PATH_KEYS = [
  'command',
  'cmd',
  'script',
  'file_path',
  'filePath',
  'path',
  'cwd',
  'workdir',
  'target',
  'destination',
  'output',
  'outFile',
  'pattern',
  'glob',
  'source',
  'src',
  'dst',
  'to',
  'from',
]

/**
 * 正文类字段：它们的值是要「写进去的内容」，不是「要动的目标」。
 *
 * ★ 为什么必须单列一张表：
 *   flattenInput() 早先把「除 PATH_KEYS / FREEFORM_KEYS 之外的全部短字符串」
 *   都拼进文本块，于是 write 的 content、edit 的 new_string 也进了扫描范围。
 *   正文里只要出现一段盘符字样或一个以斜杠开头的文件名，
 *   extractAbsolutePaths() 就把它当成「命令里混着的路径」，
 *   isInside() 判成工作区外，R1 随即报「目标含工作区外路径」——
 *   而那次写操作的真实目标就在工作区内，一个字都不越界。
 *
 *   典型误伤：写一份几 KB 的说明文档，正文里引用了别处的完整路径。
 *   文件越大越安全（L155 的 4000 字符阈值反而挡掉了长文档），
 *   于是表现为「同一件事有时弹、有时不弹」，最难自查。
 *
 *   真正的目标由 PATH_KEYS 命中字段表达；正文一律不参与路径判定。
 */
const BODY_KEYS = [
  'content',
  'new_string',
  'old_string',
  'new_str',
  'old_str',
  'file_text',
  'replacement',
  'patch',
  'diff',
  'body',
  'text',
]

/* ============================ 工具函数 ============================ */

/** 从任意嵌套结构里捞出所有字符串。深度受限，避免环形引用。 */
function collectStrings(value, out = [], depth = 0) {
  if (depth > 6) return out
  if (typeof value === 'string') {
    out.push(value)
    return out
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out, depth + 1)
    return out
  }
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value)) collectStrings(value[key], out, depth + 1)
  }
  return out
}

/** 把工具输入压成一个可搜索的文本块。 */
function flattenInput(toolInput) {
  const parts = []
  if (!toolInput || typeof toolInput !== 'object') return ''
  // ★ 路径字段（PATH_KEYS）故意不进这里。
  //   它们已经由 collectFieldPaths() 整段取走；再拼进自由文本，
  //   会被 extractAbsolutePaths() 按空白切碎，产出 `D:\DeepSeek` 这种假路径 ——
  //   既误报「工作区外」，也让 reason 里出现垃圾。
  //   这里只保留「一条命令里混着若干路径」的 command/cmd/script。
  const FREEFORM_KEYS = ['command', 'cmd', 'script', 'pattern', 'glob']
  for (const key of FREEFORM_KEYS) {
    if (typeof toolInput[key] === 'string') parts.push(toolInput[key])
  }
  // 其余字段：只取短字符串，且不碰正文类字段（BODY_KEYS）。
  // 正文是「要写进去的内容」，不是目标；扫它只会把文档里引用的路径当成越界目标。
  for (const key of Object.keys(toolInput)) {
    if (FREEFORM_KEYS.includes(key) || PATH_KEYS.includes(key) || BODY_KEYS.includes(key)) continue
    const v = toolInput[key]
    if (typeof v === 'string' && v.length <= 4000) parts.push(v)
    else if (Array.isArray(v)) {
      for (const item of v) if (typeof item === 'string' && item.length <= 4000) parts.push(item)
    }
  }
  return parts.join('\n')
}

/**
 * 从工具输入里直接取「整字段」路径。
 *
 * ★ 为什么必须单独做一遍：
 *   flattenInput() 是把各字段拼成一个文本块，拼完引号信息就没了。
 *   `{"file_path":"C:\\Users\\Administrator\\下载\\报告 v2.txt"}` 进到文本里
 *   变成裸的 `C:\Users\Administrator\下载\报告 v2.txt`，
 *   再按空白切 → `C:\Users\Administrator\下载\报告`（错的）。
 *
 *   所以：凡是在 PATH_KEYS 里命中的键，它的**字符串值整段**就是一个候选路径，
 *   不许再切。extractAbsolutePaths() 只用于 command 这类「一条命令里混着路径」的字段。
 */
function collectFieldPaths(toolInput) {
  const out = new Set()
  if (!toolInput || typeof toolInput !== 'object') return out

  const consider = (value) => {
    if (typeof value !== 'string') return
    const s = value.trim()
    if (s.length < 3) return
    if (!/^[A-Za-z]:[\\/]/.test(s) && !s.startsWith('/')) return
    if (s.startsWith('//')) return
    out.add(s.replace(/["'`)\],.;:]+$/, ''))
  }

  for (const key of PATH_KEYS) {
    const v = toolInput[key]
    if (typeof v === 'string') consider(v)
    else if (Array.isArray(v)) for (const item of v) consider(item)
  }
  return out
}

/**
 * 抽绝对路径。POSIX 与 Windows 两种写法都认。
 *
 * ★ 空格是这里最大的坑：`D:\DeepSeek Harness工作目录\WorkBuddy Ai\x.txt`
 *   若按 `[^\s]` 截断，只会得到 `D:\DeepSeek` —— 一个不存在的路径，
 *   随后 isInside() 把它判成「工作区外」→ 疯狂误报。
 *   （审批门的 paths.mjs 就栽在同一个地方）
 *
 *   这里只处理「一条文本里混着若干路径」的场景（主要是 command）。
 */
function extractAbsolutePaths(text) {
  const found = new Set()
  if (!text) return found

  const pushPath = (raw) => {
    if (!raw) return
    const cleaned = raw
      .replace(/^["'`(=,\[]+/, '')
      .replace(/["'`)\],.;:]+$/, '')
      .trim()
    if (cleaned.length < 3) return
    if (!/^[A-Za-z]:[\\/]/.test(cleaned) && !cleaned.startsWith('/')) return
    if (cleaned.startsWith('//')) return
    found.add(cleaned)
  }

  // ---- 第一轮：引号内的整段（允许空格）----
  // 先把所有引号片段抠出来，并把这些位置从原文本抹成空格，
  // 免得第二轮把引号里的内容再按空格切碎一次。
  let rest = ''
  let cursor = 0
  const quoted = /"([^"]{2,600})"|'([^']{2,600})'/g
  let qm
  while ((qm = quoted.exec(text)) !== null) {
    rest += text.slice(cursor, qm.index) + ' '
    cursor = qm.index + qm[0].length
    const inner = (qm[1] ?? qm[2] ?? '').trim()
    if (!inner) continue

    const looksAbsolute = /^[A-Za-z]:[\\/]/.test(inner) || inner.startsWith('/')
    const pieces = inner.split(/\s+/)

    if (looksAbsolute) {
      // ★ 整段本身就是一条绝对路径（含空格），**只登记整段，绝不切**。
      //   切了就会得到 `D:\DeepSeek` 这种前缀假路径 → 误报工作区外。
      pushPath(inner)
    } else {
      // 引号里不是以绝对路径开头：可能是「多个路径混排」或一句普通文本，
      // 这时逐 token 试，只认形如绝对路径的 token。
      for (const piece of pieces) pushPath(piece)
    }
  }
  rest += text.slice(cursor)

  // ---- 第二轮：裸文本按空白与分隔符切 ----
  for (const token of rest.split(/[\s|<>*?;]+/)) pushPath(token)

  return found
}

/** 判断某条路径是否落在 workspace 内（含边界防护：/ws 不匹配 /wsx）。 */
function isInside(candidate, workspace) {
  if (!workspace) return true // 不知道 workspace 就保守当「在内」，交给门判断
  let a
  let b
  try {
    a = resolve(candidate).toLowerCase()
    b = resolve(workspace).toLowerCase()
  } catch {
    return true
  }
  if (a === b) return true
  return a.startsWith(b.endsWith(sep) ? b : b + sep)
}

/**
 * 找 workspace 根
 * 顺序：env 显式指定 > cwd 往上找 .git/package.json > cwd 本身
 * 这样即使 cwd 是子目录，也能正确判定「是不是在项目里」。
 */
function findWorkspace(cwd) {
  for (const key of ['DSH_WORKSPACE', 'CLAUDE_PROJECT_DIR', 'WORKSPACE_ROOT']) {
    const v = process.env[key]
    if (typeof v === 'string' && v.length > 0) {
      try {
        if (statSync(v).isDirectory()) return v
      } catch {}
    }
  }
  if (!cwd) return undefined
  let cur = cwd
  for (let i = 0; i < 12; i++) {
    try {
      readdirSync(cur)
      if (
        (() => {
          try {
            statSync(join(cur, '.git'))
            return true
          } catch {
            return false
          }
        })() ||
        (() => {
          try {
            statSync(join(cur, 'package.json'))
            return true
          } catch {
            return false
          }
        })()
      ) {
        return cur
      }
    } catch {}
    const up = dirname(cur)
    if (up === cur) break
    cur = up
  }
  return cwd
}

/* ============================ 判定 ============================ */

function decide(payload) {
  const toolName = String(payload.tool_name ?? '')
  const toolInput = payload.tool_input ?? {}
  const cwd = String(payload.cwd ?? process.env.CLAUDE_PROJECT_DIR ?? process.cwd())
  const workspace = findWorkspace(cwd)

  // 工具名一律小写比较
  const tool = toolName.toLowerCase()

  // 这些工具是「只读的元工具」，没必要每次弹卡
  const READONLY_TOOLS = new Set([
    'read',
    'read_file',
    'readfile',
    'glob',
    'grep',
    'list',
    'ls',
    'list_dir',
    'listdir',
    'todo_write',
    'todowrite',
    'todoread',
    'web_search',
    'websearch',
    'web_fetch',
    'webfetch',
    'get_text',
  ])
  if (READONLY_TOOLS.has(tool)) return { decision: 'none' }

  // 整字段路径先取出来：含空格的字段值只有这一路能保真
  const fieldPaths = collectFieldPaths(toolInput)

  const text = flattenInput(toolInput)
  if (text.length === 0 && fieldPaths.size === 0) return { decision: 'none' }

  const reasons = []

  // ---- R1：工作区外绝对路径 ----
  // 按工具分流，两条来源的可信度不同：
  //   fieldPaths = PATH_KEYS 命中字段的整段值（含空格也不切，最可靠）→ 所有工具都算数
  //   textPaths  = 自由文本里解析出来的 → 只对「会执行命令」的工具算数
  //   正文（content / new_string / …）已被 BODY_KEYS 排除，永不参与路径判定
  const isExec = EXEC_TOOLS.test(tool) || EXEC_TOOLS.test(toolName)
  const paths = new Set(fieldPaths)
  if (isExec) {
    for (const p of extractAbsolutePaths(text)) paths.add(p)
  }
  const outside = []
  for (const p of paths) {
    if (!isInside(p, workspace)) outside.push(p)
  }
  if (outside.length > 0) {
    reasons.push(`目标含工作区外路径 ${outside.length} 处：${outside.slice(0, 3).join(' , ')}`)
  }

  // ---- R2：破坏性动作 ----
  for (const re of DESTRUCTIVE) {
    const m = text.match(re)
    if (m) {
      reasons.push(`破坏性动作：${m[0].slice(0, 80)}`)
      break
    }
  }

  // ---- R3：凭据 ----
  for (const re of CREDENTIAL) {
    const m = text.match(re)
    if (m) {
      reasons.push(`涉及凭据/密钥：${m[0].slice(0, 80)}`)
      break
    }
  }

  // ---- R4：网络外发 ----
  // 只对被判定为「会执行命令」的工具检查，否则读文件内容里出现 curl 会误报
  if (isExec) {
    for (const re of EGRESS) {
      const m = text.match(re)
      if (m) {
        reasons.push(`网络外发：${m[0].slice(0, 60)}`)
        break
      }
    }
  }

  // ---- R0：纯只读命令放行 ----
  // 唯一理由是「工作区外路径」、且命令每段首 token 都在 READ_CMDS 里时才跳过。
  // R2（破坏性）/ R3（凭据）/ R4（外发）只要有任何命中，上面就会多一条 reason，
  // 这里自然不成立，照旧弹卡。
  if (
    isExec &&
    outside.length > 0 &&
    reasons.length === 1 &&
    reasons[0].startsWith('目标含工作区外路径') &&
    isPureReadCommand(text)
  ) {
    return { decision: 'none', reason: '只读命令（R0 放行）' }
  }

  if (reasons.length === 0) return { decision: 'none' }

  // 最危险组合：破坏性 + 工作区外 → 直接 deny（不浪费人一次点击）
  const hasDestructive = reasons.some((r) => r.startsWith('破坏性动作'))
  if (hasDestructive && outside.length > 0) {
    const rooted = outside.some((p) => {
      const norm = p.replace(/\//g, '\\').toLowerCase()
      return (
        /^[a-z]:\\?(windows|program files|program files \(x86\))/.test(norm) ||
        norm === 'c:\\' ||
        norm === 'd:\\' ||
        /^[a-z]:\\?$/.test(norm)
      )
    })
    if (rooted) {
      return {
        decision: 'deny',
        reason: `命中硬拒：破坏性操作指向系统/根路径。${reasons.join('；')}`,
      }
    }
  }

  return { decision: 'ask', reason: reasons.join('；') }
}

/* ============================ 主流程 ============================ */

let raw = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  raw += chunk
})
process.stdin.on('error', () => {
  // stdin 都读不了 → 无意见，别阻断会话
  process.exit(0)
})
process.stdin.on('end', () => {
  let payload = {}
  try {
    payload = JSON.parse(raw || '{}')
  } catch {
    // payload 坏了也不是我们的错，放行
    process.exit(0)
  }

  let result
  try {
    result = decide(payload)
  } catch (error) {
    // 判定器自己崩了：**不能**因此阻断用户，报无意见
    process.stderr.write(`[gate-bridge] internal error: ${String(error && error.stack ? error.stack : error)}\n`)
    process.exit(0)
  }

  if (result.decision === 'none') {
    // 不输出 = 无意见
    process.exit(0)
  }

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: result.decision,
        permissionDecisionReason: result.reason,
      },
    }),
  )
  process.exit(0)
})

// 兜底：10 秒还没收到 stdin EOF 就放行（不能把会话挂死）
setTimeout(() => {
  process.exit(0)
}, 10_000).unref()
