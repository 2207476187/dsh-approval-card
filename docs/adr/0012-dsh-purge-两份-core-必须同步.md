# 0012 dsh-purge 有两份 core.js，写一份必须同步另一份

- 状态：已采纳（2026-11-22）
- 影响面：`tools/disable-purge-patch.mjs`、`tools/purge-skip-disabled.mjs`、以及任何手工改 `core.js` 的操作

## 背景

用户重启 DSH 后，面板上 `#33`、`#48` 显示「待应用」，而 `node .build/check-patch-status.mjs` 报 `#33 skipped / #48 skipped`。同一个库给出两个答案。

排查结果：`profiles\desktop` 下有**两份 dsh-purge**。

| 路径 | 谁在用 |
|---|---|
| `vendor\dsh-purge\lib\core.js` | 一直是脚本改的那份 |
| `node_modules\dsh-purge\lib\core.js` | 面板（cordis 插件）实际加载的那份 |

两份 inode 不同（`7881299349069214` vs `281474977977019`），大小 357,303 / 360,286，早就分叉了。此前一直以为它们是硬链接、改一处两处都变——这个假设是错的。

## 为什么会显示「待应用」

`filePatchOutcome()` 的判定是：

```js
if (filePatchSettled(text, patch, fp)) return "applied";
if (patchHasRemainingWork(text, patch, fp)) return "pending";
return "skipped";
```

旧的那份里 `#33`/`#48` 还是原定义（`disabled: false`），pattern 就是官方原文。而我们在上一轮把宿主文件**改回了官方原文**，于是 `patchHasRemainingWork` 恒为真：面板认为「原文还在，等你点应用把它改脏」。

也就是说，我越把文件修得干净，旧面板越坚持它是待办。

## 候选

- **A** 只把 node_modules 那份覆盖一次。否决：purge 升级或面板重写时会再分叉一次，问题复发且无声。
- **B** 删掉一份，只留一处。否决：两份分别属于「升级载体」与「模块解析路径」，删哪个都可能被下次安装补回来。
- **C** 以 `vendor` 为准，每次写盘后把内容镜像到 `node_modules`（采纳）。
- **D** 重建硬链接。否决：只要有一次非原地写（写临时文件再 rename）就再断，而且断了没有任何提示——正是这次踩的坑。

## 决定

1. `tools/disable-purge-patch.mjs` 新增 `mirrorToNodeModules(text, stamp)`：写完 vendor 后比对 `node_modules` 副本，内容不同就先备份 `<file>.bak-<stamp>-mirror` 再覆盖；副本不存在则只警告不阻断。
2. `tools/purge-skip-disabled.mjs` 在写盘后做同样的同步。
3. 一次性修复：2026-11-22 已把 vendor 内容镜像过去，备份 `core.js.bak-20261122140312-mirror`（360,286 B）。
4. 全目录对账：除备份文件外两边内容零差异，确认只有 `core.js` 分叉过。

验证：`vendor` 与 `node_modules` 同为 357,303 B / sha256 前 16 位 `d510dc36aeaf191a`；分别 import 两份跑 `patchStatus`，`#33`、`#48` 均为 `skipped`，`disabled=true`；两个脚本重跑输出「没有需要改动的地方」。

## 代价

- 每次改补丁都是两次写盘 + 两份备份，`node_modules` 下会累积 `.bak-*-mirror`。
- 手工改 `core.js`（不走脚本）时必须自己同步另一份，否则又回到「面板说待应用、脚本说跳过」的分裂状态。
- 面板要重启才会重新 `require` 这个模块，所以改完仍要重启 DSH 才能看到状态变化。
