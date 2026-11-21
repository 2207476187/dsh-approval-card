#Requires -Version 5.1
<#
.SYNOPSIS
    从机器级 PATH 里删掉 Python 3.13 的条目，让 python 落到用户级的 3.14。

.DESCRIPTION
    Windows 拼接 PATH 是「机器级在前、用户级在后」，所以机器级里的
    D:\Program Files\Python313 会盖住用户级已经排在前面的 3.14。
    本脚本只改 HKLM 的 Path 这一个值：
      - 备份到一个文本文件，并打印还原命令
      - 删掉指向 Python313 的所有条目（含重复项）
      - 保持原值类型（REG_EXPAND_SZ）写回
      - 广播 WM_SETTINGCHANGE，新开的终端立刻生效
    不动任何文件、不卸载 Python 3.13（py -3.13 仍可用）。

.PARAMETER DryRun
    只打印将要发生的变更，不写注册表。

.PARAMETER Restore
    从最近的备份还原机器级 PATH。

.NOTES
    必须以管理员身份运行（写 HKLM）。脚本自身会检查并自提权。
#>
[CmdletBinding()]
param(
    [switch]$DryRun,
    [switch]$Restore
)

$ErrorActionPreference = 'Stop'
$key = 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager\Environment'
$valueName = 'Path'
$pattern = 'Python313'

function Test-Admin {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    return (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

if (-not (Test-Admin)) {
    $args2 = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-NoExit', '-File', "`"$PSCommandPath`"")
    if ($DryRun) { $args2 += '-DryRun' }
    if ($Restore) { $args2 += '-Restore' }
    Write-Host '需要管理员权限，正在申请提权（请在 UAC 窗口点「是」）…' -ForegroundColor Yellow
    Start-Process -FilePath 'powershell.exe' -ArgumentList $args2 -Verb RunAs | Out-Null
    return
}

$backupDir = Join-Path $env:LOCALAPPDATA 'path-backups'
New-Item -ItemType Directory -Force -Path $backupDir | Out-Null

function Get-MachinePath {
    return [Microsoft.Win32.Registry]::GetValue('HKEY_LOCAL_MACHINE\SYSTEM\CurrentControlSet\Control\Session Manager\Environment', 'Path', '')
}

function Set-MachinePath([string]$value) {
    $rk = [Microsoft.Win32.Registry]::LocalMachine.OpenSubKey('SYSTEM\CurrentControlSet\Control\Session Manager\Environment', $true)
    try {
        $rk.SetValue('Path', $value, [Microsoft.Win32.RegistryValueKind]::ExpandString)
    } finally {
        $rk.Close()
    }
    # 广播，让新进程看到新值
    if (-not ('PathBroadcast' -as [type])) {
        Add-Type -Namespace Win32 -Name NativeMethods -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("user32.dll", SetLastError = true, CharSet = System.Runtime.InteropServices.CharSet.Auto)]
public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);
'@
    }
    $result = [UIntPtr]::Zero
    [void][Win32.NativeMethods]::SendMessageTimeout([IntPtr]0xffff, 0x1A, [UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$result)
}

if ($Restore) {
    $latest = Get-ChildItem $backupDir -Filter 'machine-path-*.txt' | Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if (-not $latest) { throw "没有找到备份文件（目录：$backupDir）" }
    $saved = (Get-Content $latest.FullName -Raw).TrimEnd("`r", "`n")
    Write-Host "从备份还原：$($latest.FullName)" -ForegroundColor Cyan
    if ($DryRun) {
        Write-Host '[DryRun] 将写入：' -ForegroundColor Yellow
        Write-Host $saved
        return
    }
    Set-MachinePath $saved
    Write-Host '已还原。' -ForegroundColor Green
    return
}

$current = Get-MachinePath
if ([string]::IsNullOrWhiteSpace($current)) { throw '读到的机器级 PATH 是空的，终止（不做任何修改）' }

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backupFile = Join-Path $backupDir "machine-path-$stamp.txt"
[System.IO.File]::WriteAllText($backupFile, $current, (New-Object System.Text.UTF8Encoding($false)))

$items = @($current -split ';' | Where-Object { $_ -ne '' })
$drop = @($items | Where-Object { $_ -match $pattern })
$keep = @($items | Where-Object { $_ -notmatch $pattern })
$new = ($keep -join ';')

Write-Host "备份：$backupFile" -ForegroundColor Cyan
Write-Host ''
Write-Host "将删除 $($drop.Count) 条：" -ForegroundColor Yellow
$drop | ForEach-Object { Write-Host "  - $_" }
Write-Host ''
Write-Host "保留 $($keep.Count) 条，新 PATH 前 3 项：" -ForegroundColor Cyan
$keep | Select-Object -First 3 | ForEach-Object { Write-Host "  $_" }

if ($DryRun) {
    Write-Host ''
    Write-Host '[DryRun] 未写注册表。' -ForegroundColor Yellow
    return
}

Set-MachinePath $new
Write-Host ''
Write-Host '已写入机器级 PATH。' -ForegroundColor Green
Write-Host "还原命令：powershell -NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`" -Restore" -ForegroundColor DarkGray
Write-Host '新开的终端会看到变化；当前已打开的窗口需要重开。'
