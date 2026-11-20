#Requires -Version 5.1
<#
.SYNOPSIS
    包装器：调用移植脚本（真实脚本在含中文的路径下，.cmd 用 ASCII 写会把这路径写坏）。
.DESCRIPTION
    bin\port-menu-restart.cmd 只做一件事：用 ASCII 路径找到本文件并运行。
    本文件是 UTF-8 BOM，中文路径在里面安全。
    注意：不能用数组 splat 转发开关（字符串 '-DryRun' 会被当成位置参数喂给 -TimeoutSeconds），
    所以下面按组合显式写分支。
#>
[CmdletBinding()]
param([switch]$Rollback, [switch]$DryRun, [switch]$SkipStop, [int]$TimeoutSeconds = 20)

$ErrorActionPreference = 'Stop'
$target = 'D:\DeepSeek Harness工作目录\WorkBuddy AI\02_菜单重启按钮\port-menu-restart.ps1'

if (-not (Test-Path -LiteralPath $target)) {
    Write-Host "找不到移植脚本：$target" -ForegroundColor Red
    exit 1
}

$common = @{}
if ($SkipStop) { $common['SkipStop'] = $true }
if ($PSBoundParameters.ContainsKey('TimeoutSeconds')) { $common['TimeoutSeconds'] = $TimeoutSeconds }

if ($Rollback -and $DryRun) {
    & $target -Rollback -DryRun @common
} elseif ($Rollback) {
    & $target -Rollback @common
} elseif ($DryRun) {
    & $target -DryRun @common
} else {
    & $target @common
}
