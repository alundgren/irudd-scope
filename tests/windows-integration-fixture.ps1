param(
    [Parameter(Mandatory = $true)][string]$Integration,
    [Parameter(Mandatory = $true)][string]$Directory
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$root = Join-Path $Directory 'install'
$backup = Join-Path $Directory 'backup'
$programs = Join-Path $Directory 'programs'
$registryPath = 'Registry::HKEY_CURRENT_USER\Software\Classes\scope-transfer'
$commandPath = $registryPath + '\shell\open\command'
$registry = 'HKCU\Software\Classes\scope-transfer'
$ownedCommand = '"' + (Join-Path $root 'Scope.exe') + '" "%1"'
$global:fixtureRegistration = $null
$global:fixtureFailShortcut = $false
$global:fixtureFailExport = $false
$global:fixtureReplaceDuringFailure = $null
$global:fixtureRegistryCalls = @()

# Intercept all OS integration. Ordinary files, including the rollback snapshot,
# use PowerShell's real filesystem commands inside the temporary directory.
function Join-Path {
    param([AllowEmptyString()][string]$Path, [string]$ChildPath)
    if ($ChildPath -eq 'Scope.lnk' -and $Path -ne $backup) { $Path = $programs }
    Microsoft.PowerShell.Management\Join-Path $Path $ChildPath
}
function New-Item {
    param([AllowEmptyString()][string]$Path, [string]$ItemType, [switch]$Force)
    if ($Path.StartsWith('Registry::')) { throw "Unexpected registry creation: $Path" }
    if ($Path -eq [Environment]::GetFolderPath('Programs')) { $Path = $programs }
    Microsoft.PowerShell.Management\New-Item -Path $Path -ItemType $ItemType -Force:$Force
}
function Test-Path {
    param([string]$LiteralPath)
    if ($LiteralPath.StartsWith('Registry::')) {
        if ($LiteralPath -eq $registryPath) { return $null -ne $global:fixtureRegistration }
        if ($LiteralPath -eq $commandPath) { return $null -ne $global:fixtureRegistration -and $global:fixtureRegistration.ContainsKey('Command') }
        throw "Unexpected registry read: $LiteralPath"
    }
    Microsoft.PowerShell.Management\Test-Path -LiteralPath $LiteralPath
}
function Get-Item {
    param([string]$LiteralPath)
    if ($LiteralPath -ne $commandPath) { throw "Unexpected registry item: $LiteralPath" }
    $item = [pscustomobject]@{ Value = $global:fixtureRegistration.Command }
    $item | Add-Member -MemberType ScriptMethod -Name GetValue -Value { param($name) if ($name -ne '') { throw 'Unexpected value name' }; return $this.Value }
    return $item
}
function Remove-Item {
    param([string]$LiteralPath, [switch]$Recurse, [switch]$Force)
    if ($LiteralPath.StartsWith('Registry::')) {
        if ($LiteralPath -ne $registryPath) { throw "Unexpected registry deletion: $LiteralPath" }
        $global:fixtureRegistryCalls += 'delete'
        $global:fixtureRegistration = $null
        return
    }
    Microsoft.PowerShell.Management\Remove-Item -LiteralPath $LiteralPath -Recurse:$Recurse -Force:$Force
}
function reg.exe {
    $global:LASTEXITCODE = 0
    switch ($args[0]) {
        'export' {
            if ($args[1] -ne $registry -or $args[3] -ne '/y') { throw 'Unexpected registry export' }
            $global:fixtureRegistryCalls += 'export'
            if ($global:fixtureFailExport) { $global:LASTEXITCODE = 1; return }
            $global:fixtureRegistration | Export-Clixml -LiteralPath $args[2]
        }
        'import' {
            $global:fixtureRegistryCalls += 'import'
            $global:fixtureRegistration = Import-Clixml -LiteralPath $args[1]
        }
        default { throw 'Unexpected registry command' }
    }
}
function New-Object {
    param([string]$ComObject)
    if ($ComObject -ne 'WScript.Shell') { throw 'Unexpected COM object' }
    $shell = [pscustomobject]@{}
    $shell | Add-Member -MemberType ScriptMethod -Name CreateShortcut -Value { param($path) return [pscustomobject]@{ TargetPath = Join-Path $root 'Scope.exe' } }
    return $shell
}
function Start-Process {
    param($FilePath, $ArgumentList, $WindowStyle, [switch]$PassThru, [switch]$Wait)
    if ($FilePath -ne (Join-Path $root 'Scope.exe')) { throw 'Unexpected launcher' }
    Set-Content -LiteralPath (Join-Path $programs 'Scope.lnk') -Value 'New shortcut'
    if ($global:fixtureFailShortcut) {
        if ($global:fixtureReplaceDuringFailure) { $global:fixtureRegistration = $global:fixtureReplaceDuringFailure }
        throw 'Synthetic interrupted shortcut creation'
    }
    return [pscustomobject]@{ ExitCode = 0 }
}
function Assert-Equal($actual, $expected) {
    if ($expected -is [System.Collections.IDictionary]) {
        if ($actual -isnot [System.Collections.IDictionary] -or $actual.Count -ne $expected.Count) { throw 'Registry values differ' }
        foreach ($key in $expected.Keys) {
            if (-not $actual.Contains($key)) { throw "Missing registry value: $key" }
            Assert-Equal $actual[$key] $expected[$key]
        }
    } elseif ($expected -is [array]) {
        if ($actual -isnot [array] -or $actual.Count -ne $expected.Count) { throw 'Registry operations differ' }
        for ($i = 0; $i -lt $expected.Count; $i++) { Assert-Equal $actual[$i] $expected[$i] }
    } elseif ($actual -cne $expected) { throw "Unexpected fixture value: $actual" }
}
function Reset-Fixture($value) {
    Microsoft.PowerShell.Management\Remove-Item -LiteralPath $backup, $programs -Recurse -Force -ErrorAction SilentlyContinue
    Microsoft.PowerShell.Management\New-Item -ItemType Directory -Path $backup, $programs -Force | Out-Null
    $global:fixtureRegistration = $value
    $global:fixtureRegistryCalls = @()
    $global:fixtureFailShortcut = $false
    $global:fixtureFailExport = $false
    $global:fixtureReplaceDuringFailure = $null
}
function Invoke-Integration($action) {
    & $Integration -Root $root -Backup $backup -Action $action
}
function Expect-Failure($action, $message) {
    try { Invoke-Integration $action } catch {
        if ($_.Exception.Message -notlike "*$message*") { throw }
        return
    }
    throw "Expected $action failure"
}

$owned = @{ Command = $ownedCommand; Description = 'Previous protocol'; Values = @{ 'URL Protocol' = ''; Extra = 'Keep nested values' } }
$other = @{ Command = '"C:\Other Scope\Scope.exe" "%1"'; Description = 'Other installation' }
foreach ($preserved in @($null, $other, @{ Command = '"C:\Other App\app.exe" "%1"' }, @{ Description = 'No open command' }, @{ Command = $ownedCommand + ' --extra' })) {
    Reset-Fixture $preserved
    Invoke-Integration 'apply'
    Assert-Equal $global:fixtureRegistration $preserved
    Assert-Equal $global:fixtureRegistryCalls @()
    Invoke-Integration 'restore'
    Assert-Equal $global:fixtureRegistration $preserved
    Assert-Equal $global:fixtureRegistryCalls @()
}
foreach ($command in @($ownedCommand, $ownedCommand.ToUpperInvariant())) {
    Reset-Fixture (@{ Command = $command; Description = $owned.Description; Values = $owned.Values })
    $before = $global:fixtureRegistration
    Invoke-Integration 'apply'
    Assert-Equal $global:fixtureRegistration $null
    Assert-Equal $global:fixtureRegistryCalls @('export', 'delete')
    Invoke-Integration 'restore'
    Assert-Equal $global:fixtureRegistration $before
    Assert-Equal $global:fixtureRegistryCalls @('export', 'delete', 'import')
}
Reset-Fixture $owned
Set-Content -LiteralPath (Join-Path $programs 'Scope.lnk') -Value 'Previous shortcut'
$global:fixtureFailShortcut = $true
Expect-Failure 'apply' 'Synthetic interrupted'
Assert-Equal $global:fixtureRegistration $null
Invoke-Integration 'restore'
Assert-Equal $global:fixtureRegistration $owned
Assert-Equal (Get-Content -LiteralPath (Join-Path $programs 'Scope.lnk')) 'Previous shortcut'

Reset-Fixture $owned
$global:fixtureFailExport = $true
Expect-Failure 'apply' 'Could not back up'
Invoke-Integration 'restore'
Assert-Equal $global:fixtureRegistration $owned
Assert-Equal $global:fixtureRegistryCalls @('export')

Reset-Fixture $owned
$global:fixtureFailShortcut = $true
$global:fixtureReplaceDuringFailure = $other
Expect-Failure 'apply' 'Synthetic interrupted'
Expect-Failure 'restore' 'belongs to another installation'
Assert-Equal $global:fixtureRegistration $other
Assert-Equal $global:fixtureRegistryCalls @('export', 'delete')
if (-not (Microsoft.PowerShell.Management\Test-Path -LiteralPath (Join-Path $backup 'protocol.reg'))) { throw 'Rollback backup was lost' }
Write-Output 'Windows integration fixture passed: fresh, owned, unrelated, missing command, casing, interruption, export failure, rollback conflict.'
