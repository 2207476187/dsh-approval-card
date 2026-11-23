# verify-gate-readonly.ps1 —— 验证审批门的 R0「只读放行」没有放开写操作
#
# 用法：
#   pwsh -File tools\verify-gate-readonly.ps1                      # 测当前 gate
#   pwsh -File tools\verify-gate-readonly.ps1 -Gate <另一份 .mjs>   # 做新旧对照
#
# 判读：gate 无 stdout = 放行（none）；输出 JSON 里 permissionDecision = ask/deny。
# 注意：备份文件（.bak-<stamp>-xxx）node 不认扩展名，要先用 Copy-Item 复制成 .mjs。

param(
    [string]$Gate = 'C:\Users\Administrator\.dsh\profiles\desktop\plugins\dsh-hooks-shim\rules\gate-bridge.mjs'
)

$ErrorActionPreference = 'Stop'
$workspace = 'D:\DeepSeek Harness工作目录\DeepSeek'

if (-not (Test-Path $Gate)) { throw "找不到 gate 文件：$Gate" }

function New-Payload {
    param([string]$Tool, [string]$Command)
    [pscustomobject]@{
        session_id       = 'verify'
        cwd              = $workspace
        hook_event_name  = 'PreToolUse'
        tool_name        = $Tool
        tool_input       = [pscustomobject]@{ command = $Command }
        tool_use_id      = 'verify'
    } | ConvertTo-Json -Depth 6 -Compress
}

function Invoke-Gate {
    param([string]$Payload)
    $out = $Payload | & node $Gate 2>$null
    if ([string]::IsNullOrWhiteSpace($out)) { return 'none' }
    try {
        $o = $out | ConvertFrom-Json
        $d = $o.hookSpecificOutput.permissionDecision
        if ([string]::IsNullOrWhiteSpace($d)) { return 'none' }
        return $d
    } catch {
        return "unparsed:$out"
    }
}

$host_ai = 'X:\Program Files\DeepSeek Harness\resources\app\dsh\node_modules\@deepseek-ai'
$dsh_home = 'C:\Users\Administrator\.dsh'

$cases = @(
    @{ name = '1 读宿主源码（应放行）'
       cmd  = "Get-Content '$host_ai\dsh-session\lib\index.js'"
       want = 'none' },
    @{ name = '2 搜宿主源码（应放行）'
       cmd  = "Select-String -Path '$host_ai\dsh-*\lib\*.js' -Pattern 'rewind'"
       want = 'none' },
    @{ name = '3 列目录 + 管道取前几条（应放行）'
       cmd  = "Get-ChildItem '$host_ai' -Directory | Select-Object -First 5"
       want = 'none' },
    @{ name = '4 算哈希（应放行）'
       cmd  = "Get-FileHash '$host_ai\dsh-session\lib\index.js' -Algorithm SHA256"
       want = 'none' },
    @{ name = '5 测路径（应放行）'
       cmd  = "Test-Path '$dsh_home\AGENTS.md'"
       want = 'none' },
    @{ name = '6 写宿主文件（应拦）'
       cmd  = "Set-Content '$host_ai\x.txt' 'hi'"
       want = 'ask' },
    @{ name = '7 读后管道写（应拦）'
       cmd  = "Get-Content '$host_ai\a.js' | Set-Content '$host_ai\b.js'"
       want = 'ask' },
    @{ name = '8 重定向写（应拦）'
       cmd  = "Get-Content '$host_ai\a.js' > '$host_ai\b.js'"
       want = 'ask' },
    @{ name = '9 删目录（应硬拒）'
       cmd  = "Remove-Item '$host_ai\sub' -Recurse"
       want = 'deny' },
    @{ name = '10 读凭据（应拦）'
       cmd  = "Get-Content '$dsh_home\.credentials.yaml'"
       want = 'ask' },
    @{ name = '11 网络外发（应拦）'
       cmd  = "Invoke-WebRequest https://example.com/x.txt"
       want = 'ask' },
    @{ name = '12 node 执行（gate 未拦——已知缺口）'
       cmd  = "node -e ""require('fs').rmSync('x')"""
       want = 'none' },
    @{ name = '13 读 + 删除串联（应拦）'
       cmd  = "Get-Content '$host_ai\a.js'; Remove-Item '$host_ai\b.js'"
       want = 'ask' },
    @{ name = '14 括号内嵌套写（应拦）'
       cmd  = "Get-Content (New-Item -Path '$host_ai\c.js' -Value 'x')"
       want = 'ask' },
    @{ name = '15 区内普通读取（应放行）'
       cmd  = "Get-Content '.build\devlog-append-55-72.md'"
       want = 'none' }
)

$pass = 0
$fail = 0
Write-Host "gate = $Gate`n"
foreach ($c in $cases) {
    $payload = New-Payload -Tool 'pwsh' -Command $c.cmd
    $got = Invoke-Gate -Payload $payload
    $ok = ($got -eq $c.want)
    if ($ok) { $pass++ } else { $fail++ }
    $mark = if ($ok) { 'PASS' } else { 'FAIL' }
    Write-Host ("{0}  {1,-28} 期望 {2,-4} 实际 {3}" -f $mark, $c.name, $c.want, $got)
    if (-not $ok) { Write-Host ("      命令: " + $c.cmd) }
}

Write-Host ""
Write-Host ("{0} passed, {1} failed" -f $pass, $fail)
if ($fail -gt 0) { exit 1 } else { exit 0 }
