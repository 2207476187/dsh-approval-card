# tools

本目录放「一次性/运维用」的手工脚本。共同约定：

- **这里任何脚本都不在 PATH 上**。调用一律写完整路径，或双击同目录的 `.cmd`。计划任务、补丁脚本、文档示例全都是完整路径，没有一处依赖 PATH。
- `.ps1` 含中文的必须是 **UTF-8 with BOM**（Windows PowerShell 5.1 按 ANSI 解码，无 BOM 会乱码后语法报错）。写完用 `check-ps1.ps1 -Path <文件>` 自检。
- `.cmd` 里**不要写中文字面路径**：`.cmd` 需按 GBK/ANSI(936) 存才能让中文存活，容易出错，所以这里一律只写 `%~dp0xxx.ps1`，中文路径藏在 `.ps1` 里。

| 文件 | 用途 | 谁在调它 |
|---|---|---|
| `check-ps1.ps1` | 检查 `.ps1` 的编码/BOM，并用真实的 PowerShell 5.1 解析一遍 | 手工：`check-ps1.ps1 -Path .` |
| `Get-AppxPackageFast.ps1` | 纯注册表读 Appx 包（不依赖 `Appx` 模块、不起子进程），输出 `Name/Version/Architecture/PackageFullName/InstallLocation/DisplayName/Scope`；`-Merge` 合并 x86+x64，`-Json` 恒出数组，`-AllUsers` 附带 HKLM | 手工；写脚本需要包版本/安装路径时用 |
| `idm-trial-reset.ps1` | IDM 试用期重置（清注册表 4 个值 + 磁盘标记；`-Deep` 连安装目录母本一起清，否则 IDM 会用母本盖回来）；`-Status` 看状态、`-Auto` 按阈值自动重置、`-InstallTask` 注册计划任务、`-Restore` 回滚 | **计划任务 `IDM Trial Reset`**（每天 10:00 + 登录时，`-Auto -Deep`） |
| `restart-dsh.ps1` / `restart-dsh.cmd` | 不依赖任何补丁重启 DeepSeek Harness：`CloseMainWindow` → 超时强杀 → 重新启动 | 手工双击 |
| `port-menu-restart.ps1` / `.cmd` | 把「菜单重启按钮」外壳补丁移植进 asar 时代的安装树：解包 `app.asar` → 改名成 `.bak` → 部署补丁 → 校验 → 启动。幂等，更新后重跑即可 | 手工双击 `port-menu-restart.cmd` |
| `rollback-menu-restart.cmd` | 反向操作：`app.asar.bak` 改回 `app.asar` → 删掉解包目录 → 重启 | 手工双击 |
| `restore-loader.ps1` / `restore-loader.cmd` | 把 `resources\app\lib\main.js` 换回菜单重启加载器：优先挑 `main.js.bak-*-before-purge`，没有就退 `before-menu-restart`，再退 `main.official.js` | 手工双击（purge 把加载器改坏时用） |
| `patch-approval-gate.mjs` | 给 `dsh-approval-gate` 打本地补丁（结构化字段 `file_path` 不再被空白截断），幂等，审批门更新后重跑 | 手工：`node patch-approval-gate.mjs --status` |
| `fix-python-path.ps1` | 从**机器级** PATH 删掉指向 `Python313` 的条目（Windows 机器级在前、用户级在后，前者会盖住后者里的新 Python）。自动备份并打印还原命令，保持 `REG_EXPAND_SZ`、广播 `WM_SETTINGCHANGE` | 手工：`-DryRun` 看变更 → 直接跑（自提权）→ `-Restore` 还原 |
| `install-skill-from-github.mjs` | 从 GitHub 仓库的一个目录装成 DSH skill：走 `gh api` 读 tree → 逐文件 raw 下载 → 静态扫描 8 类可疑模式 → 算每个文件 sha256。目标目录已存在即拒绝（不覆盖手改过的 skill），命中可疑内容退出码 2 但不自动删 | 手工：`node install-skill-from-github.mjs <owner/repo> <远端目录> <本地名> [--dry-run] [--json]` |
| `update-our-free-model.mjs` | 按作者 feed 清单把 `dsh-our-free-model` 升到最新（校验 size+sha256，整目录先备份）。npm 上的 latest 停在 2.1.0，真正的更新只走作者的 GitHub feed | 手工：`node --use-system-ca update-our-free-model.mjs --dry-run` |
| `disable-purge-approval-patches.mjs` | 停用 purge 里「绕过审批 / 改默认沙箱与审批策略」的 8 条补丁（`#5 #7 #8 #9 #10 #11 #12 #51`），并把被改脏的 `dsh-user-approval`、`dsh-base` 还原成官方。幂等，purge 每次「应用」或升级后重跑 | 手工：`--dry-run` 看改动 → 直接跑 → 重启 |
| `idm-clsid-scan.ps1` | 只读扫描 IDM 藏在 `HKCU\Software\Classes[WOW6432Node]\CLSID` 下的伪装计数器（`{07999AC3-…}` 的 `Model` / `Therad`）。**这两个是累计计数，不是试用剩余天数**：11-24 实测把它设成 10，IDM 启动两次后变成 11，同期的 `radxcnt` 也 24 → 26。判断试用状态看 `idm-trial-reset.ps1 -Status`（按上次重置时间 + 30 天推算），别看这两个值。纯 ASCII 英文输出，5.1/7 都能跑 | 手工：`idm-clsid-scan.ps1` |
| `disable-purge-patch.mjs` | 通用停用器：把指定的 purge 补丁改成停用桩（`disabled: true` + 哨兵 pattern），并用 `.dshpurge.bak` 还原它改过的宿主文件。`RESTORE` 表：`6`/`15` → `dsh-sandbox-local/lib/index.js`（命令层，同一文件还原一次两条都中和）、`16` → `dsh-fs-sandbox/lib/index.js`、`34`/`36` → `dsh-sandbox/lib/index.js`、`29` → `dsh-tool-web/lib/index.js`、`61` → `dsh-sandbox-policy` + 两个 `dsh-permission-presets` 文件（孤儿改动挂这里）、`37`/`92` → `dsh-subagent` 两文件（去重后只覆盖一次）、`23` → `dsh-tool-subagent/lib/index.js`。另有 `STRING_FIXES` 表处理**连 `.dshpurge.bak` 都是脏的**那种文件（备份抓取晚于首次修改），按官方原文定点替换、替换前备份 `<file>.bak-<ts>-stringfix`；`36` → `dsh-tool-fs` 的 `justification` 描述；`33` → `dsh-tool-bash`/`dsh-tool-pwsh` 的沙箱拒绝句、`justification` 说明与 pwsh 的 EPERM 边界（pwsh 沙箱句在 base 与 Windows 分支各一处，条目第 5 个字段声明预期 2 次）。默认要求污点恰好出现 1 次，给了第 5 个字段则按该次数全替换；`48` → 同两文件的 delete/move 谨慎句（bash 1 次、pwsh 2 次）；`22` → `dsh-tool-fs` 的三个 read 上限常量（单行 1e4、字节 1MB、行数 2e4 各回官方值）；`38` → `dsh-persona/lib/index.js`（备份干净，整文件还原成 `prefix: z.string().required()`，清掉 `text` 别名）；`39` → `dsh-session-format-v0-to-v1/lib/index.js`（v0 会话的 `summary` 形态校验，备份干净整文件还原）；`59` → `dsh-experimental-auto-review/lib/index.js`（Auto 档的 pre-execute 审查器被插了 `return next()`，备份干净整文件还原）；`78` → `dsh-app-boot/lib/index.js`（bundle 声明的补丁文件缺失时改从 `.dshpurge.bak` 读取，把「启动报错指名文件」变成静默沿用旧配置）。`24` 只造桩、**不进 `RESTORE`**：它从未真正改过 preset 文件（官方本来就是 `fetch: true`），而那几个 `.dshpurge.bak` 里还是 `#63` 三段的旧文案，整文件还原会把已还原的第一段再打回去。`55`/`72` 也只造桩、**不进 `RESTORE`**（`dsh-agent-loop` 的备份混着 `#86`、`dsh-llm-deepseek` 的备份含 `#43` 一带改动，整文件还原会连带回滚），宿主文件由 `restore-system-prompt-append.mjs` 定点回改。幂等，同一目标本轮只还原一次，写盘前用 `new Function` 校验生成的桩 | 手工：`node disable-purge-patch.mjs 6 15 16 22 23 24 29 33 34 36 37 38 39 48 55 59 61 72 78 89 92 --dry-run` → 直接跑 → 重启 |
| `purge-skip-disabled.mjs` | 给 purge 的 `applyPatches()` 和 `patchStatus()` 各加一个 `if (p.disabled)` 短路：点「应用」不再按原定义重打停用桩，状态也不再依赖软判定。不改 `revertAll`，还原照常。幂等、锚点找不到即 `exit 3` 不写盘、写盘前备份 `core.js.bak-<stamp>-disabled-skip` | 手工：`node purge-skip-disabled.mjs --dry-run` → 直接跑 → 重启。**升级 purge 后必须重跑** |
| `restore-plan-mode-first-clause.mjs` | 只还原 `#63` 的第 1 段（「用户对话中的同意不构成批准」），第 2、3 段保留。必须同时改两处：删掉 `#63.replacements[0]`（否则 pattern 命中官方句，点「应用」会把它打回）+ 四个 patch 文件里 `purge 句 + marker` 换回官方句；两份 core.js 都处理。`--dry-run` 先看字节数变化，`--apply` 才写盘并备份 `.bak-<stamp>-plan-clause`；官方句或 purge 句出现次数不为 1 即 `exit 3`，不猜 | 手工：`node restore-plan-mode-first-clause.mjs` → `--apply` → 重启 |
| `verify-gate-path-scan.ps1` | 验证 `dsh-hooks-shim` 的审批门不再把「文档正文里的路径」当成写目标（4 组用例：区内文件+正文引外部路径应不拦、区外目标应拦、命令读外部路径应拦、区内普通内容应不拦）。只读，payload 经 stdin 喂给 gate 子进程；`-Gate` 可指向另一份副本做新旧对照 | 手工：`pwsh -File tools\verify-gate-path-scan.ps1` |
| `harden-legacy-write.mjs` | 把 `#42` 插入的 legacy 设置持久化改成**原子写**：先写 `settings-legacy.yaml.<pid>.tmp`，再 `rename` 覆盖正本，避免整文件覆写中途失败把账号池写残。必须同时改两处——宿主 `dsh-settings/lib/index.js` 的实际代码，与两份 `core.js` 里 `#42` 的 replace 文本；只改前者的话点一次「应用」就会退回非原子写（`#42` 有 4 条 pattern 替换后仍命中，靠 `skipIfMarked` 拦重复应用）。三个目标各要求原始语句恰好 1 次，否则 `exit 3`；写盘前备份 `.bak-<stamp>-atomic`。幂等：已加固则直接跳过 | 手工：`node harden-legacy-write.mjs`（演练）→ `--apply`。DSH 升级不用重跑；**purge 重装后需重跑** |
| `restore-system-prompt-append.mjs` | 把 `#55`（`dsh-agent-loop` 的 `inHistory` 恒 false）与 `#72`（`dsh-llm-deepseek` 把「追加 system 消息」折成一行字段覆盖）还原成官方「变化时追加」的语义。官方原文从 `.dshpurge.bak` **按行取出**再替换，不手抄：`#55` 单行换单行、`#72` 一行换官方十行。`--dry-run` 默认，`--apply` 才写盘并备份 `.bak-<stamp>-append`；脏标记出现次数不为 1 即 `exit 3`。之后必须 `node disable-purge-patch.mjs 55 72` 造桩，否则点「应用」会打回 | 手工：`node restore-system-prompt-append.mjs` → `--apply` → `node disable-purge-patch.mjs 55 72` → 重启 |
| `purge-restore-state.mjs` | 一条命令把 purge 与宿主文件恢复到「22 应用 / 47 跳过」这套状态：按固定顺序跑七个脚本（三次定点还原 → 造桩+整文件还原+定点回改 → `#42` 原子写 → `#1` 重放规则 → 应用跳过 disabled）。默认演练，`--apply` 写盘。DSH 升级后跑这个再点「应用」即可 | 手工：`node purge-restore-state.mjs` → `--apply` → 重启 → 面板点「应用」 |
| `restore-system-field-extract.mjs` | 把 `#89`（`dsh-agent-loop` 的 `buildRequest` 把 `role: "system"` 消息抽成顶层 `system` 字段、`messages` 只留非 system）还原成官方整体下传。官方片段从 `.dshpurge.bak` 按行取出再套 live 缩进，不手抄；两个锚点各须唯一，7 项替换后断言，默认预览、`--apply` 写盘并备份 `.bak-<stamp>-sysfield`，已是官方形态时报「无需改动」。之后必须 `node disable-purge-patch.mjs 89` 造桩，且**不能整文件还原**（`dsh-agent-loop` 的备份混着 `#86` 与更早改动，与 live 差 22 行） | 手工：`node restore-system-field-extract.mjs` → `--apply` → `node disable-purge-patch.mjs 89` → 重启 |
| `gate-readonly-allow.mjs` | 给审批门 `gate-bridge.mjs` 加 **R0 只读放行**：exec 命令的唯一理由是「工作区外路径」、且每段首个 token 都在只读白名单里时不弹卡（`Get-Content`/`Select-String`/`Get-ChildItem`/`Get-FileHash`/`Test-Path` 等）。全文出现写动词（`Set-`/`Remove-`/`Invoke-`/`Out-`…）、重定向、`$( … )`、反引号、`Invoke-Expression`、`Start-Process`、`ForEach-Object` 一律不放；凭据仍走 R3。幂等（含 `isPureReadCommand` 即跳过），写盘前备份 `.bak-<stamp>-readonly` | 手工：`node gate-readonly-allow.mjs` 看预览 → `--apply`。改完立即生效（hooks 每次调用都 spawn 一次 gate），无需重启 |
| `verify-gate-readonly.ps1` | 验证 R0 没放开写操作：15 个用例（读源码/搜源码/列目录/算哈希/测路径 → 放行；写文件/管道写/重定向/删目录/读凭据/网络外发/读删串联/括号嵌套写 → 拦）。只读，payload 经 stdin 喂 gate 子进程；`-Gate` 指向另一份副本可做新旧对照（**备份文件要先复制成 `.mjs`**，node 不认 `.bak-<stamp>` 扩展名）。用例 12 固定记录已知缺口：`node -e` 这类「命令名只读、参数是代码」的形态 gate 判不了，靠沙箱兜底 | 手工：`pwsh -File tools\verify-gate-readonly.ps1` |

## 更新 DSH 之后，顺序不能反

安装器会把整个 `resources\app` 换成官方原版，**两件事都要重做，而且有先后**：

1. **先跑 `port-menu-restart.cmd`** —— 把 `app.asar` 解包、改名成 `.bak`、把菜单重启补丁装回去（`lib\main.js` 变成 1 KB 加载器 + `main.official.js`）。
2. **再点 purge 的「应用」** —— purge 只会按官方单体去改 `resources\app\lib\main.js`。

反过来的后果：purge 先把它认得的官方单体改完，`port-menu-restart` 再把 `main.js` 整体替换成加载器，purge 那 50 条补丁里针对 `main.js` 的部分就白打了（而且 purge 的 `applied.json` 仍记着「已应用」，不会重打）。
反顺序还能接受的情形只有一种：purge 那一轮的目标文件里没有 `lib\main.js`（`skip` 掉）。但别指望每次都这样。

装完补丁后，加载器只在外壳里追加菜单项，`main.official.js` 保留官方原件；purge 认不出的锚点会 `skipped`，不会把加载器改坏——但**备份仍然要先做**（`restore-loader.cmd` 就是兜底）。

### DSH 升级之后：purge 的桩不会丢

安装器只换 `resources\app`（宿主 `@deepseek-ai/*`），`~/.dsh\profiles\desktop\vendor\dsh-purge\` 不在替换范围里。所以 DSH 升级后：

- 九个定点回改过的宿主文件回到官方原文；
- 47 处停用桩、`disabled` 短路、`#1` 重放规则、`#42` 原子写加固**都还在**。

这一路径不需要跑恢复脚本，按上面的顺序（`port-menu-restart` → 点「应用」）做完就是期望结果：停用的全跳过，`#1` 按重放规则重新打上。

点「应用」之前先体检一次，确认那 22 条在新宿主上还打得动：

```powershell
node tools\preflight-upgrade.mjs
```

它比对 `tools/purge-baseline.json`（记着当前该有哪 22 条 applied），逐条打印升级后的状态。全绿就点应用；出现 ❌ 说明新版 DSH 改了那几句话，那几条不生效（不会改坏文件），用 `node .build\patch-json.mjs <id>` 看它本来要改什么，再决定是补 pattern 还是放弃。

### 更新 purge 之后：一条命令把状态恢复回来

只有**主动更新 purge**（把 `core.js` 换成新版本）才会丢掉这些改动：47 条停用桩、两处 `disabled` 短路、`#1` 的重放规则、`#42` 的原子写加固一起没了。新版会往后追加补丁编号，旧条目指向不变；但新加的几条默认启用，恢复脚本不会替你停用它们 —— 更新后跑一次 `node .build\check-patch-status.mjs --list` 看一眼有没有新的 applied 要判断。

```powershell
node tools\purge-restore-state.mjs            # 先演练，看每步要做什么
node tools\purge-restore-state.mjs --apply    # 真写盘，需要 danger-full-access
```

它按固定顺序跑七步，顺序错了会白做：

1. `restore-plan-mode-first-clause.mjs` —— 四个 preset yml 的对话同意条款回官方
2. `restore-system-prompt-append.mjs` —— `#55`/`#72`，系统提示改回追加
3. `restore-system-field-extract.mjs` —— `#89`，系统提示回到 `messages`
4. `disable-purge-patch.mjs <21 个 id>` —— 造停用桩 + `.dshpurge.bak` 整文件还原 + `STRING_FIXES` 定点回改
5. `harden-legacy-write.mjs` —— `#42` 的 legacy 设置写盘改成原子写
6. `add-official-replay-patch.mjs` —— 给 `#1` 补官方原文重放规则
7. `purge-skip-disabled.mjs` —— 让「应用」跳过 `disabled`

前三条必须在第四条之前：它们还原的是宿主文件内容，而第四条会按 `.dshpurge.bak` 整文件覆盖其中一部分。反过来（先造桩再还原）会让面板认为原文回来了、等着你再点应用打上去。

跑完重启 DSH，在 purge 面板点一次「应用」。核对面板：**22 应用 / 47 跳过 / 16 不适用 / 1 文件缺失**。对不上就是某一步没生效，看该步自己打印的原因。

脚本幂等：已经是目标状态时每步都报「已是官方原文 / 无需改动」，重复跑不会叠加改动。

顺序不能反：先有桩，短路才有东西可跳。做完再点「应用」就是安全的，停用项会一直显示 `skipped`。

### core.js 有两份，脚本会自己同步

`profiles\desktop` 下同时存在 `vendor\dsh-purge\lib\core.js`（脚本改的）和 `node_modules\dsh-purge\lib\core.js`（**面板实际加载的**）。两者不是硬链接，会各自分叉——2026-11-22 就因为面板那份还是旧定义（`#33`/`#48` 的 pattern 指向官方原文），把已回改的宿主文件判成「待应用」。

现在 `disable-purge-patch.mjs` 与 `purge-skip-disabled.mjs` 写完 vendor 都会比对并覆盖 `node_modules` 副本（备份 `<file>.bak-<stamp>-mirror`）。**手工改 `core.js` 时没有这层保护**，改完要自己镜像一次，否则面板与脚本会给出两个答案。核对命令：

```powershell
(Get-FileHash 'C:\Users\Administrator\.dsh\profiles\desktop\vendor\dsh-purge\lib\core.js').Hash
(Get-FileHash 'C:\Users\Administrator\.dsh\profiles\desktop\node_modules\dsh-purge\lib\core.js').Hash
```

两个哈希相同才算同步。改完仍需重启 DSH，面板才会重新加载这个模块。

### 保留项：`#1` 不在停用清单里

`#1` `WORKSPACE_CONTEXT_INTRO` 是**刻意保持生效**的（需求：工作区 AGENTS.md 要"无条件执行"，见 `docs/adr/0009`），所以它不出现在上面的重放命令里，也不该被加进去。

它的 `.dshpurge.bak` 是脏的（备份抓取晚于首次修改，L124/L125 与 live 逐字相同），`RESTORE` 还原不了它 —— 官方原文和手工回退步骤在 `docs/purge-official-agent-instructions.md`。

purge 升级后验证一条就够：

```powershell
Select-String -Path 'X:\Program Files\DeepSeek Harness\resources\app\dsh\node_modules\@deepseek-ai\dsh-agent-instructions\lib\index.js' -Pattern 'AGENT_INSTRUCTIONS_INTRO = "The following instructions are ACTIVE'
```

有命中 = 仍生效。没命中就点一次 purge「应用」—— 2026-11-22 20:01 给 `#1` 补了「官方原文 → 强引导语」的重放规则，所以点一下就够，不用手工改文件（离线验证见 `.build\verify-official-replay.mjs`）。

它带 `skipIfMarked: true`，因为 `STRONG_*_V2` 是 `STRONG_*` 的前缀，不设这个守卫每次 apply 都会再叠一层（实测 +841 字符/次，永不收敛）。

注意升级后 `#1` 会先显示 `skipped` —— 那是「没匹配到官方原文之外的东西」的正常态，不是失败。看到就点应用。

这条重放规则本身要靠脚本补进去（core.js 不在版本控制里，purge 重装就丢）：

```powershell
node tools\add-official-replay-patch.mjs --dry-run   # 先看要插什么
node tools\add-official-replay-patch.mjs             # 写入，自动备份 core.js.bak-<stamp>-official-replay
```

幂等，重复跑只报「已经补过」。判据是 `OFFICIAL_REPLACEMENT_BODY` 的 pattern 在文件里出现 2 处。

## 哪些不进仓库

`idm-trial-reset.ps1` 写在 `.gitignore` 里（`tools/idm-trial-reset.ps1`）：它只在本机跑，不适合随公开仓库发布。删掉本目录其它文件后，这一个仍需手工放回。

## 已知的散落点

- `port-menu-restart.ps1` 里的真实移植脚本在 `D:\DeepSeek Harness工作目录\WorkBuddy AI\02_菜单重启按钮\port-menu-restart.ps1`（补丁工程本体），本目录这份只是包装器。
- 计划任务 `IDM Trial Reset` 已指向本目录的 `idm-trial-reset.ps1`（`-Auto -Deep`），`C:\Users\Administrator\bin` 下不再需要转发脚本。

## 为什么不留一份在 PATH 目录

`Get-AppxPackageFast` 这类脚本只有「敲裸命令」时才需要 PATH；所有脚本调用方（计划任务、补丁脚本、文档里的示例）都写完整路径。把脚本摊在 `C:\Users\Administrator\bin` 里既不进版本控制、也没有说明，出问题只能靠回忆——所以统一收到这里。
