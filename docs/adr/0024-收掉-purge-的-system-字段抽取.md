# 0024 收掉 purge 的 system 字段抽取

- 状态：已采纳
- 日期：2026-11-24
- 相关：`#89` `SYSTEM_FIELD_EXTRACT`、`#55`/`#72`、`docs/adr/0020`

## 背景

`#89` 改的是 `dsh-agent-loop/lib/index.js` 的 `buildRequest`。官方实现把会话边界消息整体下传（`bak` L1091–L1105）：

```js
const boundaryMessages = session.deriveMessages();
for (const message of boundaryMessages) { /* deepFreeze */ }
Object.freeze(boundaryMessages);
return markAgentLoopRequest(Object.freeze({
  ...header.config,
  messages: boundaryMessages,
  ...
```

没有 `system` 字段——系统提示就以 `role: "system"` 的普通元素待在 `messages` 里。

`#89` 插了一段分流：按 `role === "system"` 把文本块收进 `systemParts`，其余进 `nonSystemMessages`，再把 `systemParts.join("\n\n")` 作为顶层 `system` 字段传出。宿主文件因此多 760 字节（67,799 → 68,559 B）。

下游 `dsh-llm-deepseek` 本来支持两条通道（`L1725`–`L1739`）：`inHistory` 为真时把 system 消息 push 进 `systemUpdates`（稍后作为 `messages` 里的独立条目），否则记进 `historySystem` 拼到顶层 `system`（`L1777`）。`#89` 在更上游把 system 消息抽走，等于让前一条通道永远没料可用。

三个后果：一是 `messages` 里的 mid-conversation system 通道失效，`systemUpdates` 恒空、`historySystem` 恒 undefined；二是 `#55`/`#72` 刚恢复的「变化时追加、保留旧节点」机制被架空——`project()` 追加的 `system/message` 到不了适配器；三是历史里累积的 system 消息被 `join` 成一份字符串塞进顶层，每次变化整块重写，前缀缓存全部失效，且这个字符串随时间单调变长。

补丁的 `desc` 写明动机：避免 0.2.0 把系统提示词当对话历史。当前安装的是 `dsh-llm-deepseek@0.2.2-rc.5`，`L1686`–`L1738` 已经把两种落点分清楚，还带 `unsupported("non-text system message")`、`unsupported("system update without a preceding user or tool-result turn")` 这类显式校验——它要绕的缺陷已被上游修掉。

## 候选

- **A 保持现状**：能跑，兼容性更宽（顶层 `system` 是各家都认的写法）。代价是缓存全失效、顶层 system 单调增长、in-history 机制闲置。
- **B 只造停用桩、不动宿主**：面板不再重打，但宿主里那段搬运还在生效，等于只关了一半。
- **C 定点还原 + 造桩**（采纳）：把 `L1093`–`L1122` 换回官方三行，再给定义造桩。
- **D 改成只对特定 provider 生效**：按 `connection.baseURL` 分流，接官方端点走官方通道、接第三方代理才抽字段。方向正确，但要改宿主逻辑、自己维护一份 provider 白名单，收益不如直接回官方；等真接代理时再说。

## 决定

选 C。不能整文件还原：`dsh-agent-loop/lib/index.js.dshpurge.bak` 是脏的（混着 `#86` 的注释与更早的改动，与 live 差 22 行），整文件覆盖会把那些一并回滚。所以写了 `tools\restore-system-field-extract.mjs` 做定点替换，官方片段**从备份按行取出**再套上 live 的缩进，不手抄。

替换后 68,559 → 67,799 B（少 760），`systemParts` / `nonSystemMessages` / `system field extract` 三个串归零，`messages: boundaryMessages,` 与 `frozenMessages.has(message)` 各回到 1 次，`node --check` 通过。随后 `node tools\disable-purge-patch.mjs 89` 把定义改成桩（3140 → 337 字符）。

## 代价

- 只能定点，不能靠 `.dshpurge.bak`；升级覆盖宿主后要重跑 `restore-system-field-extract.mjs --apply` 再 `disable-purge-patch.mjs 89`（顺序不能反，先还原文件再造桩）。
- 接第三方 OpenAI 兼容代理时，若对方不接受 `messages` 里的 mid-conversation system，这套官方路径会出问题；那时要按候选 D 的思路另做，而不是恢复 `#89`（它没有 provider 判断）。
- 停用后 `#89` 显示 `skipped`，与另外 28 条停用桩一样，purge 面板再点「应用」不会重打。
