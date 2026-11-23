# 0020 收掉系统提示覆盖补丁（#55 / #72）

- 状态：已采纳
- 日期：2026-11-23

## 背景

purge 有两条补丁在做同一件事的两个层面，目的都是让系统提示「永远只有最新一份」：

| 编号 | 文件 | 改动 |
|---|---|---|
| `#55` `SYSTEM_PROMPT_REPLACE_HEAD` | `dsh-agent-loop/lib/index.js:866` | `inHistory: preparedCall?.systemPromptUpdate === "in-history"` → `inHistory: false` |
| `#72` `MESSAGES_SYSTEM_CURRENT` | `dsh-llm-deepseek/lib/index.js` | 官方那段 `if (inHistory && messages.length > 0) { … systemUpdates.push({ role: "system", … }) } else historySystem = text;` → 一行 `if (text.length > 0) historySystem = text;` |

官方设计是「变化时追加」：agent-loop 在 `project()` 里把新系统提示 append 成一条新的 `system/message`，源码注释写明 `a capable continuing series keeps appended nodes in place to preserve the prefix`；适配器再把它 push 进 `systemUpdates`，作为额外的 system 消息发出。purge 把两层都改成覆盖——agent-loop 改写第一条并清空其它 system 节点，适配器只覆盖单个 `historySystem` 字段。

`#55` 的 desc 自述动机是「避免旧提示被钉住」，但 `deepseek-flash` 在模型目录里**本来就声明了** `systemPromptUpdate: "in-history"`（`.dshpurge.bak` L74 的官方原文，不是 purge 加的），官方路径已经在处理这件事。

实测频率：当前会话 3,600+ 帧、跨 20 多小时，`system/message` 事件只有 2 条、`surfaceOp` 为 `replace` 的 0 条 —— 稳态下两条补丁一次都没触发。触发点是进/出 plan mode、工具集变动、换 persona、换模型；AGENTS.md 编辑不算（那走 `system-reminder` 注入 user 消息）。

## 候选

- **A 保持现状**：系统提示永远一份。长会话反复变化时上下文不被旧规则占用，但每次变化都从第一条起改写，前缀缓存全量失效（系统提示 8K + 前缀 100K 的会话，变化一次多付约 108K 未命中 token），且模型看不到规则演化过程。
- **B 只收 `#55`**：无效。`#72` 仍在适配器层把追加折成覆盖，官方那条路径照样通不了。
- **C 两条一起收（采纳）**：定点回改宿主文件 + 造停用桩。恢复官方语义：变化时追加、前缀缓存命中、历史可追溯。代价是旧提示可能累积在上下文里。
- **D 只收 `#72`**：agent-loop 仍会替换第一条，效果与 B 对称，同样不完整。

## 决定

按 C。做法：

1. `tools/restore-system-prompt-append.mjs`：官方原文**从 `.dshpurge.bak` 按行取出**再替换回 live，不手抄（避免缩进与转义出错）。`#55` 是单行替换、`#72` 是「1 行 → 官方 10 行」。默认预览，`--apply` 才写，写盘前备份 `<file>.bak-<stamp>-append`；脏标记出现次数不为 1 即 `exit 3`。
2. `node tools/disable-purge-patch.mjs 55 72` 造停用桩。**两条都不进 `RESTORE`**：`dsh-agent-loop` 的 `.dshpurge.bak` 是脏的（混着 `#86` 等改动，与 live 差 1,020 B），`dsh-llm-deepseek` 的备份也含 `#43` 一带的改动，整文件还原会连带回滚已经处理好的部分。

## 代价

- 长会话里系统提示变化多次时，官方形态会让多份旧提示留在历史中（每次 8K 左右），上下文变长、请求体积变大。这是用官方的直接成本。
- 若某个 provider 曾出现「旧提示被钉住」的症状，收掉后会回来。本机只有 `deepseek-flash` 与 `deepseek-v4-pro` 两个目录条目，前者官方声明 `in-history`，后者未声明（走替换），风险面很小。
- 宿主两文件各多一份 `.bak-<stamp>-append`；purge 重装后需重跑 `restore-system-prompt-append.mjs` → `disable-purge-patch.mjs 55 72`。
- `#72` 还原时把 `return unsupported("empty in-history system update")` 一并带回：空系统提示从「静默忽略」恢复成「报错」。
