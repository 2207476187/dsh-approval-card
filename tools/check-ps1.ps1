#Requires -Version 5.1
<#
.SYNOPSIS
    Guard against the "UTF-8 without BOM + Windows PowerShell 5.1" failure.

.DESCRIPTION
    Windows PowerShell 5.1 reads .ps1 files as ANSI when there is no BOM.
    Any non-ASCII character (Chinese comments, em dashes, curly quotes) then
    turns into mojibake, the parser loses track of quotes and braces, and you
    get a pile of "unexpected token" errors that never appear under pwsh 7.

    This script fails loudly instead of silently shipping such a file.

.PARAMETER Path
    One .ps1/.psm1 file, or a directory that is searched recursively.

.PARAMETER SkipParse
    Only check encoding, do not invoke powershell.exe for a real parse.

.EXAMPLE
    .\check-ps1.ps1 -Path .\idm-trial-reset.ps1

.EXAMPLE
    .\check-ps1.ps1 -Path D:\scripts -SkipParse
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$Path,
    [switch]$SkipParse
)

$ErrorActionPreference = 'Stop'
$ps51 = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$problems = New-Object System.Collections.Generic.List[string]

function Test-OneFile([string]$file) {
    $bytes = [System.IO.File]::ReadAllBytes($file)
    $hasBom = ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF)
    $hasUtf16Bom = ($bytes.Length -ge 2 -and (($bytes[0] -eq 0xFF -and $bytes[1] -eq 0xFE) -or ($bytes[0] -eq 0xFE -and $bytes[1] -eq 0xFF)))
    $hasNonAscii = $false
    foreach ($b in $bytes) { if ($b -gt 0x7F) { $hasNonAscii = $true; break } }

    $encoding = if ($hasUtf16Bom) { 'UTF-16 (BOM)' } elseif ($hasBom) { 'UTF-8 (BOM)' } elseif ($hasNonAscii) { 'UTF-8 (no BOM) + non-ASCII' } else { 'ASCII-only' }

    if ($hasNonAscii -and -not ($hasBom -or $hasUtf16Bom)) {
        $problems.Add("$file | $encoding | FAIL: 5.1 will decode this as ANSI and choke. Re-save as UTF-8 with BOM.")
        return
    }

    if (-not $SkipParse -and (Test-Path -LiteralPath $ps51)) {
        $out = & $ps51 -NoProfile -Command @"
try { `$null = [ScriptBlock]::Create([System.IO.File]::ReadAllText('$file')); 'PARSE-OK' } catch { 'PARSE-FAIL: ' + `$_.Exception.Message }
"@ 2>&1
        $text = ($out | Out-String)
        if ($text -notmatch 'PARSE-OK') {
            $first = ($text -split "`n" | Where-Object { $_.Trim() } | Select-Object -First 1)
            $problems.Add("$file | $encoding | FAIL: 5.1 parse -> $($first.Trim())")
            return
        }
    }

    Write-Host ("OK   {0}  [{1}]" -f (Split-Path $file -Leaf), $encoding) -ForegroundColor Green
}

if (Test-Path -LiteralPath $Path -PathType Leaf) {
    Test-OneFile $Path
} else {
    Get-ChildItem -LiteralPath $Path -Recurse -File -Include '*.ps1', '*.psm1' -ErrorAction Stop |
        ForEach-Object { Test-OneFile $_.FullName }
}

Write-Host ''
if ($problems.Count -gt 0) {
    Write-Host "FAILED: $($problems.Count) file(s)" -ForegroundColor Red
    $problems | ForEach-Object { Write-Host "  $_" -ForegroundColor Red }
    exit 1
}
Write-Host 'All checked files are safe for Windows PowerShell 5.1.' -ForegroundColor Green
exit 0
