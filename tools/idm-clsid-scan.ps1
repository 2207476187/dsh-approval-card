#!/usr/bin/env pwsh
# Read-only scan: locate the CLSID registry keys IDM uses to store trial state.
# Heuristics copied from IAS (WindowsAddict / cyberhavik). Makes NO changes.
#
# Usage: powershell -File tools\idm-clsid-scan.ps1 [-Json]

[CmdletBinding()]
param([switch]$Json)

$ErrorActionPreference = 'SilentlyContinue'

$paths = @(
  'HKCU:\Software\Classes\CLSID',
  'HKCU:\Software\Classes\WOW6432Node\CLSID'
)

$exclude = @('LocalServer32', 'InProcServer32', 'InProcHandler32')
$found = New-Object System.Collections.Generic.List[object]

foreach ($root in $paths) {
  if (-not (Test-Path $root)) { continue }
  foreach ($key in (Get-ChildItem -Path $root -ErrorAction SilentlyContinue)) {
    if ($key.PSChildName -notmatch '^\{[A-F0-9]{8}-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{12}\}$') { continue }
    $subs = @($key.GetSubKeyNames())
    $blocked = @($subs | Where-Object { $exclude -contains $_ })
    if ($blocked.Count -gt 0) { continue }

    $reason = $null
    $vals = Get-ItemProperty -Path $key.PSPath -ErrorAction SilentlyContinue
    $default = $null
    $valueNames = @()
    if ($vals) {
      $defaultProp = $vals.PSObject.Properties | Where-Object { $_.Name -eq '(default)' }
      if ($defaultProp) { $default = [string]$defaultProp.Value }
      $valueNames = @($vals.PSObject.Properties.Name | Where-Object { $_ -notin @('PSPath','PSParentPath','PSChildName','PSDrive','PSProvider') })
    }

    if ($default -match '^\d+$' -and $key.SubKeyCount -eq 0) {
      $reason = 'default value is numeric, no subkeys'
    }
    elseif ($default -match '[+=]' -and $key.SubKeyCount -eq 0) {
      $reason = 'default value contains + or =, no subkeys'
    }
    else {
      $verProp = Get-ItemProperty -Path "$($key.PSPath)\Version" -ErrorAction SilentlyContinue
      $ver = $null
      if ($verProp) { $ver = [string]$verProp.'(default)' }
      $stateVals = @($valueNames | Where-Object { $_ -match 'MData|Model|scansk|Therad' })
      if ($ver -match '^\d+$' -and $key.SubKeyCount -eq 1) {
        $reason = 'numeric \Version and only that subkey'
      }
      elseif ($stateVals.Count -gt 0) {
        $reason = "state values: $($stateVals -join ',')"
      }
      elseif ($key.ValueCount -eq 0 -and $key.SubKeyCount -eq 0) {
        $reason = 'empty key'
      }
    }

    if ($reason) {
      $found.Add([pscustomobject]@{
        Root        = $root
        Guid        = $key.PSChildName
        Reason      = $reason
        Values      = ($valueNames -join ',')
        Default     = $default
        SubKeyCount = $key.SubKeyCount
      })
    }
  }
}

if ($Json) {
  $found | ConvertTo-Json -Depth 4
  return
}

Write-Host "Scanning HKCU CLSID keys (read-only, nothing modified)"
Write-Host "Candidates: $($found.Count)"
if ($found.Count -eq 0) { Write-Host '  (none matched)'; return }
foreach ($f in $found) {
  Write-Host ''
  Write-Host "  $($f.Guid)"
  Write-Host "    at     : $($f.Root)"
  Write-Host "    why    : $($f.Reason)"
  Write-Host "    values : $($f.Values)"
  Write-Host "    default: $($f.Default)"
}
