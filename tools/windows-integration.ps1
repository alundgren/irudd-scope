param(
    [Parameter(Mandatory = $true)][string]$Root,
    [Parameter(Mandatory = $true)][string]$Backup,
    [Parameter(Mandatory = $true)][ValidateSet('apply', 'restore')][string]$Action
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$launcher = Join-Path $Root 'Scope.exe'
$shortcutDirectory = [Environment]::GetFolderPath('Programs')
$shortcut = Join-Path $shortcutDirectory 'Scope.lnk'
$checkpoint = Join-Path $Backup 'previous.clixml'
$registry = 'HKCU\Software\Classes\scope-transfer'
$registryPath = 'Registry::HKEY_CURRENT_USER\Software\Classes\scope-transfer'
$commandPath = $registryPath + '\shell\open\command'
$command = '"' + $launcher + '" "%1"'

function Test-OwnedProtocol {
    return (Test-Path -LiteralPath $commandPath) -and ((Get-Item -LiteralPath $commandPath).GetValue('') -eq $command)
}

if ($Action -eq 'restore') {
    if (-not (Test-Path -LiteralPath $checkpoint)) { return }
    $previous = Import-Clixml -LiteralPath $checkpoint
    $errors = @()
    if ($previous.Registry) {
        try {
            if ((Test-Path -LiteralPath $registryPath) -and -not (Test-OwnedProtocol)) {
                throw 'The retired URL registration now belongs to another installation; it was left untouched.'
            }
            & reg.exe import (Join-Path $Backup 'protocol.reg') | Out-Null
            if ($LASTEXITCODE -ne 0) { throw 'Could not restore the previous URL registration.' }
        } catch { $errors += $_.Exception.Message }
    }
    try {
        if ($previous.Shortcut) { Copy-Item -LiteralPath (Join-Path $Backup 'Scope.lnk') -Destination $shortcut -Force }
        elseif (Test-Path -LiteralPath $shortcut) { Remove-Item -LiteralPath $shortcut -Force }
    } catch { $errors += $_.Exception.Message }
    if ($errors.Count) { throw (($errors -join '; ') + '. Backups remain at ' + $Backup) }
    return
}

$hadShortcut = Test-Path -LiteralPath $shortcut
if ($hadShortcut) {
    $shell = New-Object -ComObject WScript.Shell
    if ($shell.CreateShortcut($shortcut).TargetPath -ne $launcher) { throw "$shortcut belongs to another application. Move it aside and retry." }
    Copy-Item -LiteralPath $shortcut -Destination (Join-Path $Backup 'Scope.lnk')
}
# Only the exact command written by this installation grants ownership.
$ownedProtocol = Test-OwnedProtocol
if ($ownedProtocol) {
    & reg.exe export $registry (Join-Path $Backup 'protocol.reg') /y | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Could not back up the retired URL registration.' }
}
# The caller can restore this snapshot even if this process is interrupted.
@{ Shortcut = $hadShortcut; Registry = $ownedProtocol } | Export-Clixml -LiteralPath $checkpoint
if ($ownedProtocol) { Remove-Item -LiteralPath $registryPath -Recurse -Force }
New-Item -ItemType Directory -Force -Path $shortcutDirectory | Out-Null
$process = Start-Process -FilePath $launcher -ArgumentList ('--scope-shortcut "' + $shortcut + '"') -WindowStyle Hidden -PassThru -Wait
if ($process.ExitCode -ne 0) { throw 'Could not create the Scope Start menu shortcut.' }
