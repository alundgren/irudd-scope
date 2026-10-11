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
$registry = 'HKCU\Software\Classes\scope-transfer'
$registryPath = 'Registry::HKEY_CURRENT_USER\Software\Classes\scope-transfer'
$command = '"' + $launcher + '" "%1"'
$checkpoint = Join-Path $Backup 'previous.clixml'

if ($Action -eq 'restore') {
    if (-not (Test-Path -LiteralPath $checkpoint)) { return }
    $previous = Import-Clixml -LiteralPath $checkpoint
    $errors = @()
    try {
        if (Test-Path -LiteralPath $registryPath) { Remove-Item -LiteralPath $registryPath -Recurse -Force }
        if ($previous.Registry) {
            & reg.exe import (Join-Path $Backup 'protocol.reg') | Out-Null
            if ($LASTEXITCODE -ne 0) { throw 'Could not restore the protocol registration.' }
        }
    } catch { $errors += $_.Exception.Message }
    try {
        if ($previous.Shortcut) { Copy-Item -LiteralPath (Join-Path $Backup 'Scope.lnk') -Destination $shortcut -Force }
        elseif (Test-Path -LiteralPath $shortcut) { Remove-Item -LiteralPath $shortcut -Force }
    } catch { $errors += $_.Exception.Message }
    if ($errors.Count) { throw (($errors -join '; ') + '. Backups remain at ' + $Backup) }
    return
}

$hadRegistry = Test-Path -LiteralPath $registryPath
$hadShortcut = Test-Path -LiteralPath $shortcut
if ($hadRegistry) {
    $existing = (Get-Item -LiteralPath ($registryPath + '\shell\open\command')).GetValue('')
    if ($existing -ne $command) { throw 'The scope-transfer protocol belongs to another installation. Remove that registration before installing Scope here.' }
    & reg.exe export $registry (Join-Path $Backup 'protocol.reg') /y | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Could not back up the Scope protocol registration.' }
}
if ($hadShortcut) {
    $shell = New-Object -ComObject WScript.Shell
    if ($shell.CreateShortcut($shortcut).TargetPath -ne $launcher) { throw "$shortcut belongs to another application. Move it aside and retry." }
    Copy-Item -LiteralPath $shortcut -Destination (Join-Path $Backup 'Scope.lnk')
}
# The caller can restore this snapshot even if this process is interrupted.
@{ Registry = $hadRegistry; Shortcut = $hadShortcut } | Export-Clixml -LiteralPath $checkpoint
New-Item -ItemType Directory -Force -Path $shortcutDirectory | Out-Null
$process = Start-Process -FilePath $launcher -ArgumentList ('--scope-shortcut "' + $shortcut + '"') -WindowStyle Hidden -PassThru -Wait
if ($process.ExitCode -ne 0) { throw 'Could not create the Scope Start menu shortcut.' }
New-Item -Path $registryPath -Force | Out-Null
Set-Item -LiteralPath $registryPath -Value 'URL:Scope transfer'
New-ItemProperty -LiteralPath $registryPath -Name 'URL Protocol' -Value '' -PropertyType String -Force | Out-Null
New-Item -Path ($registryPath + '\DefaultIcon') -Force | Out-Null
Set-Item -LiteralPath ($registryPath + '\DefaultIcon') -Value ('"' + $launcher + '",0')
New-Item -Path ($registryPath + '\shell\open\command') -Force | Out-Null
Set-Item -LiteralPath ($registryPath + '\shell\open\command') -Value $command
