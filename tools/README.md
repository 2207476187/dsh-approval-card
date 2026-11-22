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
| `idm-clsid-scan.ps1` | 只读扫描 IDM 藏在 `HKCU\Software\Classes[WOW6432Node]\CLSID` 下的伪装计数器（`{07999AC3-…}` 的 `Therad` 等于试用剩余天数）。纯 ASCII 英文输出，5.1/7 都能跑 | 手工：`idm-clsid-scan.ps1` |
| `disable-purge-patch.mjs` | 通用停用器：把指定的 purge 补丁改成停用桩（`disabled: true` + 哨兵 pattern），并用 `.dshpurge.bak` 还原它改过的宿主文件。`RESTORE` 表：`6`/`15` → `dsh-sandbox-local/lib/index.js`（命令层，同一文件还原一次两条都中和）、`16` → `dsh-fs-sandbox/lib/index.js`、`34`/`36` → `dsh-sandbox/lib/index.js`、`29` → `dsh-tool-web/lib/index.js`、`61` → `dsh-sandbox-policy` + 两个 `dsh-permission-presets` 文件（孤儿改动挂这里）、`37`/`92` → `dsh-subagent` 两文件（去重后只覆盖一次）、`23` → `dsh-tool-subagent/lib/index.js`。另有 `STRING_FIXES` 表处理**连 `.dshpurge.bak` 都是脏的**那种文件（备份抓取晚于首次修改），按官方原文定点替换、替换前备份 `<file>.bak-<ts>-stringfix`；`36` → `dsh-tool-fs` 的 `justification` 描述；`33` → `dsh-tool-bash`/`dsh-tool-pwsh` 的沙箱拒绝句、`justification` 说明与 pwsh 的 EPERM 边界（pwsh 沙箱句在 base 与 Windows 分支各一处，条目第 5 个字段声明预期 2 次）。默认要求污点恰好出现 1 次，给了第 5 个字段则按该次数全替换；`48` → 同两文件的 delete/move 谨慎句（bash 1 次、pwsh 2 次）。幂等，同一目标本轮只还原一次，写盘前用 `new Function` 校验生成的桩 | 手工：`node disable-purge-patch.mjs 6 15 16 23 29 33 34 36 37 48 61 92 --dry-run` → 直接跑 → 重启 |
| `purge-skip-disabled.mjs` | 给 purge 的 `applyPatches()` 和 `patchStatus()` 各加一个 `if (p.disabled)` 短路：点「应用」不再按原定义重打停用桩，状态也不再依赖软判定。不改 `revertAll`，还原照常。幂等、锚点找不到即 `exit 3` 不写盘、写盘前备份 `core.js.bak-<stamp>-disabled-skip` | 手工：`node purge-skip-disabled.mjs --dry-run` → 直接跑 → 重启。**升级 purge 后必须重跑** |

## 更新 DSH 之后，顺序不能反

安装器会把整个 `resources\app` 换成官方原版，**两件事都要重做，而且有先后**：

1. **先跑 `port-menu-restart.cmd`** —— 把 `app.asar` 解包、改名成 `.bak`、把菜单重启补丁装回去（`lib\main.js` 变成 1 KB 加载器 + `main.official.js`）。
2. **再点 purge 的「应用」** —— purge 只会按官方单体去改 `resources\app\lib\main.js`。

反过来的后果：purge 先把它认得的官方单体改完，`port-menu-restart` 再把 `main.js` 整体替换成加载器，purge 那 50 条补丁里针对 `main.js` 的部分就白打了（而且 purge 的 `applied.json` 仍记着「已应用」，不会重打）。
反顺序还能接受的情形只有一种：purge 那一轮的目标文件里没有 `lib\main.js`（`skip` 掉）。但别指望每次都这样。

装完补丁后，加载器只在外壳里追加菜单项，`main.official.js` 保留官方原件；purge 认不出的锚点会 `skipped`，不会把加载器改坏——但**备份仍然要先做**（`restore-loader.cmd` 就是兜底）。

### 还有第三件：把停用桩补回来

purge 自己升级（或重装）会把 `vendor/dsh-purge/lib/core.js` 换成新版本，13 个停用桩和两处 `disabled` 短路一起丢。按顺序重放：

```powershell
node tools\disable-purge-patch.mjs 6 15 16 23 29 33 34 36 37 48 61 92   # 造桩 + 还原 / 定点回改宿主文件
node tools\purge-skip-disabled.mjs                   # 让「应用」认得 disabled
```

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
