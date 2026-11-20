# tools

本目录放「一次性/运维用」的手工脚本。共同约定：

- **`idm-trial-reset.ps1` 之外都不在 PATH 上**。调用一律写完整路径，或双击同目录的 `.cmd`。
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
| `patch-approval-gate.mjs` | 给 `dsh-approval-gate` 打本地补丁（结构化字段 `file_path` 不再被空白截断），幂等，审批门更新后重跑 | 手工：`node patch-approval-gate.mjs --status` |

## 哪些不进仓库

`idm-trial-reset.ps1` 写在 `.gitignore` 里（`tools/idm-trial-reset.ps1`）：它只在本机跑，不适合随公开仓库发布。删掉本目录其它文件后，这一个仍需手工放回。

## 已知的散落点

- `port-menu-restart.ps1` 里的真实移植脚本在 `D:\DeepSeek Harness工作目录\WorkBuddy AI\02_菜单重启按钮\port-menu-restart.ps1`（补丁工程本体），本目录这份只是包装器。
- 计划任务 `IDM Trial Reset` 目前仍指向 `C:\Users\Administrator\bin\idm-trial-reset.ps1`（一个转发脚本，因为改任务需要管理员权限）。等用管理员身份跑一次重指向后，那个转发脚本可以删掉，任务直接指向本目录。

## 为什么不留一份在 PATH 目录

`Get-AppxPackageFast` 这类脚本只有「敲裸命令」时才需要 PATH；所有脚本调用方（计划任务、补丁脚本、文档里的示例）都写完整路径。把脚本摊在 `C:\Users\Administrator\bin` 里既不进版本控制、也没有说明，出问题只能靠回忆——所以统一收到这里。
