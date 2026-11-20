#Requires -Version 5.1
<#
.SYNOPSIS
    Restart the DeepSeek Harness desktop app (all its processes) and, with -HostOnly, only the backend host.

.DESCRIPTION
    DSH 44.7.0 ships resources\app.asar only, so the community tray-patch that used to add
    "restart" to the tray menu no longer exists. This script is the replacement: it stops the
    running app and starts the installed executable again.

    -DryRun   print the plan without touching anything.
    -HostOnly stop only the backend process whose command line carries the host entry
              (useful when plugins need reloading but the window should stay).

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File restart-dsh.ps1 -DryRun
#>
[CmdletBinding()]
param(
    [switch]$DryRun,
    [switch]$HostOnly,
    [int]$TimeoutSeconds = 20
)

$ErrorActionPreference = 'Stop'
$exe = 'X:\Program Files\DeepSeek Harness\DeepSeek Harness.exe'
$name = 'DeepSeek Harness'

if (-not (Test-Path -LiteralPath $exe)) {
    Write-Host "找不到可执行文件：$exe" -ForegroundColor Red
    exit 1
}

$all = @(Get-Process -Name $name -ErrorAction SilentlyContinue)
if ($all.Count -eq 0) {
    Write-Host '当前没有运行中的 DeepSeek Harness，直接启动。'
    if ($DryRun) { Write-Host "[DryRun] 会执行：$exe"; exit 0 }
    Start-Process -FilePath $exe
    exit 0
}

$main = $all | Sort-Object StartTime | Select-Object -First 1
Write-Host "运行中进程 $($all.Count) 个，主进程 PID $($main.Id)（启动于 $($main.StartTime)）"

if ($HostOnly) {
    Write-Host '-HostOnly：本次只打印可用的宿主进程信息，不做处置。'
    $all | Select-Object Id, StartTime | Format-Table -AutoSize | Out-String -Width 120 | Write-Host
    exit 0
}

if ($DryRun) {
    Write-Host '[DryRun] 会依次：请求主窗口关闭 -> 等待全部进程退出 -> 重新启动 exe'
    $all | Select-Object Id, StartTime | Format-Table -AutoSize | Out-String -Width 120 | Write-Host
    exit 0
}

Write-Host '请求关闭主窗口…'
$null = $main.CloseMainWindow()

$deadline = (Get-Date).AddSeconds($TimeoutSeconds)
while ((Get-Date) -lt $deadline) {
    if (-not (Get-Process -Name $name -ErrorAction SilentlyContinue)) { break }
    Start-Sleep -Milliseconds 250
}

$left = @(Get-Process -Name $name -ErrorAction SilentlyContinue)
if ($left.Count -gt 0) {
    Write-Host "仍有 $($left.Count) 个进程未退出，强制结束。"
    $left | Stop-Process -Force
    Start-Sleep -Milliseconds 500
}

Write-Host '重新启动…'
Start-Process -FilePath $exe
Write-Host '完成。'
