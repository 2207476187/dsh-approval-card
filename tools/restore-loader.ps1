<#
.SYNOPSIS
  把关卡住的桌面外壳加载器还原回可用状态，并重新启动 DeepSeek Harness。

.DESCRIPTION
  用途：给 resources\app\lib\main.js 打过补丁（dsh-purge、菜单重启按钮等）之后，
  客户端起不来 / 白屏 / 双击没反应时，用本脚本一键恢复。

  还原顺序（都失败才继续往下）：
    1. 最新的 main.js.bak-*-before-purge      —— 打过补丁前的加载器（首选，保留菜单重启）
    2. 最新的 main.js.bak-*-before-menu-restart —— 官方单体 main.js（按钮没了，但能启动）
    3. 现成的 main.official.js                —— 同上，官方单体

  还原完会自动启动客户端。全程只读判断 + 覆盖 main.js，不动其它文件。

.PARAMETER AppDir
  安装目录。默认按 X: -> C: -> D: 顺序找含有 resources\app\lib 的
  "DeepSeek Harness" / "DeepseekHarness" 目录。

.PARAMETER NoLaunch
  只还原，不启动客户端。

.PARAMETER DryRun
  只报告会选哪个备份、做哪些动作，不落盘。

.EXAMPLE
  .\restore-loader.ps1
.EXAMPLE
  .\restore-loader.ps1 -DryRun
#>
#Requires -Version 5.1
[CmdletBinding()]
param(
    [string]$AppDir,
    [switch]$NoLaunch,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$ExeName = 'DeepSeek Harness.exe'

function Write-Step([string]$Text) { Write-Host ("[restore-loader] " + $Text) }

function Find-DesktopRoot {
    $candidates = @()
    foreach ($drive in @('X:', 'C:', 'D:')) {
        foreach ($name in @('DeepSeek Harness', 'DeepseekHarness')) {
            $candidates += (Join-Path $drive ("Program Files\$name"))
            $candidates += (Join-Path $drive ("Program Files (x86)\$name"))
        }
    }
    foreach ($c in $candidates) {
        if (Test-Path (Join-Path $c 'resources\app\lib')) { return $c }
    }
    return $null
}

function Stop-Desktop {
    $procs = @(Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue)
    if ($procs.Count -eq 0) { Write-Step '客户端没在运行'; return }
    $main = $procs | Sort-Object StartTime | Select-Object -First 1
    Write-Step ("停止客户端（" + $procs.Count + " 个进程，主进程 PID " + $main.Id + '）')
    try { $null = $main.CloseMainWindow() } catch { }
    for ($i = 0; $i -lt 20; $i++) {
        Start-Sleep -Milliseconds 400
        if (-not (Get-Process -Id $main.Id -ErrorAction SilentlyContinue)) { break }
    }
    Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue | ForEach-Object {
        try { $_.Kill() } catch { }
    }
    Start-Sleep -Milliseconds 800
}

function Newest-File([string]$Dir, [string]$Pattern) {
    $items = @(Get-ChildItem -LiteralPath $Dir -Filter $Pattern -File -ErrorAction SilentlyContinue)
    if ($items.Count -eq 0) { return $null }
    return ($items | Sort-Object LastWriteTime -Descending | Select-Object -First 1)
}

if (-not $AppDir) { $AppDir = Find-DesktopRoot }
if (-not $AppDir) {
    Write-Host '[restore-loader] 没找到安装目录，请用 -AppDir 指定，例如：'
    Write-Host '  .\restore-loader.ps1 -AppDir "X:\Program Files\DeepSeek Harness"'
    exit 2
}

$resourcesApp = Join-Path $AppDir 'resources\app'
$libDir = Join-Path $resourcesApp 'lib'
$mainJs = Join-Path $libDir 'main.js'
$exe = Join-Path $AppDir $ExeName

Write-Step ("安装目录: " + $AppDir)
if (-not (Test-Path -LiteralPath $mainJs)) {
    Write-Step '这个目录里没有 lib\main.js，先确认是不是官方桌面版安装目录'
    exit 2
}

$pick = $null
$pickKind = ''
$loaderBak = Newest-File $libDir 'main.js.bak-*-before-purge'
$menuBak = Newest-File $libDir 'main.js.bak-*-before-menu-restart'
$official = Join-Path $libDir 'main.official.js'

if ($loaderBak) { $pick = $loaderBak.FullName; $pickKind = '打过补丁前的加载器（保留菜单重启）' }
elseif ($menuBak) { $pick = $menuBak.FullName; $pickKind = '官方单体 main.js（菜单重启按钮会消失，但能启动）' }
elseif (Test-Path -LiteralPath $official) { $pick = $official; $pickKind = 'main.official.js（官方单体）' }

if (-not $pick) {
    Write-Step '一个可用备份都没找到（main.js.bak-*、main.official.js 都不存在）'
    exit 2
}

$curLen = (Get-Item -LiteralPath $mainJs).Length
$pickLen = (Get-Item -LiteralPath $pick).Length
Write-Step ("当前 main.js: " + $curLen + ' 字节')
Write-Step ("将用备份     : " + $pick)
Write-Step ("备份说明     : " + $pickKind + "（" + $pickLen + ' 字节）')

if ($DryRun) {
    Write-Step 'DryRun：不做任何改动'
    exit 0
}

Stop-Desktop

Copy-Item -LiteralPath $pick -Destination $mainJs -Force
$after = (Get-Item -LiteralPath $mainJs).Length
Write-Step ("已还原 main.js: " + $after + ' 字节')

if ($NoLaunch) {
    Write-Step '按 -NoLaunch 要求不启动客户端'
    exit 0
}

if (-not (Test-Path -LiteralPath $exe)) {
    Write-Step ('找不到可执行文件: ' + $exe)
    exit 2
}

Start-Process -FilePath $exe
Write-Step '已尝试启动客户端，看下窗口有没有起来'
exit 0
