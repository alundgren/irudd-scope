param([ValidatePattern('^[0-9a-f]{40}$')][string]$Prepare)

function Install-Scope {
    $ErrorActionPreference = 'Stop'
    Set-StrictMode -Version Latest
    [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
    if ([Environment]::OSVersion.Platform -ne 'Win32NT' -or [Environment]::OSVersion.Version.Build -lt 22000 -or [Runtime.InteropServices.RuntimeInformation]::OSArchitecture -ne 'X64' -or -not [Environment]::Is64BitProcess) {
        throw 'Scope requires Windows 11 x64. Run this installer in a 64-bit PowerShell terminal.'
    }
    $Commit = $Prepare
    $repository = 'https://github.com/alundgren/irudd-scope.git'
    $root = if ($env:SCOPE_INSTALL_ROOT) { $env:SCOPE_INSTALL_ROOT } else { Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'irudd-scope' }
    if ($root -notmatch '^[A-Za-z]:[\\/]') { throw 'SCOPE_INSTALL_ROOT must be an absolute folder on a local Windows drive.' }
    $root = [IO.Path]::GetFullPath($root).TrimEnd('\')
    if ($root.Length -le 2) { throw 'Choose an installation folder, not the root of a drive.' }
    $gitCommand = Get-Command git.exe -CommandType Application -ErrorAction SilentlyContinue
    if (-not $gitCommand) { throw 'Install Git for Windows, open a new PowerShell terminal, and run this installer again.' }
    $git = $gitCommand.Source
    $powerShell = [Diagnostics.Process]::GetCurrentProcess().MainModule.FileName
    $source = Join-Path $root 'source'
    $staging = $null
    $bootstrap = $null
    $lock = $null
    $saved = @{}
    foreach ($name in @('PATH', 'GIT_TERMINAL_PROMPT', 'SCOPE_INSTALL_ROOT', 'SCOPE_VP', 'ELECTRON_RUN_AS_NODE', 'VP_HOME', 'VP_VERSION', 'VP_NODE_MANAGER', 'CI')) {
        $saved[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
    }
    function Invoke-ScopeNative([string]$Executable, [string[]]$Arguments) {
        & $Executable @Arguments
        if ($LASTEXITCODE -ne 0) { throw "$Executable exited with code $LASTEXITCODE." }
    }
    try {
        [IO.Directory]::CreateDirectory($root) | Out-Null
        try {
            # Windows releases and removes this lock even when taskkill cancels the build.
            $lock = [IO.FileStream]::new((Join-Path $root '.install-lock'), [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None, 4096, [IO.FileOptions]::DeleteOnClose)
        } catch { throw 'Another Scope install may be running. Wait for it to finish and retry.' }
        Get-ChildItem -LiteralPath (Join-Path $root 'builds') -Directory -Filter '.preparing.*' -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -match '^\.preparing\.[0-9a-f]{32}$' } |
            ForEach-Object { Remove-Item -LiteralPath $_.FullName -Recurse -Force }
        $env:GIT_TERMINAL_PROMPT = '0'
        if (-not (Test-Path -LiteralPath $source)) {
            Write-Host 'Cloning Scope...'
            Invoke-ScopeNative $git @('clone', '--depth', '1', '--branch', 'main', $repository, $source)
        }
        $origin = Invoke-ScopeNative $git @('-C', $source, 'remote', 'get-url', 'origin')
        if ($origin -ne $repository) { throw "Scope's source directory has a different Git remote. Move it aside and retry." }
        $edits = Invoke-ScopeNative $git @('-C', $source, 'status', '--porcelain')
        if ($edits) { throw "Scope's source directory has local edits. Keep them in a separate checkout before updating." }
        Write-Host 'Fetching Scope main...'
        $revision = if ($Commit) { $Commit } else { 'main' }
        Invoke-ScopeNative $git @('-C', $source, 'fetch', '--depth', '1', 'origin', $revision)
        $Commit = Invoke-ScopeNative $git @('-C', $source, 'rev-parse', 'FETCH_HEAD')
        if ($Commit -cnotmatch '^[0-9a-f]{40}$') { throw 'Git returned an invalid commit.' }
        Invoke-ScopeNative $git @('-C', $source, 'checkout', '--detach', $Commit)

        $vp = $env:SCOPE_VP
        if (-not $vp) {
            $vpCommand = Get-Command vp.exe -CommandType Application -ErrorAction SilentlyContinue
            if ($vpCommand) { $vp = $vpCommand.Source }
        }
        if (-not $vp -or -not (Test-Path -LiteralPath $vp -PathType Leaf)) {
            $workspace = Get-Content -LiteralPath (Join-Path $source 'pnpm-workspace.yaml') -Raw
            $version = [regex]::Match($workspace, '(?m)^  vite-plus: ([^\s]+)\s*$').Groups[1].Value
            if (-not $version) { throw 'Scope does not specify a Vite+ version.' }
            Write-Host 'Installing Vite+ to build Scope...'
            $bootstrap = Join-Path $root ('.vite-install-' + [Guid]::NewGuid().ToString('N') + '.ps1')
            Invoke-WebRequest -UseBasicParsing -Uri 'https://vite.plus/ps1' -OutFile $bootstrap -TimeoutSec 120
            $env:VP_HOME = Join-Path ([Environment]::GetFolderPath('UserProfile')) '.vite-plus'
            $env:VP_VERSION = $version
            $env:VP_NODE_MANAGER = 'no'
            $env:CI = 'true'
            Invoke-ScopeNative $powerShell @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $bootstrap)
            $vp = Join-Path $env:VP_HOME 'bin\vp.exe'
        }
        if ($vp -notmatch '^[A-Za-z]:[\\/]' -or [IO.Path]::GetExtension($vp) -ine '.exe' -or -not (Test-Path -LiteralPath $vp -PathType Leaf)) { throw 'Vite+ is unavailable. Install it from https://viteplus.dev and retry.' }
        $env:PATH = (Split-Path -Parent $vp) + ';' + $env:PATH
        $env:SCOPE_INSTALL_ROOT = $root
        $env:SCOPE_VP = $vp
        Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
        Push-Location -LiteralPath $source
        try {
            Write-Host 'Installing build dependencies...'
            Invoke-ScopeNative $vp @('install', '--frozen-lockfile')
            $build = Join-Path $root ('builds\' + $Commit)
            if (-not (Test-Path -LiteralPath (Join-Path $build 'Scope\Scope.exe') -PathType Leaf)) {
                Write-Host 'Building Scope...'
                Invoke-ScopeNative $vp @('run', 'build')
                [IO.Directory]::CreateDirectory((Join-Path $root 'builds')) | Out-Null
                $staging = Join-Path $root ('builds\.preparing.' + [Guid]::NewGuid().ToString('N'))
                [IO.Directory]::CreateDirectory($staging) | Out-Null
                Invoke-ScopeNative $vp @('run', 'package:desktop', '--', $staging)
                [IO.Directory]::Move($staging, $build)
                $staging = $null
            }
            Invoke-ScopeNative $vp @('exec', 'node', 'tools/activate-installation.ts', $root, $build, 'prepare')
            if ($Prepare) { Write-Host 'Scope is ready to restart.'; return }
            Invoke-ScopeNative $vp @('exec', 'node', 'tools/activate-installation.ts', $root, $build, 'activate')
            Write-Host 'Installed Scope. Use Scope in the Start menu to open it.'
            Write-Host 'If Scope is already open, quit and reopen it to use this build.'
            Start-Process -FilePath (Join-Path $root 'Scope.exe')
        } finally { Pop-Location }
    } finally {
        if ($staging -and (Test-Path -LiteralPath $staging)) { Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue }
        if ($bootstrap -and (Test-Path -LiteralPath $bootstrap)) { Remove-Item -LiteralPath $bootstrap -Force -ErrorAction SilentlyContinue }
        if ($lock) { $lock.Dispose() }
        foreach ($name in $saved.Keys) { [Environment]::SetEnvironmentVariable($name, $saved[$name], 'Process') }
    }
}

Install-Scope
