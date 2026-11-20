<#
.SYNOPSIS
    Enumerate registered Appx/MSIX packages straight from the registry - no Appx module, no child process.

.DESCRIPTION
    Get-AppxPackage lives in a Windows PowerShell 5.1 module that PowerShell 7 cannot load (the
    WinRT surface it needs is not there). This reads the same registration data out of the
    AppModel repository key, so it runs in pwsh 7, in restricted contexts, and without spawning
    powershell.exe.

    What you get: PackageFullName, Name, Version, Architecture, InstallLocation, DisplayName,
    Scope, SupportedUsers, Staged.
    What you do not get (the registry does not store it): IsFramework, IsBundle, SignatureKind,
    Status, Dependencies, PackageUserInformation, NonRemovable, IsPartiallyStaged. For those,
    use: Import-Module Appx -UseWindowsPowerShell

    The registry view is a superset of what Get-AppxPackage lists: it also holds staged package
    updates (folder missing on disk - reported here as Staged = $true) and driver-style MSIX
    registrations the Appx API does not enumerate. Use -InstalledOnly to drop staged entries.

.PARAMETER Name
    Wildcard filter on the package name, e.g. 'Microsoft.PowerShell*'.

.PARAMETER AllUsers
    Also read the machine-wide repository (HKLM). Usually holds only a couple of inbox packages.

.PARAMETER InstalledOnly
    Skip entries whose install folder is missing on disk (staged / pending updates).

.PARAMETER Json
    Emit compact JSON instead of objects. Always an array, including for zero or one hit.

.PARAMETER Merge
    Collapse the x86/x64 rows of one package into a single row: Architectures becomes "x86,x64"
    and PackageFullName becomes a ';'-separated list. Off by default so one row still equals one
    registry key.

.EXAMPLE
    .\Get-AppxPackageFast.ps1 -Name 'Microsoft.PowerShell*' | Format-Table Name, Version, InstallLocation

.EXAMPLE
    .\Get-AppxPackageFast.ps1 -AllUsers -InstalledOnly | Measure-Object

.EXAMPLE
    .\Get-AppxPackageFast.ps1 -Name 'Microsoft.DesktopAppInstaller' -Json

.EXAMPLE
    .\Get-AppxPackageFast.ps1 -Merge | Format-Table Name, Version, Architectures -AutoSize

.NOTES
    Primary consumer is the coding agent (not a human at a prompt), so the defaults favour
    precision over brevity:
      * looking up one package / quoting a path or version  -> no -Merge (one row = one key)
      * counting, listing, or showing a clean table         -> -Merge (x86+x64 collapse)
    When showing raw rows, always render the Architecture column, otherwise x86/x64 pairs look
    like duplicates.

    Architecture is reported in the registry's lower-case form (x64) while Get-AppxPackage
    returns X64, so compare case-insensitively.

    InstallLocation is resolved, not raw: the registry's PackageRootFolder is redirected for some
    packages (Office VFS, streamed installs - e.g. aimgr points into Program Files\Microsoft
    Office\root\vfs\...), so the canonical WindowsApps\<PackageFullName> path is used when it
    exists, with the registry value kept as the fallback for inbox packages.

    Keep this help block above the requires statement: a requires line placed first stops
    Get-Help from parsing comment-based help in a script.
#>

#Requires -Version 5.1

[CmdletBinding()]
param(
    [string]$Name = '*',
    [switch]$AllUsers,
    [switch]$InstalledOnly,
    [switch]$Json,
    [switch]$Merge
)

$ErrorActionPreference = 'Stop'

# PackageFullName shapes seen in the wild:
#   Microsoft.PowerShell_7.6.9.0_x64__8wekyb3d8bbwe
#   1527c705-839a-4832-9118-54d4Bd6a0c89_10.0.19041.4239_neutral_neutral_cw5n1h2txyewy
# Format: <Name>_<Version>_<Arch>_<ResourceId>_<PublisherId>; the name itself may contain '_'.
$splitFullName = {
    param([string]$full)
    $parts = $full -split '_'
    $empty = [pscustomobject]@{ Name = $full; Version = $null; Architecture = $null }
    if ($parts.Count -lt 4) { return $empty }

    $verIndex = -1
    for ($i = 1; $i -lt $parts.Count; $i++) {
        if ($parts[$i] -match '^\d+\.\d+') { $verIndex = $i; break }
    }
    if ($verIndex -lt 1) { return $empty }

    [pscustomobject]@{
        Name         = ($parts[0..($verIndex - 1)] -join '_')
        Version      = $parts[$verIndex]
        Architecture = if ($verIndex + 1 -lt $parts.Count) { $parts[$verIndex + 1] } else { $null }
    }
}

$repositorySubKey = 'Software\Classes\Local Settings\Software\Microsoft\Windows\CurrentVersion\AppModel\Repository\Packages'
$windowsApps = Join-Path $env:ProgramFiles 'WindowsApps'
$hives = @(@{ Hive = [Microsoft.Win32.Registry]::CurrentUser; Scope = 'User' })
if ($AllUsers) {
    $hives += @{ Hive = [Microsoft.Win32.Registry]::LocalMachine; Scope = 'Machine' }
}

$results = New-Object System.Collections.Generic.List[object]
foreach ($h in $hives) {
    $base = $h.Hive.OpenSubKey($repositorySubKey)
    if ($null -eq $base) { continue }
    try {
        foreach ($keyName in $base.GetSubKeyNames()) {
            $sub = $base.OpenSubKey($keyName)
            if ($null -eq $sub) { continue }
            try {
                $location = $sub.GetValue('PackageRootFolder')
                $display = $sub.GetValue('DisplayName')
                $users = $sub.GetValue('SupportedUsers')
            } finally {
                $sub.Dispose()
            }

            $info = & $splitFullName $keyName
            if ($display -is [string] -and $display.StartsWith('@{')) { $display = $null }   # ms-resource: reference, not resolved here

            # PackageRootFolder can be redirected (Office VFS, streamed installs): the canonical
            # location Get-AppxPackage reports is always WindowsApps\<PackageFullName>. Prefer that
            # when it exists; fall back to the registry value for inbox packages (ImmersiveControlPanel
            # and friends live under C:\Windows).
            $resolved = $location
            if (-not ($location -and $location.StartsWith($windowsApps, [StringComparison]::OrdinalIgnoreCase))) {
                $candidate = Join-Path $windowsApps $keyName
                if ([System.IO.Directory]::Exists($candidate)) { $resolved = $candidate }
            }
            $staged = -not ($resolved -and [System.IO.Directory]::Exists($resolved))

            $results.Add([pscustomobject]@{
                Name            = $info.Name
                Version         = $info.Version
                Architecture    = $info.Architecture
                PackageFullName = $keyName
                InstallLocation = $resolved
                DisplayName     = $display
                Scope           = $h.Scope
                SupportedUsers  = $users
                Staged          = $staged
            })
        }
    } finally {
        $base.Dispose()
    }
}

$selected = $results | Where-Object { $_.Name -like $Name }
if ($InstalledOnly) { $selected = $selected | Where-Object { -not $_.Staged } }

if ($Merge) {
    # One row per (Name, Version): x86 + x64 become a single package with Architectures = "x86,x64".
    $selected = $selected | Group-Object -Property { '{0}|{1}' -f $_.Name, $_.Version } | ForEach-Object {
        $rows = @($_.Group)
        $arch = @($rows | ForEach-Object { $_.Architecture } | Where-Object { $_ } | Sort-Object -Unique)
        $scope = @($rows | ForEach-Object { $_.Scope } | Sort-Object -Unique)
        $most = ($rows | ForEach-Object { $_.SupportedUsers } | Where-Object { $null -ne $_ } | Measure-Object -Maximum).Maximum
        $first = $rows[0]
        [pscustomobject]@{
            Name            = $first.Name
            Version         = $first.Version
            Architectures   = ($arch -join ',')
            PackageFullName = (@($rows | ForEach-Object { $_.PackageFullName }) -join ';')
            InstallLocation = (@($rows | ForEach-Object { $_.InstallLocation } | Where-Object { $_ }) | Select-Object -First 1)
            DisplayName     = (@($rows | ForEach-Object { $_.DisplayName } | Where-Object { $_ }) | Select-Object -First 1)
            Scope           = ($scope -join ',')
            SupportedUsers  = if ($null -ne $most) { [int]$most } else { $null }
            Staged          = @($rows | Where-Object { -not $_.Staged }).Count -eq 0
        }
    }
}

# [version] ordering, so 7.6.9.0 < 10.0.19041.4239 (a plain string sort gets this backwards).
$selected = $selected | Sort-Object `
    @{ Expression = { $_.Name } }, `
    @{ Expression = { try { [version]$_.Version } catch { [version]'0.0' } } }, `
    @{ Expression = { $_.Scope } }

if ($Json) {
    # Always an array: ConvertTo-Json unwraps a single-element pipeline, which would give callers
    # an object for one hit and an array for many. -InputObject keeps the shape stable, and an
    # empty result still serialises as [] so downstream ConvertFrom-Json never sees bare nothing.
    ConvertTo-Json -InputObject @($selected) -Compress -Depth 3
} else {
    $selected
}
