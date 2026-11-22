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
| `disable-purge-patch.mjs` | 通用停用器：把指定的 purge 补丁改成停用桩（`disabled: true` + 哨兵 pattern），并用 `.dshpurge.bak` 还原它改过的宿主文件。`RESTORE` 表目前：`6`/`15` → `dsh-sandbox-local/lib/index.js`（同一文件，还原一次两条都中和）、`29` → `dsh-tool-web/lib/index.js`。幂等，同一目标本轮只还原一次，写盘前用 `new Function` 校验生成的桩 | 手工：`node disable-purge-patch.mjs 6 15 --dry-run` → 直接跑 → 重启 |

## 更新 DSH 之后，顺序不能反

安装器会把整个 `resources\app` 换成官方原版，**两件事都要重做，而且有先后**：

1. **先跑 `port-menu-restart.cmd`** —— 把 `app.asar` 解包、改名成 `.bak`、把菜单重启补丁装回去（`lib\main.js` 变成 1 KB 加载器 + `main.official.js`）。
2. **再点 purge 的「应用」** —— purge 只会按官方单体去改 `resources\app\lib\main.js`。

反过来的后果：purge 先把它认得的官方单体改完，`port-menu-restart` 再把 `main.js` 整体替换成加载器，purge 那 50 条补丁里针对 `main.js` 的部分就白打了（而且 purge 的 `applied.json` 仍记着「已应用」，不会重打）。
反顺序还能接受的情形只有一种：purge 那一轮的目标文件里没有 `lib\main.js`（`skip` 掉）。但别指望每次都这样。

装完补丁后，加载器只在外壳里追加菜单项，`main.official.js` 保留官方原件；purge 认不出的锚点会 `skipped`，不会把加载器改坏——但**备份仍然要先做**（`restore-loader.cmd` 就是兜底）。

## 哪些不进仓库

`idm-trial-reset.ps1` 写在 `.gitignore` 里（`tools/idm-trial-reset.ps1`）：它只在本机跑，不适合随公开仓库发布。删掉本目录其它文件后，这一个仍需手工放回。

## 已知的散落点

- `port-menu-restart.ps1` 里的真实移植脚本在 `D:\DeepSeek Harness工作目录\WorkBuddy AI\02_菜单重启按钮\port-menu-restart.ps1`（补丁工程本体），本目录这份只是包装器。
- 计划任务 `IDM Trial Reset` 已指向本目录的 `idm-trial-reset.ps1`（`-Auto -Deep`），`C:\Users\Administrator\bin` 下不再需要转发脚本。

## 为什么不留一份在 PATH 目录

`Get-AppxPackageFast` 这类脚本只有「敲裸命令」时才需要 PATH；所有脚本调用方（计划任务、补丁脚本、文档里的示例）都写完整路径。把脚本摊在 `C:\Users\Administrator\bin` 里既不进版本控制、也没有说明，出问题只能靠回忆——所以统一收到这里。
