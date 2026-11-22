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
