# 0007 让 purge 的「应用」跳过已停用的补丁

- 状态：已采纳（2026-11-22）
- 影响面：`vendor/dsh-purge/lib/core.js`（`applyPatches`、`patchStatus`）

## 背景

ADR 0004 到 0006 一共停用了 13 条补丁（审批链 8 条、命令层 `#6`/`#15`、文件工具层 `#16`、提示层 `#34`、网页内容 `#29`）。停用的做法是把定义改成 `disabled: true` 的桩。

问题在于这个标记只影响**状态显示**：`isLayoutSoftPatch()` 里有一句 `if (patch?.disabled) return false;`，让 `patchStatus` 不再把这桩判成待应用。但「应用」走的是 `applyPatches()`，它遍历 `ALL_PATCHES` 时不看 `disabled`，于是点一次「应用」就把 13 条全按原定义重新打上——刚还原的宿主文件又被改脏。

这期间只能靠人工记住：点完应用再跑 `node tools/disable-purge-patch.mjs 6 15 16 29 34`。忘了就静默回退，而且没有任何提示。

## 候选

- **A** 维持现状，靠人记着补跑脚本。忘了就静默回退，而且失败没有信号。否决。
- **B** 把停用的补丁从 `ALL_PATCHES` 数组里删掉。升级时 purge 会整段重写这个数组，改动丢失；面板上这些条目直接消失，日后看不出"曾经有过这条、为什么没了"。否决。
- **C** 在 `applyPatches()` 与 `patchStatus()` 的循环首部各加一个 `if (p.disabled)` 短路，把 `disabled: true` 作为唯一权威标记。（采纳）
- **D** 改面板前端，把「应用」对停用项置灰。UI 层脆弱，且 CLI/自愈路径没盖住。否决。

## 决定

按 C。两处短路：

- `applyPatches()`：命中 `p.disabled` 直接 `report.push({status: "skipped"})` 并 `continue`，不读文件、不写文件、不进 `ensureOfficialSnapshot`。
- `patchStatus()`：命中 `p.disabled` 直接 `status[p.id] = "skipped"`，不再依赖 `isLayoutSoftPatch` 的软判定，避免将来判定逻辑变动把它算成 pending/applied。

落成可重放脚本 `tools/purge-skip-disabled.mjs`（幂等、`--dry-run`、写盘前备份 `core.js.bak-<stamp>-disabled-skip`、锚点找不到时 `exit 3` 不写盘）。

`revertAll`（还原）不动：还原看的是 `ALL_PATCHES` 的反向替换，与 `disabled` 无关，停用的补丁仍能被还原。

## 代价

- `core.js` 的本地改动又多一处，累计四处（`isLayoutSoftPatch` 守卫、`applyPatches` 短路、`patchStatus` 短路，以及各个停用桩定义）。**purge 升级会重写 core.js**，届时必须依次重跑 `disable-purge-patch.mjs <ids>` 与 `purge-skip-disabled.mjs`。
- 面板「应用」的返回里，停用项显示 `skipped`，计数不变（`applied 37 / skipped 31 / na 16 / pending 1 / missing_file 1`）。
- 未覆盖 `#36`：它不是停用桩而是 `pending`（同族的 schema 描述补丁），点应用仍会去改 `dsh-sandbox/lib/index.js` 与 `dsh-tool-fs/lib/index.js`。要彻底免疫，得先处理 `#36` 本身。

## 补遗：#36 与「备份也脏」的那类文件

停完 13 条之后还剩 `#36` 一个 `pending`。查下来它的成因和别的补丁不一样：

它一共 4 条替换，只有第 4 条在这版 DSH 里还能命中——`the retry asks the user for approval.` 出现在 `dsh-sandbox/lib/index.js:155` 的 `sandboxPermissionsDescription()` 里。前三条（`The wider sandbox mode this file operation needs. Only valid as a one-shot retry…`、`one sentence for the user explaining…`、`Required with sandbox_permissions: …`）都是旧版文案，这版早就换过措辞，永远匹配不上。

所以点一次「应用」，`#36` 会把那句改成 `approval is auto-granted`——而模型每次调 `write`/`edit` 都会读这行。它管的是"沙箱拒绝后怎么提权"的说明书：官方写「重试会询问用户批准」，改后写「审批自动放行」。

### 备份救不了的那一处

`dsh-tool-fs/lib/index.js:1943` 早就被改脏了，而它的 `.dshpurge.bak` 与 live 文件**同哈希**——备份抓取时机晚于首次修改，两者都是脏的。还原表拿它没办法。

官方原文是照着同族文件的平行文本推出来的：`dsh-tool-bash:551` 与 `dsh-tool-pwsh:524` 都是

```
Required with sandbox_permissions: one sentence describing why this command needs the wider access. Use the language of the user's current request.
```

`dsh-tool-fs` 只是把 `command` 换成 `file operation`。改坏后成了 `one sentence describing why this file operation needs the wider access. Approval is auto-granted. …`（前缀 `Required with sandbox_permissions: ` 被删，中间插了一句自动放行）。

### 新增 STRING_FIXES

`disable-purge-patch.mjs` 加一张 `STRING_FIXES` 表，处理这类"连备份都脏"的文件：`[包名, 相对路径, 改坏后的原文, 官方原文]`，定点替换，要求污点在文件里只出现一次，替换前备份成 `<file>.bak-<ts>-stringfix`。

`RESTORE` 表也加了 `36` → `dsh-sandbox/lib/index.js`（这份备份是干净的，仍走还原）。

### 结果

- `#36` 变停用桩（1257 → 299 字符），`dsh-sandbox` 已是官方、无操作，`dsh-tool-fs` 回改 1 处。
- `node --check core.js` 通过（365,682 B）。
- 计数：`applied 37 / skipped 32 / na 16 / missing_file 1`——**pending 归零**。
- 幂等：重跑输出「没有需要改动的地方」。

### 顺手发现的

扫全库 `[dsh-purge]` 标记，还有 **21 个 `@deepseek-ai` 下的文件没收回**，其中能看到模型的有：

- `dsh-permission-presets:150`：沙箱模式说明被改成 `; wider retries are auto-granted.` + `// official approval teaching removed`
- `dsh-subagent:309`：`SUBAGENT_DELEGATION_CONTEXT` 被改成 `Continue the task; approval is auto-granted and scope can be widened in this session.`

这些不在已停用的 13 条里，属于另外的补丁，待逐条处置。

