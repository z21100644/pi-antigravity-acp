param([Parameter(Mandatory = $true)][string]$PiDesktopPath)
$ErrorActionPreference = 'Stop'
$source = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$piExecutable = (Resolve-Path -LiteralPath $PiDesktopPath).Path
if (Test-Path -LiteralPath $piExecutable -PathType Container) { $piExecutable = Join-Path $piExecutable 'PI-Desktop.exe' }
if (-not (Test-Path -LiteralPath $piExecutable -PathType Leaf)) { throw 'PI-Desktop.exe not found.' }
$piDir = Split-Path -Parent $piExecutable
if (-not (Test-Path -LiteralPath (Join-Path $piDir 'resources\bin\pi-desktop-host-core.exe'))) {
    throw 'PI Desktop host executable not found next to PI-Desktop.exe.'
}
$manifest = Get-Content -LiteralPath (Join-Path $source 'manifest.json') -Raw | ConvertFrom-Json
$package = Get-Content -LiteralPath (Join-Path $source 'package.json') -Raw | ConvertFrom-Json
$userDir = Join-Path ([Environment]::GetFolderPath('UserProfile')) '.pi-desktop'
$pluginRoot = [IO.Path]::GetFullPath((Join-Path $userDir 'plugins'))
$registryPath = Join-Path $pluginRoot 'registry.json'
$target = Join-Path $pluginRoot 'installed\pi-antigravity-acp'
if (Test-Path -LiteralPath $registryPath) {
    $registry = @(Get-Content -LiteralPath $registryPath -Raw | ConvertFrom-Json)
    $existing = @($registry | Where-Object { $_.id -eq $manifest.id })
    if ($existing.Count -gt 1) { throw 'Multiple plugin registrations found.' }
    if ($existing.Count -eq 1) { $target = [IO.Path]::GetFullPath($existing[0].path) }
}
$target = [IO.Path]::GetFullPath($target)
if (-not $target.StartsWith($pluginRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Existing plugin is outside the managed plugins directory: $target"
}
if ($target -eq $source) { throw 'Run the installer from a separate source checkout.' }
if (Test-Path -LiteralPath $target) {
    $backup = Join-Path $userDir ('backups\pi-antigravity-acp\' + (Get-Date -Format 'yyyyMMdd-HHmmss-fff'))
    New-Item -ItemType Directory -Path $backup -Force | Out-Null
    Copy-Item -LiteralPath $target -Destination (Join-Path $backup 'plugin') -Recurse
    if (Test-Path -LiteralPath $registryPath) { Copy-Item -LiteralPath $registryPath -Destination (Join-Path $backup 'registry.json') }
    Write-Output "Backup: $backup"
}
New-Item -ItemType Directory -Path $target -Force | Out-Null
foreach ($relative in @($package.files) + @('package.json')) {
    Copy-Item -LiteralPath (Join-Path $source $relative) -Destination $target -Recurse -Force
}
$configPath = Join-Path $userDir 'antigravity-acp.json'
if (-not (Test-Path -LiteralPath $configPath)) {
    $utf8 = New-Object System.Text.UTF8Encoding($false)
    [IO.File]::WriteAllText($configPath, '{"defaultEffort":"medium","autoPatch":false,"warmup":true}', $utf8)
}
$previousRunAsNode = [Environment]::GetEnvironmentVariable('ELECTRON_RUN_AS_NODE', 'Process')
try {
    $env:ELECTRON_RUN_AS_NODE = '1'
    & $piExecutable --use-system-ca (Join-Path $target 'scripts\register.mjs') --pi-desktop $piDir --plugin-dir $target | Out-Host
    if ($LASTEXITCODE -ne 0) { throw "Plugin registration failed (exit $LASTEXITCODE)." }
} finally { [Environment]::SetEnvironmentVariable('ELECTRON_RUN_AS_NODE', $previousRunAsNode, 'Process') }
Write-Output "Installed Antigravity ACP $($manifest.version). Restart PI Desktop and select Antigravity ACP."
