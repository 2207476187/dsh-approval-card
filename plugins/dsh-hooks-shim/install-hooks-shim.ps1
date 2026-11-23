# 用途：把 dsh-hooks-shim 注册进 DSH profile（PowerShell 5.1 / 7 通用）
#
# 这个脚本做三件事：
#   1. 把 hooks-shim 整个目录复制进 <profile>\plugins\dsh-hooks-shim
#   2. 在 <profile>\cordis.patch.yml 里插入一条 `- insert:` 块（幂等）
#   3. 跑一次 shim 的自测，确认零依赖也能跑通
#
# 用法：
#   .\install-hooks-shim.ps1              # 默认装到 desktop profile
#   .\install-hooks-shim.ps1 -Profile web
#   .\install-hooks-shim.ps1 -VerifyOnly  # 只体检，不改任何东西
#   .\install-hooks-shim.ps1 -Remove      # 卸载（删 insert 块 + 删目录）
#
# ⚠ 本文件必须存成 UTF-8 with BOM，否则 Windows PowerShell 5.1 会按 GBK 解码中文注释
#   导致语法错误。写回时请用：
#   [System.IO.File]::WriteAllText($p, $s, [System.Text.UTF8Encoding]::new($true))

[CmdletBinding()]
param(
    [string] $ProfileName = 'desktop',
    [switch] $VerifyOnly,
    [switch] $Remove,
    [switch] $Force
)

$ErrorActionPreference = 'Stop'

# ============================ 常量 ============================

$PluginId   = 'dsh-hooks-shim'
$DshHome    = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$ProfileDir = Join-Path $DshHome "profiles\$ProfileName"
$PatchYml   = Join-Path $ProfileDir 'cordis.patch.yml'
$PluginsDir = Join-Path $ProfileDir 'plugins'
$TargetDir  = Join-Path $PluginsDir $PluginId
$SourceDir  = $PSScriptRoot

# ============================ 输出 ============================

function Write-Step($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host "  [ok] $msg" -ForegroundColor Green }
function Write-Warn2($msg){ Write-Host "  [!!] $msg" -ForegroundColor Yellow }
function Write-Err2($msg) { Write-Host "  [xx] $msg" -ForegroundColor Red }

# ============================ 体检 ============================

function Test-Layout {
    Write-Step "检查目录布局"

    if (-not (Test-Path $DshHome)) { Write-Err2 "DSH_HOME 不存在：$DshHome"; return $false }
    Write-Ok "DSH_HOME = $DshHome"

    if (-not (Test-Path $ProfileDir)) { Write-Err2 "profile 不存在：$ProfileDir"; return $false }
    Write-Ok "profile   = $ProfileDir"

    if (-not (Test-Path $PatchYml)) { Write-Err2 "cordis.patch.yml 不存在：$PatchYml"; return $false }
    Write-Ok "patch yml = $PatchYml"

    foreach ($need in @('package.json', 'src\index.mjs', 'cordis.patch.yml')) {
        $p = Join-Path $SourceDir $need
        if (-not (Test-Path $p)) { Write-Err2 "源文件缺失：$p"; return $false }
    }
    Write-Ok "源目录完整 = $SourceDir"

    return $true
}

function Get-HooksStatus {
    $report = [ordered]@{
        Installed     = $false
        Inserted      = $false
        HooksJsonSeen = $false
        OfficialPkgs  = 0
    }

    $report.Installed = Test-Path (Join-Path $TargetDir 'src\index.mjs')

    if (Test-Path $PatchYml) {
        $text = [System.IO.File]::ReadAllText($PatchYml)
        $report.Inserted = $text -match [regex]::Escape($PluginId)
    }

    # 官方 hooks 包是否还在宿主里（0.2.1-rc.2 会移除，届时只有 shim 能兜）
    $hostDsh = Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness\resources\app\dsh\node_modules\@deepseek-ai'
    foreach ($pkg in @('dsh-hooks-claude-code', 'dsh-hooks-codex', 'dsh-hook-protocol')) {
        if (Test-Path (Join-Path $hostDsh $pkg)) { $report.OfficialPkgs++ }
    }

    $hooksCandidates = @(
        (Join-Path $TargetDir 'hooks.json'),
        (Join-Path $PluginsDir 'hooks.json'),
        (Join-Path $ProfileDir 'hooks.json'),
        (Join-Path $DshHome 'hooks.json')
    )
    foreach ($c in $hooksCandidates) { if (Test-Path $c) { $report.HooksJsonSeen = $true } }

    return [pscustomobject]$report
}

function Show-Status {
    param([pscustomobject] $Status)

    Write-Step "当前状态"
    Write-Host ("  插件已复制        : {0}" -f $(if ($Status.Installed) { 'yes' } else { 'no' }))
    Write-Host ("  cordis.patch 已插入: {0}" -f $(if ($Status.Inserted) { 'yes' } else { 'no' }))
    Write-Host ("  找到 hooks.json   : {0}" -f $(if ($Status.HooksJsonSeen) { 'yes' } else { 'no' }))
    Write-Host ("  宿主内建 hooks 包 : {0}/3" -f $Status.OfficialPkgs)

    if ($Status.OfficialPkgs -lt 3) {
        Write-Warn2 "宿主缺少官方 hooks 包 —— 这正是 shim 要兜的场景，shim 必须装好"
    }
    if ($Status.Installed -and -not $Status.HooksJsonSeen) {
        Write-Warn2 "shim 装了但没有 hooks.json：它此时不做任何事（等价于没装）"
    }
}

# ============================ 安装 ============================

function Install-Files {
    Write-Step "复制插件文件"

    if (-not (Test-Path $PluginsDir)) { New-Item -ItemType Directory -Path $PluginsDir -Force | Out-Null }

    if ((Test-Path $TargetDir) -and -not $Force) {
        # 存在但没在 patch yml 里 → 视为残留，允许覆盖
        $st = Get-HooksStatus
        if ($st.Inserted) {
            Write-Warn2 "$TargetDir 已存在且已注册，加 -Force 才覆盖"
            return $false
        }
    }

    if (Test-Path $TargetDir) { Remove-Item -Recurse -Force $TargetDir }

    # 复制运行时必需的目录：src（桥接器本体）/ rules（hook 脚本）/ test（自测）
    New-Item -ItemType Directory -Path $TargetDir -Force | Out-Null
    foreach ($d in @('src', 'rules', 'test')) {
        $from = Join-Path $SourceDir $d
        if (Test-Path $from) {
            Copy-Item -Recurse -Force $from (Join-Path $TargetDir $d)
        } else {
            Write-Warn2 "源目录缺少 $d，跳过"
        }
    }
    foreach ($f in @('cordis.patch.yml', 'package.json')) {
        Copy-Item -Force (Join-Path $SourceDir $f) (Join-Path $TargetDir $f)
    }
    # hooks.json 只在目标侧生成，源里没有；已存在就别覆盖用户写的规则
    if (Test-Path (Join-Path $TargetDir 'hooks.json')) {
        Write-Ok '保留已有的 hooks.json（不覆盖用户规则）'
    }

    Write-Ok "已复制到 $TargetDir"

    # 语法自检：不检查就装上，等于把宿主的 pre-execute 挂在坏代码上
    $node = Get-Command node -ErrorAction SilentlyContinue
    if ($node) {
        foreach ($rel in @('src\index.mjs', 'rules\gate-bridge.mjs')) {
            $full = Join-Path $TargetDir $rel
            if (-not (Test-Path $full)) { continue }
            $check = & $node.Source --check $full 2>&1
            if ($LASTEXITCODE -ne 0) {
                Write-Err2 "$rel 语法检查失败：$check"
                return $false
            }
            Write-Ok "node --check $rel 通过"
        }
    } else {
        Write-Warn2 '找不到 node，跳过语法检查'
    }

    return $true
}

function Add-PatchEntry {
    Write-Step "写入 cordis.patch.yml"

    $text = [System.IO.File]::ReadAllText($PatchYml)
    if ($text -match [regex]::Escape($PluginId)) {
        Write-Ok '已经存在 dsh-hooks-shim 条目，跳过'
        return $true
    }

    # 备份一次（只保留最近一份）
    $bak = "$PatchYml.bak-before-hooks-shim"
    Copy-Item -Force $PatchYml $bak
    Write-Ok "已备份到 $bak"

    # 追加到文件末尾。cordis.patch.yml 顶层是 YAML 序列，`- insert:` 直接跟在后面即可。
    $nl = if ($text.Contains("`r`n")) { "`r`n" } else { "`n" }
    if (-not $text.EndsWith($nl)) { $text += $nl }

    $block = @(
        "",
        "# dsh-hooks-shim —— 0.2.1-rc.2 移出内建 hooks 包后的兜底桥接",
        "# 只有 hooks.json 存在时才真的做事，不存在就静默不注册",
        "- insert:",
        "    - id: $PluginId",
        "      name: ./plugins/$PluginId/src/index.mjs",
        "      config: {}"
    ) -join $nl

    $text += $block + $nl

    # 原子写：先写临时文件再替换
    $tmp = "$PatchYml.tmp-$([guid]::NewGuid().ToString('N'))"
    [System.IO.File]::WriteAllText($tmp, $text, [System.Text.UTF8Encoding]::new($false))
    Move-Item -Force $tmp $PatchYml

    Write-Ok "已插入 insert 块 → $PatchYml"
    return $true
}

function Remove-Everything {
    Write-Step "卸载 dsh-hooks-shim"

    if (Test-Path $PatchYml) {
        $text = [System.IO.File]::ReadAllText($PatchYml)
        if ($text -match [regex]::Escape($PluginId)) {
            Copy-Item -Force $PatchYml "$PatchYml.bak-before-hooks-shim-remove"
            # 整块删除：从注释行到 config 行
            $pattern = "(?ms)^# dsh-hooks-shim.*?^\s+config:\s*\{\}\s*\r?\n"
            $new = [regex]::Replace($text, $pattern, '')
            if ($new -eq $text) {
                # 兜底：逐行剔除含插件 id 的三行组合
                $lines = $text -split "`r?`n"
                $kept = @()
                for ($i = 0; $i -lt $lines.Count; $i++) {
                    if ($lines[$i] -match "id:\s*$PluginId") {
                        # 跳过 id 行与紧随的 name/config 行，以及可能的 insert: 空壳
                        if ($i + 1 -lt $lines.Count -and $lines[$i + 1] -match 'name:\s*\./plugins/') { $i++ }
                        if ($i + 1 -lt $lines.Count -and $lines[$i + 1] -match '^\s+config:') { $i++ }
                        continue
                    }
                    $kept += $lines[$i]
                }
                $new = $kept -join "`r`n"
            }
            $tmp = "$PatchYml.tmp-$([guid]::NewGuid().ToString('N'))"
            [System.IO.File]::WriteAllText($tmp, $new, [System.Text.UTF8Encoding]::new($false))
            Move-Item -Force $tmp $PatchYml
            Write-Ok '已从 cordis.patch.yml 移除条目'
        } else {
            Write-Ok 'cordis.patch.yml 里本来就没有该条目'
        }
    }

    if (Test-Path $TargetDir) {
        Remove-Item -Recurse -Force $TargetDir
        Write-Ok "已删除 $TargetDir"
    }

    Write-Warn2 '需要重启 DSH 宿主才会生效'
    return $true
}

# ============================ 自测 ============================

function Invoke-SelfTest {
    Write-Step "运行 shim 自测"

    $node = Get-Command node -ErrorAction SilentlyContinue
    if (-not $node) { Write-Warn2 '找不到 node，跳过自测'; return $true }

    $testFile = Join-Path $SourceDir 'test\selftest.mjs'
    if (-not (Test-Path $testFile)) { Write-Warn2 '找不到 test\selftest.mjs，跳过'; return $true }

    # 在源目录跑（测试要用相对路径找到 ../src/index.mjs）
    Push-Location $SourceDir
    try {
        $out = & $node.Source 'test/selftest.mjs' 2>&1
        $code = $LASTEXITCODE
    } finally {
        Pop-Location
    }

    $summary = ($out | Select-String -Pattern 'passed, \d+ failed' | Select-Object -Last 1)
    if ($code -eq 0) {
        Write-Ok "自测通过：$summary"
    } else {
        Write-Err2 "自测失败：$summary"
        $out | Select-Object -Last 30 | ForEach-Object { Write-Host "    $_" }
    }
    return ($code -eq 0)
}

# ============================ 主流程 ============================

Write-Host ''
Write-Host '============================================' -ForegroundColor Magenta
Write-Host '  dsh-hooks-shim 安装器' -ForegroundColor Magenta
Write-Host '============================================' -ForegroundColor Magenta

if (-not (Test-Layout)) {
    Write-Err2 '布局检查未通过，终止'
    exit 1
}

$status = Get-HooksStatus
Show-Status $status

if ($VerifyOnly) {
    Write-Step '仅体检模式，不改动任何文件'
    exit 0
}

if ($Remove) {
    Remove-Everything | Out-Null
    exit 0
}

if (-not (Install-Files)) { Write-Err2 '复制失败，终止'; exit 1 }
if (-not (Add-PatchEntry)) { Write-Err2 '写配置失败，终止'; exit 1 }
if (-not (Invoke-SelfTest)) { Write-Err2 '自测未通过，请勿重启宿主'; exit 1 }

$status = Get-HooksStatus
Show-Status $status

Write-Host ''
Write-Step '完成。下一步：'
Write-Host '  1. 在 <profile>\plugins\dsh-hooks-shim\hooks.json 写你的 hook 规则'
Write-Host '     （没有这个文件时 shim 不做任何事）'
Write-Host '  2. 重启 DSH 宿主'
Write-Host '  3. 重启后看宿主日志里有没有：'
Write-Host '       dsh-hooks-shim: loaded N hook group(s) from ...'
Write-Host '       dsh-hooks-shim: armed on 7 extension points (...)'
Write-Host '  4. 确认审批卡还能弹：在 D 盘根目录建一个文件夹试试'
Write-Host ''
Write-Host '  卸载：.\install-hooks-shim.ps1 -Remove' -ForegroundColor DarkGray
Write-Host ''
