# dsh-hooks-shim

**一句话**：DSH 更新到 `0.2.1-rc.2` 之后，官方把 hooks 桥接包从内建里拿掉了；
这个插件把那条链用**零依赖**重写了一遍，保证审批门不会因此失效。

- 自测：**21 / 21 通过**
- 依赖：**0 个**（只用 node 内置模块）
- 体积：`src/index.mjs` 一个文件，680 行
- 生效条件：`<插件目录>\hooks.json` 存在内容，否则静默不注册

---

## 1. 为什么必须做

### 1.1 审批卡是怎么弹出来的

这条链一共有四跳，缺任何一跳都没有卡：

```
模型要调工具
   ↓
dsh-tools\prepareExecution()
   ↓  ctx.waterfall(carrier, "tools/pre-execute", exec, () => ({kind:"allow"}))
   ↓  ← ★ 唯一能返回 {kind:"ask"} 的地方
dsh-hooks-claude-code（官方插件，读 hooks.json 里的 PreToolUse 规则）
   ↓  return { kind: "ask", reason }
   ↓  if (gate.kind === "ask") await this.serviceAsk(exec, gate)
dsh-tools\serviceAsk() → ctx.get("approval").request({...})
   ↓
dsh-approval-gate  （ctx.on("approval/request", ...)  ← 到这里才轮到你写的那个门）
   ↓
审批卡
```

关键点：**`dsh-approval-gate` 自己根本不碰 `tools/pre-execute`。**
它的源码里 `tools/pre-execute` 出现 0 次，它只监听 `approval/request`。
所以「门有没有拦住」这件事，前半段完全取决于 **hooks 桥**有没有返回 `ask`。

### 1.2 新版把这个包搬走了

对比 `0.2.0-rc.2` 和 `0.2.1-rc.2` 的 `resources\app.asar`：

| 项目 | 0.2.0-rc.2 | 0.2.1-rc.2 |
|---|---|---|
| 内建包总数 | 289 | 306 |
| `@deepseek-ai/dsh-hook-protocol` | 有 | **无** |
| `@deepseek-ai/dsh-hooks-claude-code` | 有 | **无** |
| `@deepseek-ai/dsh-hooks-codex` | 有 | **无** |

新版 `dsh\package.json` 的 dependencies 里，关键字 `hook` 命中 **0 次**
（旧版命中 5 次）。全树 grep 确认：**没有任何包再引用它们**。

### 1.3 后果

- `tools/pre-execute` 瀑布上再没有监听器返回 `ask`
- → `gate.kind` 永远是 `"allow"`
- → `serviceAsk()` 永不被调用
- → `approval/request` 永不存在
- → `dsh-approval-gate` 完全静默
- → **工作区外的写操作、危险命令，全部直通**

而且这个失效是**静默的**：不报错、不告警，只是卡再也不弹了。

---

## 2. 本插件做了什么

把上述链条里的那一跳，用一个**不依赖任何 `@deepseek-ai/*` 包**的实现补回来。

### 2.1 与官方逐字对齐的地方

| 维度 | 处理 |
|---|---|
| 配置文件格式 | Claude Code 的 `hooks.json` 原样兼容（含外层 `hooks` 键的写法，也接受裸事件表） |
| stdin payload | 同一个 `{session_id, transcript_path, cwd, hook_event_name, tool_name, tool_input, tool_use_id}` |
| 子进程调用 | 优先 `ctx.shell.execute(ctx.shell.resolve(req))` → `.result()` |
| 决策排序 | `deny(3) > ask(2) > allow(1)`，`block` 折进 `deny` 档 |
| reason 合并 | 同档多条 reason 用 `\n\n` 拼接 |
| 退出码语义 | `exit 2` = 阻断，reason 取 stderr |
| 事件名门控 | `hookSpecificOutput.hookEventName` 与触发事件不符 → 只丢事件域字段，不丢整条输出 |
| matcher 语义 | 全词字符 + `\|` 时按字面候选列表，否则当正则；`""` / `"*"` 是 match-all 哨兵 |
| 无 matcher 事件 | `UserPromptSubmit` / `Stop` 上的 matcher 直接丢弃 |
| 非 command 类型 | 跳过并 warn，不阻断 |
| 扩展点 | 全部 7 个，返回值契约与官方一致 |

### 2.2 7 个扩展点

| 扩展点 | 本插件返回 |
|---|---|
| `agent/created` | `agent.inject(context)`（SessionStart 的 additionalContext） |
| `agent/pre-step` | deny → `{kind:'reject'}` |
| **`tools/pre-execute`** | **deny → `{kind:'deny', reason}`；ask → `{kind:'ask', reason}`** ← 命脉 |
| `tools/post-execute` | deny/block → `{kind:'block', feedback:[{type:'text',text}], additionalContexts?}` |
| `agent/turn-stopping` | deny → `agent.steer(createUserMessage({...}))` |
| `subagent/start` | `SubagentStart` hook |
| `subagent/end` | `SubagentStop` hook |

### 2.3 刻意没做的（和官方一样）

- `updatedInput` —— 只 warn 后忽略，不改工具参数
- `systemMessage` —— 只 warn，不往会话里塞东西
- 自动审批 / judge / 白名单判断 —— 那是 `dsh-approval-gate` 的活，不在这里重叠

### 2.4 失败策略

- hook 脚本崩了、超时了、命令不存在 → **视为「无意见」**（返回 `next()`）
- **绝不**把崩溃当成 `allow`，也绝不把崩溃当成 `deny`
- 配置坏了 → 什么都不注册 + warn（和官方一样静默降级，不阻断会话）

> 为什么不用 `failMode: 'closed'`：`closed` 会在脚本跑挂时直接 deny，
> 那样子 agent 会因为一个写错的 hook 彻底动不了工具。默认 `open` 更安全。

---

## 3. 安装

```powershell
cd "D:\DeepSeek Harness工作目录\WorkBuddy Ai\_dsh-update-snapshot\hooks-shim"

# 先体检，不改任何东西
.\install-hooks-shim.ps1 -VerifyOnly

# 正式安装
.\install-hooks-shim.ps1

# 装到别的 profile
.\install-hooks-shim.ps1 -ProfileName web

# 卸载
.\install-hooks-shim.ps1 -Remove
```

脚本会：

1. 复制 `src\` + `cordis.patch.yml` + `package.json` → `<profile>\plugins\dsh-hooks-shim\`
2. 在 `<profile>\cordis.patch.yml` 末尾插一条 `- insert:` 块（已存在则跳过）
3. 备份原 `cordis.patch.yml` 到 `cordis.patch.yml.bak-before-hooks-shim`
4. `node --check src\index.mjs`
5. 跑一遍 `test\selftest.mjs`，21/21 不通过就报错并让你别重启

---

## 4. 配置

安装后插件是**空转**状态——因为还没有 `hooks.json`。
要让它真正干活，在 `<profile>\plugins\dsh-hooks-shim\hooks.json` 写规则：

### 4.1 兜底式：强制所有工具都过门

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "command": "node \"${CLAUDE_PROJECT_DIR}\\.dsh\\hooks\\ask-always.mjs\"",
            "timeout": 10
          }
        ]
      }
    ]
  }
}
```

`ask-always.mjs`：

```js
let raw = ''
process.stdin.on('data', (d) => { raw += d })
process.stdin.on('end', () => {
  const payload = JSON.parse(raw || '{}')
  // 只对真正危险的命令要审批，其余放行
  const danger = /(rm -rf|Remove-Item|del |rd |format |mkfs|shutdown)/i.test(
    JSON.stringify(payload.tool_input ?? {})
  )
  if (danger) {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'ask',
          permissionDecisionReason: '危险命令，需要人工确认'
        }
      })
    )
  }
  // 没有输出 = 无意见 = 放行
})
```

### 4.2 硬拒式：某些路径直接 deny

```js
const target = JSON.stringify(payload.tool_input ?? {})
if (/[A-Z]:\\\\Windows\\\\System32/i.test(target)) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: '系统目录禁止写入'
    }
  }))
}
```

### 4.3 配置项

`cordis.patch.yml` 里那条 `insert` 的 `config` 支持：

| 键 | 默认 | 含义 |
|---|---|---|
| `hooksFile` | `hooks.json` | 配置文件名，相对 `hooksDir` |
| `hooksDir` | 插件根目录 | 配置所在目录；相对路径基于插件目录的上一级 |
| `projectDir` | 会话 cwd | 传给 hook 的 `CLAUDE_PROJECT_DIR` |
| `defaultTimeoutMs` | `60000` | 单 hook 超时（官方是 600000，这里刻意压短） |
| `enabled` | `true` | 总开关 |
| `failMode` | `"open"` | `open` = 脚本失败视为无意见；`closed` = 视为 deny |
| `logInvocations` | `false` | 每次调用打一行日志 |

---

## 5. 安装后验证

1. **重启 DSH 宿主**（配置改动不会热加载）

2. 看宿主日志，应该有这两行：

   ```
   dsh-hooks-shim: loaded 1 hook group(s) from C:\...\hooks.json
   dsh-hooks-shim: armed on 7 extension points (agent/created, agent/pre-step, tools/pre-execute, tools/post-execute, agent/turn-stopping, subagent/start, subagent/end)
   ```

   如果看到的是 `no hook config at ...`，说明 `hooks.json` 没放到对的位置。

3. **实测审批卡**：在 D 盘根目录建文件夹

   ```
   在 D:\__gate_test_20260101 建一个空目录
   ```

   - 没有 `hooks.json` → 直接 `Access to the path ... is denied.`（沙箱拦的，不弹卡）
   - 有 `hooks.json` 且写了 ask 规则 → 应该弹卡
   - 弹不出来 → 看 `C:\Users\Administrator\.dsh\auto-approve\events.jsonl` 有没有新增行

4. **查账本**：

   ```powershell
   (Get-Content "$env:USERPROFILE\.dsh\auto-approve\events.jsonl").Count
   ```

   数字没涨 = 卡没走到门那里。

---

## 6. 文件清单

```
hooks-shim/
├─ src/
│  └─ index.mjs              680 行，全部逻辑，零依赖
├─ test/
│  └─ selftest.mjs           21 个用例，自建 harness（不依赖 node --test）
├─ cordis.patch.yml          `- insert:` 模板块
├─ package.json              name / type / main / exports / dsh.bundle.patch
├─ install-hooks-shim.ps1    安装器（UTF-8 with BOM）
└─ README.md                 本文件
```

---

## 7. 测试

```powershell
cd "D:\DeepSeek Harness工作目录\WorkBuddy Ai\_dsh-update-snapshot\hooks-shim"
node test/selftest.mjs
```

预期输出结尾：

```
================  21 passed, 0 failed  ================
```

### 7.1 覆盖了什么

| 分组 | 用例数 | 内容 |
|---|---|---|
| 配置解析 | 8 | 嵌套/裸事件表、`matcher:"*"`、`matcher:""`、非 command 跳过、配置缺失、坏 JSON、UserPromptSubmit matcher 丢弃 |
| PreToolUse 映射 | 6 | deny→deny、ask→ask、无输出→allow、exit 2→deny、事件名不匹配、命令不存在 |
| 决策合并 | 4 | allow+deny→deny、ask+deny→deny、matcher 不匹配、`\|` 候选列表 |
| 其余扩展点 | 3 | 7 个点全注册、pre-step→reject、post-execute→block+feedback |

合计 **21 passed / 0 failed**。

### 7.1b `rules/gate-bridge.mjs` 的判定回归（18 例）

`gate-bridge.mjs` 是真会被宿主调用的那条，判定必须单独验。用 18 个场景喂 stdin：

| # | 场景 | 期望 | 实际 |
|---|---|---|---|
| 1 | 写工作区内文件（路径含空格） | 无意见 | 无意见 |
| 2 | `New-Item D:\__probe_test` | ask | ask |
| 3 | `read` 读 `.ssh\id_rsa`（只读豁免） | 无意见 | 无意见 |
| 4 | `Remove-Item -Recurse D:\somewhere` | ask | ask |
| 5 | `curl -X POST https://…` | ask | ask |
| 6 | `Get-Content .ssh\id_rsa` | ask | ask |
| 7 | `Get-ChildItem .` | 无意见 | 无意见 |
| 8 | `Remove-Item -Recurse C:\Windows\System32` | deny | deny |
| 9 | 写 `C:\Users\…\下载\报告 v2.txt` | ask | ask |
| 10 | 写工作区内含空格路径 | 无意见 | 无意见 |
| 11 | `Get-ChildItem "D:\…\WorkBuddy Ai"` | 无意见 | 无意见 |
| 12 | `Get-ChildItem "C:\Users\…\下载"` | ask | ask |
| 13 | `Copy-Item "工作区内" "下载\b.txt"` | ask | ask |
| 14 | `Copy-Item "工作区内" "工作区内"` | 无意见 | 无意见 |
| 15 | 写工作区内文件，正文里引用外部路径 | 无意见 | 无意见 |
| 16 | 写工作区外文件（目标字段越界） | ask | ask |
| 17 | `Get-Content` 读外部路径 | ask | ask |
| 18 | 写工作区内文件，正文无路径 | 无意见 | 无意见 |

**空格截断 bug（已修，两次）**——这是本插件最容易复发的地方：

| 轮次 | 现象 | 根因 | 修法 |
|---|---|---|---|
| 第 1 次 | `D:\DeepSeek Harness工作目录\…\test.txt` 被切成 `D:\DeepSeek` → 误报「工作区外」 | `extractAbsolutePaths` 用 `[^\s]` 直接截断 | 先按引号切，引号内整段当一个路径 |
| 第 2 次 | `C:\…\下载\报告 v2.txt` 被切成 `C:\…\下载\报告` | `flattenInput` 把路径字段也拼进自由文本，引号信息已丢失 | 路径字段（`PATH_KEYS`）**不进自由文本**，改由 `collectFieldPaths()` 整段取走 |
| 第 3 次 | 引号内 `"D:\…\WorkBuddy Ai"` 仍被切成 `D:\DeepSeek` | 引号内整段登记后**又**按空格切了一遍 | 引号内容本身是绝对路径时**只登记整段，绝不切** |

教训一句话：**路径字段整段取，只有 command 这类自由文本才做切分**。

**第 4 次不是空格问题，是「扫描面」问题**（2026-11-23 修）：

`flattenInput()` 除了路径字段与自由文本，还把「其余所有长度 ≤ 4000 的字符串字段」也拼进扫描块 —— `write` 的 `content`、`edit` 的 `new_string` 因此进了 `extractAbsolutePaths()`。正文里只要出现盘符字样或一个以斜杠开头的文件名，就会被判成「目标含工作区外路径」，而那次写的真实目标就在工作区内。

症状最有迷惑性：**文档越长越安全**（超过 4000 字符，正文被那条阈值挡在门外），于是同一件事有时弹、有时不弹。

修法两条：

1. 新增 `BODY_KEYS`（`content` / `new_string` / `old_string` / `new_str` / `old_str` / `file_text` / `replacement` / `patch` / `diff` / `body` / `text`），`flattenInput()` 见键即跳过 —— 正文是「要写进去的内容」，不是「要动的目标」。
2. R1 按工具分流：结构化目标（`PATH_KEYS` 命中字段）所有工具都算数；自由文本里解析出的路径只对 `EXEC_TOOLS` 算数（`pwsh`/`bash`/… 这类「一条命令里混着路径」才是正常形态）。`EXEC_TOOLS` 从函数内部提到模块级，供 R1 与 R4 共用。

回归脚本：`tools/verify-gate-path-scan.ps1`（在本仓库，跑 4 组用例，当前 `4 passed, 0 failed`）。

### 7.2 沙箱下的测试为何绕了一大圈

本机 DSH 沙箱**禁命名管道**，所以：

- `child_process` 用 `stdio: 'pipe'` → `Error: spawn EPERM`
- `node --test` 默认走 pipe → 也 EPERM

因此 `selftest.mjs` 里做了两件事：

1. **自建 harness**（`test(label, fn)` 那二十行），不用 `node --test`；
2. **注入一个假 shell 服务**（`makeFakeShell()`），复刻 `ctx.shell.execute/resolve` 的契约，
   内部用 `spawnSync('cmd.exe', [...], { stdio: 'ignore' })` + `.bat` 做文件重定向。

假 shell 踩过的三个坑（都写在代码注释里了，别再踩）：

| 坑 | 现象 | 正确写法 |
|---|---|---|
| `%ERRORLEVEL%` 在复合行提前展开 | `a.exe & echo %ERRORLEVEL%` 永远得旧值 | 写成 `.bat` 的多行，`set RC=%ERRORLEVEL%` 单独一行 |
| `cmd /d /s /c "<绝对路径>.bat"` | node 转义后 cmd 收到 `\"x.bat\"`，报 `is not recognized`，退出码 1、stderr 空 | **绝对路径不加引号**（临时目录名无空格） |
| 假 ctx 的 handler 用 Map 存 | 同事件注册两次时后者覆盖前者，两条 hook 组的合并用例假性失败 | 用 `Map<event, fn[]>`，与 cordis 多监听器语义一致 |

---

## 8. 卸载 / 回滚

```powershell
.\install-hooks-shim.ps1 -Remove
```

然后重启宿主。

想完全手动回滚：

1. 删 `<profile>\plugins\dsh-hooks-shim\`
2. 用 `cordis.patch.yml.bak-before-hooks-shim` 覆盖 `cordis.patch.yml`
   （或手动删掉含 `dsh-hooks-shim` 的那几行）

---

## 9. 边界

- **不替代 `dsh-approval-gate`**：本插件只负责把 `ask` 送到门口，
  批不批、怎么批、白名单命中与否，全在门那边。
- **不修 purge**：purge 的 82 条 patch 是否重打、要不要重打，是另一件事，
  见 `_dsh-update-snapshot\SNAPSHOT-META.md`。
- **动态生成的脚本抓不住**：这是 hook 机制的固有限制，不是本插件的缺陷。
- **`hooks.json` 里能跑任意命令**：它本质上就是一个「在这个事件上执行这条命令」的开关，
  写进去的命令拥有和宿主同等的权限。别把不可信的配置放进去。

---

*生成时间：2026-10-18 · 对应 DSH 0.2.1-rc.2 迁移*
