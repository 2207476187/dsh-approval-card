# 审批卡片（dsh-approval-card）

DeepSeek Harness 的审批卡一直是「一张卡只有一个短路径」——看不到这次到底要动哪个文件、哪条命令、目标在不在工作区里。这个仓库装两样东西：

1. [dsh-approval-card-plugin](https://github.com/2207476187/dsh-approval-card-plugin) —— 一个 Cordis 插件，在卡片顶部给出**精确目标**（完整路径 / 完整命令行）与操作分类，并保留下游的拦截理由；
2. `tools/patch-approval-gate.mjs` —— 给 `dsh-approval-gate` 打的一个本地补丁，修掉「工作区路径含空格就被判成工作区外」的 bug（否则每次 `write`/`edit` 都要点一次审批）。

两者互相独立：不打补丁，卡片文案照样更清楚；打补丁，审批次数才是真的降下来。

## 目录

```
tools/           patch-approval-gate.mjs：审批门路径截断补丁（幂等，可 --status/--dry-run）
docs/adr/        两个决策记录：为什么写插件、为什么打补丁而不是关开关
docs/devlog/     过程记录：怎么定位到审批门、多帧 zstd 取证、每一轮修了什么
docs/            upstream-issue-*.md：可直接提交给上游的 bug 报告（含最小复现）
probes/          取证脚本：回放历史会话、检查入口行为、复现审批门截断
logs/            原始报错（文档里按 路径:行号 引用）
```

插件源码不在本仓库，见下面的「三个仓库」。

## 三个仓库

- **[dsh-approval-card-plugin](https://github.com/2207476187/dsh-approval-card-plugin)** —— 审批卡片插件源码，仓库根目录就是包根（`package.json` / `src/` / `client.js` / `locale/` / `test/`），可以直接当插件仓库装；
- **[dsh-usage-cost](https://github.com/2207476187/dsh-usage-cost)** —— 用量计费插件源码：在「用量 X tok」旁边显示本轮花费，在输入框下方显示整会话花费（宿主投影折叠 + 官方峰谷价）；
- **本仓库** —— 补丁脚本 + 取证脚本 + 决策与过程记录，回答「为什么这么做」。

本仓库不再放插件源码副本：同一份代码在多个地方各存一份，同步全靠手工，已经出过把清洗过的路径覆盖回去的事故。要改插件就改插件仓库。


## 插件做了什么

卡片第一行变成：

```
对 D:\work\proj\src\text.mjs 进行修改文件 [ 修改 ]
权限：仅工作区可写（工作区外仍被拒绝）
理由：需要放大正则里的字符类，修掉路径被空格截断的问题。
```

- 目标来源按优先级取：结构化 `file_path`/`path`… → 命令里命中语句的路径 → 整条命令 → 理由文本 → 工作目录；都没有时写「未知位置」，不编造。
- 命令里的 `$env:NAME` 会按真实环境展开；`cd` 的目标不算本次操作目标；`http://…` 不会被当成 `p://` 盘符。
- 审批门把理由整块塞进 `reason` 时，只保留「拦截 / 影响 / 原因」这类字段，删掉与首行重复的「操作 / 路径」。
- 同一次操作被问两次（审批门 + 沙箱提权）时，第二张卡会标注「（同一次操作的第 2 个审批请求）」，不做合并。
- **只改 `displayReason`，从不改 `req.reason`**：下游插件靠 `reason` 里的 `escalate sandbox to <mode>` 解析模式，改了就断链。

## 装法（本机 = Windows + desktop profile）

插件按 profile bundle 登记，不写在 `cordis.patch.yml` 的 `insert` 里（那样会挂两遍）：

1. 从 [插件仓库](https://github.com/2207476187/dsh-approval-card-plugin) 取源码，放到 `%DSH_HOME%\profiles\desktop\plugins\dsh-approval-card\`（`git clone` 或 `dsh plugin add`）
2. `profiles\desktop\package.json`：`dependencies` 加 `"dsh-approval-card": "file:plugins/dsh-approval-card"`，同时把 `"dsh-approval-card"` 加进 `dsh.profile.bundles`
3. `node_modules` 下建 junction 指向上面的目录（pnpm 装不动时用这个顶替）：
   `New-Item -ItemType Junction -Path …\node_modules\dsh-approval-card -Target …\plugins\dsh-approval-card`
4. 本包自带的 `cordis.patch.yml` 用**裸包名**插入，由 profile 加载器解析
5. 重启 DSH

显示名（「审批卡片」/ `Approval Card`）来自 `locale/zh.json` 与 `locale/en.json` 的 `meta.title`；`en.json` 是宿主导航的锚点，缺了就不读。

## 补丁用法

```powershell
node tools/patch-approval-gate.mjs --status     # 看有没有打上
node tools/patch-approval-gate.mjs --dry-run    # 只报告，不写
node tools/patch-approval-gate.mjs              # 打补丁（写前备份，写完 node --check，失败回滚）
```

幂等，锚点不唯一会拒绝执行。**插件更新后需要重跑一次**。

## 文档

- `docs/adr/0001-审批卡文案由独立插件改写-displayReason.md`
- `docs/adr/0002-本地补丁修审批门路径截断.md`
- `docs/devlog/2026-11.md` —— 完整过程（含被否决的方案）
- `docs/upstream-issue-approval-gate-path-truncation.md` —— 给上游的 bug 报告

## 已知遗留

- 复合命令里 `cd 'X' && …` 已从目标里剔除 `cd` 目标，但「语句归属」仍按第一个命中的绝对路径算；
- 宿主没有英文文案时，`displayReason.en` 回退成中文总结（不伪造翻译）；
- 改完 `src/` 需要重启 DSH 才生效 —— Cordis 模块不会热重载。
