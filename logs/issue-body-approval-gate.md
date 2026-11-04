## 环境

- `dsh-approval-gate` 0.9.14（`git+https://github.com/IamNewHands/dsh-approval-gate.git`）
- Windows 11，Node v24.19.0
- 预设 `auto-approve`（`sandbox: workspace-write`, `approval: ask`），`outsideNeedsHuman` 为默认 `true`

## 症状

工作区根目录的绝对路径里**含空格**时，对工作区内文件的 `write` / `edit` 会被判定成「工作区外」，转人工审批。

`~/.dsh/auto-approve/events.jsonl` 里同一条事件自相矛盾：

```json
{
  "tool": "edit",
  "verdict": "manual-pending",
  "files": ["D:\\My Work\\repo\\docs\\devlog\\2026-11.md"],
  "targets": ["D:\\My"],
  "facts": { "targetScope": "outside" }
}
```

`files` 是完整路径，`targets` 却只剩第一个空格前的一段 —— 定域依据的是 `targets`，于是判 `outside`。

只有部分工具会中招：`pwsh` / `bash` 命令里的路径通常带引号，`extractAbsolutePaths()` 的引号分支能拿到整段；`write` / `edit` 的 `arguments.file_path` 是**不带引号的一条路径**，必然被空格切断。

## 最小复现

不依赖 DSH，只 import 本包的两个函数（脚本见文末）：

```
node repro-gate-path-truncation.mjs <path-to-dsh-approval-gate>
```

```
workspace            : D:\My Work
arguments.file_path  : D:\My Work\a.txt

extractAbsolutePaths(file_path) : [{"raw":"D:\\My","path":"d:\\my","kind":"data"}]
  -> scope                      : outside

same path, quoted inside a command:
  extract                       : ["D:\\My Work\\a.txt"]
  -> scope                      : inside

full path, classified directly:
  -> scope                      : inside

BUG REPRODUCED
```

## 期望 / 实际

| | |
|---|---|
| 期望 | `targets: ["D:\\My Work\\a.txt"]`，`targetScope: "inside"`，正常放行 |
| 实际 | `targets: ["D:\\My"]`，`targetScope: "outside"`，转人工审批 |

## 根因

`src/index.mjs:480-505` `resolveToolCallTargets()` 把**结构化字段**也送进了面向命令文本的词法提取器：

```js
const add = (text) => {
  if (found.length >= 24) return
  for (const p of extractAbsolutePaths(text)) {   // ← 结构化路径不需要、也不该做词法切分
    if (seen.has(p.path)) continue
    seen.add(p.path)
    found.push(p)
  }
}
for (const k of ['file_path', 'filePath', 'path', 'filename', 'file', 'target', 'source', 'dest', 'destination']) {
  const v = args[k]
  if (Array.isArray(v)) v.forEach((one) => { if (typeof one === 'string') add(one) })
  else if (typeof v === 'string') add(v)
```

而 `src/paths.mjs:259` 的 `extractAbsolutePaths()` 面向的是命令行文本：

- `src/paths.mjs:209` `ABS_PATH_TOKEN_RE` 的字符类里排除了 `\s`，遇空格即停；
- `src/paths.mjs:215` `QUOTED_SPAN_RE` 只有在**输入文本自带引号**时才能界定含空格的边界。

`file_path` 本身已经是完整字符串、不需要词法推断，走这条路等于把它当成一行命令重新切了一遍。

## 建议改法

结构化字段直接当一条绝对路径收下，只对命令类字段保留文本提取：

```js
const addStructured = (value) => {
  if (found.length >= 24 || typeof value !== 'string') return
  const raw = value.trim()
  if (!raw) return
  // 只接受绝对路径形态，相对片段仍旧不收（保持原有的 fail-closed 语义）
  if (!ABS_PATH_HEAD_RE.test(raw)) return
  const path = normalizePath(raw, cwd, home)
  if (!path || seen.has(path)) return
  seen.add(path)
  found.push({ raw, path, kind: kindOf(path) })   // device / program / data
}
```

注意 `kind` 必须按 `paths.mjs` 现有的口径分档（`DEVICE_PATH_RE` / `PROGRAM_PATH_RE` / 其余 `data`）：如果一律标 `data`，`X:\Program Files\…`、`C:\Windows\System32\…` 会从「程序位置」降级成「数据目标」，反过来制造出一批假阳性越界。

## 同类问题的第二个表现（可选一起修）

非路径文本也在走同一个提取器，于是说明文字里的 `/plugins/<name>/…` 会被 `POSIX 根` 分支当成绝对路径收进 `targets`，审批卡的「原因」里出现过：

```
目标含工作区外路径 1 处：/plugins/
```

即：**只对「确实是路径的输入」调用路径提取器**，其余文本要么不提取，要么提取后按「是否以分隔符开头且后续像文件名」过滤。

## 影响

- 工作区路径含空格（Windows 上极常见）的用户，每一次 `write` / `edit` 都要点一次审批；
- 审计日志里记的是截断后的 `targets`，事后无法回答「这次到底动了哪个文件」。

## 附：复现脚本

```js
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

function packageDir() {
  const fromArgv = process.argv[2]
  if (fromArgv) return fromArgv
  const require = createRequire(import.meta.url)
  try {
    return dirname(require.resolve('dsh-approval-gate/package.json'))
  } catch {
    return null
  }
}

const pkgDir = packageDir()
if (!pkgDir) {
  console.error('usage: node repro-gate-path-truncation.mjs <path-to-dsh-approval-gate>')
  process.exit(2)
}

const { extractAbsolutePaths, classifyPathScope, resolveRoots } = await import(
  pathToFileURL(join(pkgDir, 'src', 'paths.mjs')).href
)

const workspace = 'D:\\My Work'
const filePath = 'D:\\My Work\\a.txt'
const roots = resolveRoots(workspace)

const structured = extractAbsolutePaths(filePath)
const quoted = extractAbsolutePaths(`Set-Content '${filePath}' -Value x`)

console.log('extractAbsolutePaths(file_path) :', JSON.stringify(structured))
console.log('  -> scope                      :', classifyPathScope(structured, roots).scope)
console.log('quoted in command               :', JSON.stringify(quoted.map((p) => p.raw)))
console.log('  -> scope                      :', classifyPathScope(quoted, roots).scope)
console.log('full path                       :', classifyPathScope([filePath], roots).scope)

const reproduced =
  structured.length === 1 &&
  structured[0].raw === 'D:\\My' &&
  classifyPathScope(structured, roots).scope === 'outside' &&
  classifyPathScope([filePath], roots).scope === 'inside'

process.exit(reproduced ? 0 : 1)
```
