param([Parameter(Mandatory=$true)][ValidateSet('read','write')][string]$Mode,
    [Parameter(Mandatory=$true)][int]$ParentId)
$ErrorActionPreference = 'Stop'
# The watchdog runs outside the PowerShell pipeline, including during blocked pipe I/O.
Add-Type -TypeDefinition @'
using System;
using System.Diagnostics;
using System.Threading;
public static class ScopeKeyPipeLifetime {
    private static Timer timer;
    public static void Start(int parentId) {
        var parent = Process.GetProcessById(parentId);
        var started = parent.StartTime.ToUniversalTime();
        var deadline = DateTime.UtcNow.AddSeconds(35);
        timer = new Timer(_ => {
            try {
                if (DateTime.UtcNow < deadline && Process.GetProcessById(parentId).StartTime.ToUniversalTime() == started) return;
            } catch { }
            Process.GetCurrentProcess().Kill();
        }, null, 1000, 1000);
    }
}
'@
[ScopeKeyPipeLifetime]::Start($ParentId)
$pipe = $null
$bytes = $null
try {
    $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
    $logon = @($identity.Groups | Where-Object { $_.Value -match '^S-1-5-5-\d+-\d+$' })
    if ($logon.Count -ne 1) { throw 'No interactive logon identity.' }
    $acl = New-Object System.IO.Pipes.PipeSecurity
    $acl.SetAccessRuleProtection($true, $false)
    $acl.SetOwner($identity.User)
    $acl.AddAccessRule([System.IO.Pipes.PipeAccessRule]::new(
        [System.Security.Principal.SecurityIdentifier]::new('S-1-5-2'),
        [System.IO.Pipes.PipeAccessRights]::FullControl,
        [System.Security.AccessControl.AccessControlType]::Deny))
    $acl.AddAccessRule([System.IO.Pipes.PipeAccessRule]::new(
        $logon[0], [System.IO.Pipes.PipeAccessRights]::FullControl,
        [System.Security.AccessControl.AccessControlType]::Allow))
    $name = 'scope-guest-' + [Guid]::NewGuid().ToString('N')
    $pipe = [System.IO.Pipes.NamedPipeServerStream]::new(
        $name, [System.IO.Pipes.PipeDirection]::InOut, 1,
        [System.IO.Pipes.PipeTransmissionMode]::Byte,
        [System.IO.Pipes.PipeOptions]::Asynchronous, 16384, 16384, $acl,
        [System.IO.HandleInheritability]::None)
    $actual = $pipe.GetAccessControl()
    if (-not $actual.AreAccessRulesProtected) { throw 'Pipe permissions are not protected.' }
    $rules = @($actual.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
    if ($rules.Count -ne 2) { throw 'Unexpected pipe permissions.' }
    foreach ($rule in $rules) {
        if ($rule.IsInherited) { throw 'Inherited pipe permissions.' }
        if ($rule.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow -and
            $rule.IdentityReference.Value -ne $logon[0].Value) { throw 'Unexpected pipe reader.' }
    }
    # Only the supervising process reads this anonymous stdout pipe.
    [Console]::Out.WriteLine('\\.\pipe\' + $name)
    [Console]::Out.Flush()
    if ($Mode -eq 'write') {
        $inputTask = [Console]::In.ReadLineAsync()
        if (-not $inputTask.Wait(15000)) { throw 'Key delivery timed out.' }
        $encoded = $inputTask.Result
        if ($null -eq $encoded -or $encoded.Length -gt 22000) { throw 'Invalid key delivery.' }
        $bytes = [Convert]::FromBase64String($encoded)
        $encoded = $null
    }
    $deadline = [DateTime]::UtcNow.AddSeconds(25)
    do {
        $connection = $pipe.BeginWaitForConnection($null, $null)
        $remaining = [Math]::Max(1, [int]($deadline - [DateTime]::UtcNow).TotalMilliseconds)
        if (-not $connection.AsyncWaitHandle.WaitOne($remaining)) { throw 'Pipe connection timed out.' }
        $pipe.EndWaitForConnection($connection)
        $connection.AsyncWaitHandle.Close()
        if ($Mode -eq 'write') {
            $write = $pipe.WriteAsync($bytes, 0, $bytes.Length)
            if (-not $write.Wait(5000)) { throw 'Pipe write timed out.' }
            $pipe.Flush()
            $pipe.WaitForPipeDrain()
            break
        }
        # genkey may inspect the path before opening it to write.
        $buffer = New-Object byte[] 16385
        $length = 0
        do {
            $read = $pipe.ReadAsync($buffer, $length, $buffer.Length - $length)
            if (-not $read.Wait(5000)) { throw 'Pipe read timed out.' }
            $count = $read.Result
            $length += $count
            if ($length -gt 16384) { throw 'Key document is too large.' }
        } while ($count -gt 0)
        if ($length -gt 0) {
            # The key is returned only over the supervisor's inherited anonymous pipe.
            [Console]::Out.WriteLine([Convert]::ToBase64String($buffer, 0, $length))
            [Console]::Out.Flush()
            [Array]::Clear($buffer, 0, $buffer.Length)
            break
        }
        $pipe.Disconnect()
    } while ([DateTime]::UtcNow -lt $deadline)
    if ($Mode -eq 'read' -and $length -eq 0) { throw 'No key received.' }
} catch {
    # Native exceptions can include paths or key contents; never relay them.
    [Console]::Error.WriteLine('Protected Windows key pipe failed. Retry or update Windows PowerShell.')
    exit 1
} finally {
    if ($null -ne $bytes) { [Array]::Clear($bytes, 0, $bytes.Length) }
    if ($null -ne $pipe) { $pipe.Dispose() }
}
