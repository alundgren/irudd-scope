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

if ($Action -eq 'restore') {
    if (-not (Test-Path -LiteralPath $checkpoint)) { return }
    $previous = Import-Clixml -LiteralPath $checkpoint
    $errors = @()
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
# The caller can restore this snapshot even if this process is interrupted.
@{ Shortcut = $hadShortcut } | Export-Clixml -LiteralPath $checkpoint
New-Item -ItemType Directory -Force -Path $shortcutDirectory | Out-Null
$process = Start-Process -FilePath $launcher -ArgumentList ('--scope-shortcut "' + $shortcut + '"') -WindowStyle Hidden -PassThru -Wait
if ($process.ExitCode -ne 0) { throw 'Could not create the Scope Start menu shortcut.' }
