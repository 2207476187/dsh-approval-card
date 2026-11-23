<#
.SYNOPSIS
  验证 hooks-shim 的审批门不再把「文档正文里的路径」当成写目标。

.DESCRIPTION
  gate-bridge.mjs 早先把 write 的 content、edit 的 new_string 也拼进扫描文本，
  正文里出现盘符或前导斜杠的片段就会被判成「目标含工作区外路径」，
  而那次写的真实目标其实就在工作区内。

  本脚本跑四组正反用例，断言：
    1 写工作区内文件 + 正文引用外部路径   → 不拦（本次修复点）
    2 写工作区外文件（结构化目标越界）     → 拦
    3 执行命令读外部路径（命令里混着路径） → 拦
    4 写工作区内文件 + 正文无路径          → 不拦

  只读：不改任何文件，payload 仅经 stdin 传给 gate 子进程。

.EXAMPLE
  pwsh -File tools\verify-gate-path-scan.ps1
  pwsh -File tools\verify-gate-path-scan.ps1 -Gate <另一份 gate-bridge.mjs 路径>
#>
[CmdletBinding()]
param(
  [string]$Gate = (Join-Path $env:USERPROFILE '.dsh\profiles\desktop\plugins\dsh-hooks-shim\rules\gate-bridge.mjs')
)

$ErrorActionPreference = 'Stop'
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

if (-not (Test-Path -LiteralPath $Gate)) { Write-Error "找不到 gate: $Gate"; exit 3 }

$ws = Split-Path -Parent $PSScriptRoot
$outside = 'X:' + '\' + 'Program Files' + '\' + 'DeepSeek Harness'
$insidePath = Join-Path $ws '.build\probe-inside.txt'
$plainPath = Join-Path $ws '.build\probe-plain.txt'

function New-Payload([string]$tool, [hashtable]$fields) {
  # cwd 给工作区，isInside() 才有据可依
  return (@{ tool_name = $tool; cwd = $ws; tool_input = $fields } | ConvertTo-Json -Depth 6 -Compress)
}

$p1 = New-Payload 'write' @{
  file_path = $insidePath
  content   = "对比 $outside\app 与 /usr/local/bin 的做法；也看看 /etc/hosts。"
}
$p2 = New-Payload 'write' @{
  file_path = "$outside\outside-probe.txt"
  content   = 'hello'
}
$p3 = New-Payload 'pwsh' @{ command = "Get-Content '$outside\package.json'" }
$p4 = New-Payload 'write' @{
  file_path = $plainPath
  content   = '一段普通文字，没有任何路径。'
}

$cases = [System.Collections.ArrayList]::new()
[void]$cases.Add([pscustomobject]@{ Id = 1; Expect = 'none';         Want = '';             Name = '写工作区内文件，正文引用了外部路径'; Json = $p1 })
[void]$cases.Add([pscustomobject]@{ Id = 2; Expect = 'block-outside'; Want = 'outside-probe'; Name = '写工作区外文件';                   Json = $p2 })
[void]$cases.Add([pscustomobject]@{ Id = 3; Expect = 'block-outside'; Want = 'package.json';  Name = '执行命令读外部路径';               Json = $p3 })
[void]$cases.Add([pscustomobject]@{ Id = 4; Expect = 'none';         Want = '';             Name = '写工作区内文件，正文无路径';       Json = $p4 })

$fail = 0
foreach ($c in $cases) {
  $raw = $c.Json | node $Gate 2>$null
  $decision = 'none'
  $reason = ''
  if ($raw) {
    try {
      $h = ($raw | ConvertFrom-Json).hookSpecificOutput
      if ($h) { $decision = [string]$h.permissionDecision; $reason = [string]$h.permissionDecisionReason }
    } catch { $decision = 'unparseable'; $reason = [string]$raw }
  }

  $ok = $false
  if ($c.Expect -eq 'none') { $ok = ($decision -eq 'none') }
  elseif ($c.Expect -eq 'block-outside') { $ok = ($decision -ne 'none') -and ($reason -like "*$($c.Want)*") }
  if (-not $ok) { $fail++ }

  $mark = 'ok  '; if (-not $ok) { $mark = 'FAIL' }
  $shown = '不拦'; if ($decision -ne 'none') { $shown = "$decision — $reason" }
  Write-Host ("  {0}  case {1}: {2}" -f $mark, $c.Id, $c.Name)
  Write-Host ("        期望 {0} / 实得 {1}" -f $c.Expect, $shown)
}

Write-Host ''
if ($fail -eq 0) {
  Write-Host '================  4 passed, 0 failed  ================'
  exit 0
}
Write-Host ("================  4 例中 {0} 例失败  ================" -f $fail)
exit 1
