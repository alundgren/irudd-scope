param(
    [Parameter(Mandatory = $true)][string]$Directory,
    [ValidateSet('add', 'remove')][string]$Action
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class ScopeEnvironment {
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern IntPtr SendMessageTimeout(IntPtr window, uint message, UIntPtr wParam, string lParam, uint flags, uint timeout, out UIntPtr result);
}
'@
$registry = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment')
try {
    $value = [string]$registry.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
    $entries = if ($value) { @($value -split ';') } else { @() }
    $present = @($entries | Where-Object { $_.TrimEnd('\') -ieq $Directory.TrimEnd('\') }).Count -gt 0
    if ($Action -eq 'add' -and -not $present) { $entries += $Directory }
    if ($Action -eq 'remove') { $entries = @($entries | Where-Object { $_.TrimEnd('\') -ine $Directory.TrimEnd('\') }) }
    if (($entries -join ';') -ne $value) {
        $kind = if ($registry.GetValueNames() -contains 'Path') { $registry.GetValueKind('Path') } else { [Microsoft.Win32.RegistryValueKind]::ExpandString }
        $registry.SetValue('Path', ($entries -join ';'), $kind)
        $result = [UIntPtr]::Zero
        [ScopeEnvironment]::SendMessageTimeout([IntPtr]0xffff, 0x1a, [UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$result) | Out-Null
    }
} finally { $registry.Dispose() }
