#!/usr/bin/env pwsh
<#
.SYNOPSIS
    Bundles the CLI into a single Windows executable using Node.js SEA
    (Single Executable Applications).

.DESCRIPTION
    Steps:
      1. Build cli.js via esbuild (production mode)
      2. Generate a SEA preparation blob from the bundle
      3. Copy the current node.exe and inject the blob via postject
    Output: cli/dist/copilot-token-tracker.exe
#>
param(
    [switch] $SkipBuild   # skip the esbuild step (use existing dist/cli.js)
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$cliRoot  = $PSScriptRoot
$distDir  = Join-Path $cliRoot 'dist'
$seaBlob  = Join-Path $distDir 'sea-prep.blob'
$exeName  = 'copilot-token-tracker.exe'
$exePath  = Join-Path $distDir $exeName

Write-Host "==> Bundling CLI as single executable" -ForegroundColor Cyan

# 1. Build with esbuild
if (-not $SkipBuild) {
    Write-Host "    Building cli.js (production)..."
    Push-Location $cliRoot
    try {
        npm run build:production
        if ($LASTEXITCODE -ne 0) { throw "esbuild failed" }
    } finally { Pop-Location }
} else {
    Write-Host "    Skipping esbuild (using existing dist/cli.js)"
}

if (-not (Test-Path (Join-Path $distDir 'cli.js'))) {
    throw "dist/cli.js not found — run esbuild first"
}

# 2. Generate the SEA preparation blob
Write-Host "    Generating SEA blob..."
Push-Location $cliRoot
try {
    & node --experimental-sea-config (Join-Path $cliRoot 'sea-config.json')
    if ($LASTEXITCODE -ne 0) { throw "SEA blob generation failed" }
} finally { Pop-Location }

# 3. Copy node.exe and inject the blob
Write-Host "    Copying node.exe..."
$nodeExe = (Get-Command node).Source
Copy-Item $nodeExe $exePath -Force

# Remove the code signature so postject can write to the binary
Write-Host "    Removing code signature..."
try {
    # signtool is not always available; use PowerShell to strip Authenticode
    Set-AuthenticodeSignature -FilePath $exePath -Certificate $null -ErrorAction SilentlyContinue 2>$null
} catch {
    # If that didn't work, just continue — postject will handle unsigned binaries fine
}

Write-Host "    Injecting SEA blob with postject..."
& npx --yes postject $exePath NODE_SEA_BLOB $seaBlob `
    --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2
if ($LASTEXITCODE -ne 0) { throw "postject injection failed" }

# Verify
$fileSize = (Get-Item $exePath).Length / 1MB
Write-Host "    ✓ Built: $exePath ($([math]::Round($fileSize, 1)) MB)" -ForegroundColor Green
