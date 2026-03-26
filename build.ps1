#!/usr/bin/env pwsh
<#
.SYNOPSIS
    Root build orchestrator for the Copilot Token Tracker mono-repo.

.DESCRIPTION
    Builds one or more sub-projects from the repo root so that nothing gets missed.
    Projects:
      vscode-extension  – VS Code extension (TypeScript / Node.js)
      cli               – Command-line tool  (TypeScript / Node.js)
      visualstudio-extension – Visual Studio extension (C# / .NET)   [future]

.PARAMETER Project
    Which project(s) to build.  Accepts: all | vscode | cli | visualstudio
    Default: all

.PARAMETER Target
    Which build target to run.  Accepts: build | package | test | clean
    Default: build

.EXAMPLE
    ./build.ps1
    # builds vscode-extension and cli (default: all, build)

.EXAMPLE
    ./build.ps1 -Project vscode -Target test
    # runs tests for the VS Code extension only
#>

param(
    [ValidateSet('all', 'vscode', 'cli', 'visualstudio')]
    [string] $Project = 'all',

    [ValidateSet('build', 'package', 'test', 'clean')]
    [string] $Target = 'build'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Write-Step([string]$msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Write-Ok([string]$msg)   { Write-Host "    $msg" -ForegroundColor Green }
function Write-Err([string]$msg)  { Write-Host "    ERROR: $msg" -ForegroundColor Red }

# ---------------------------------------------------------------------------
# VS Code Extension
# ---------------------------------------------------------------------------
function Build-VsCode {
    Write-Step "vscode-extension: $Target"
    Push-Location "$PSScriptRoot/vscode-extension"
    try {
        switch ($Target) {
            'build'   { npm ci; npm run compile }
            'package' { npm ci; npm run package; npx vsce package }
            'test'    { npm ci; npm run compile-tests; npm test }
            'clean'   { Remove-Item -Recurse -Force dist, out -ErrorAction SilentlyContinue }
        }
        Write-Ok "vscode-extension done."
    }
    finally { Pop-Location }
}

# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------
function Build-Cli {
    Write-Step "cli: $Target"
    Push-Location "$PSScriptRoot/cli"
    try {
        switch ($Target) {
            'build'   { npm ci; npm run build }
            'package' { npm ci; npm run build:production; & pwsh -NoProfile -File bundle-exe.ps1 -SkipBuild }
            'test'    { Write-Host "    (no CLI tests yet)" }
            'clean'   { Remove-Item -Recurse -Force dist -ErrorAction SilentlyContinue }
        }
        Write-Ok "cli done."
    }
    finally { Pop-Location }
}

# ---------------------------------------------------------------------------
# CLI Bundled Executable (for embedding in Visual Studio extension)
# ---------------------------------------------------------------------------
function Build-CliExe {
    Write-Step "cli: bundle-exe"
    Push-Location "$PSScriptRoot/cli"
    try {
        npm ci
        & pwsh -NoProfile -File bundle-exe.ps1
        if ($LASTEXITCODE -ne 0) { throw "CLI exe bundling failed" }
        Write-Ok "cli exe bundled."
    }
    finally { Pop-Location }
}

# ---------------------------------------------------------------------------
# Visual Studio Extension
# ---------------------------------------------------------------------------
function Build-VisualStudio {
    Write-Step "visualstudio-extension: $Target"
    $slnFiles = Get-ChildItem -Path "$PSScriptRoot/visualstudio-extension" -Filter '*.sln' -Recurse -ErrorAction SilentlyContinue
    if (-not $slnFiles) {
        Write-Host "    (visualstudio-extension not yet scaffolded – skipping)" -ForegroundColor Yellow
        return
    }

    # Ensure the bundled CLI exe exists (needed at runtime by the C# bridge)
    $cliExe = Join-Path $PSScriptRoot 'cli' 'dist' 'copilot-token-tracker.exe'
    if (-not (Test-Path $cliExe)) {
        Write-Host "    Bundled CLI exe not found — building it first..." -ForegroundColor Yellow
        Build-CliExe
    }

    # Copy the CLI exe and its runtime assets into the VS extension project
    $vsCliDir = Join-Path $PSScriptRoot 'visualstudio-extension' 'src' 'CopilotTokenTracker' 'cli-bundle'
    if (-not (Test-Path $vsCliDir)) { New-Item -ItemType Directory -Path $vsCliDir -Force | Out-Null }
    Copy-Item $cliExe (Join-Path $vsCliDir 'copilot-token-tracker.exe') -Force
    # sql.js WASM binary is loaded at runtime from the same directory as the exe
    $wasmSrc = Join-Path $PSScriptRoot 'cli' 'dist' 'sql-wasm.wasm'
    if (Test-Path $wasmSrc) {
        Copy-Item $wasmSrc (Join-Path $vsCliDir 'sql-wasm.wasm') -Force
    }
    Write-Host "    Copied CLI exe + sql-wasm.wasm to cli-bundle/"

    $sln = $slnFiles[0].FullName

    # VSIX projects require Visual Studio's MSBuild (not dotnet build) because
    # the VSSDK build targets depend on VS-specific assemblies.
    $msbuild = & "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe" `
        -latest -requires Microsoft.Component.MSBuild `
        -find 'MSBuild\**\Bin\MSBuild.exe' 2>$null | Select-Object -First 1

    if (-not $msbuild) {
        # Fallback: try the well-known VS 18 (2024+) path
        $msbuild = "${env:ProgramFiles}\Microsoft Visual Studio\18\Enterprise\MSBuild\Current\Bin\MSBuild.exe"
    }

    if (-not (Test-Path $msbuild)) {
        Write-Err "MSBuild not found — install the Visual Studio 'VSIX development' workload"
        return
    }

    switch ($Target) {
        'build'   {
            # Restore SDK-style test project (needs dotnet restore, not nuget restore)
            dotnet restore "$PSScriptRoot/visualstudio-extension/src/CopilotTokenTracker.Tests/CopilotTokenTracker.Tests.csproj"
            & $msbuild $sln /p:Configuration=Release /t:Build   /v:minimal
        }
        'package' { & $msbuild $sln /p:Configuration=Release /t:Rebuild /v:minimal }
        'test'    {
            # 1. Restore SDK-style test project first, then build the full solution with MSBuild
            dotnet restore "$PSScriptRoot/visualstudio-extension/src/CopilotTokenTracker.Tests/CopilotTokenTracker.Tests.csproj"
            & $msbuild $sln /p:Configuration=Release /t:Build /v:minimal
            if ($LASTEXITCODE -ne 0) { throw "MSBuild failed before running tests" }

            # 2. Run tests with dotnet test --no-build (avoids re-invoking VSSDK build targets)
            Push-Location "$PSScriptRoot/visualstudio-extension"
            try {
                $testProj = "src/CopilotTokenTracker.Tests/CopilotTokenTracker.Tests.csproj"
                dotnet test $testProj `
                    --no-build `
                    --configuration Release `
                    --collect:"XPlat Code Coverage" `
                    --results-directory TestResults `
                    --logger "console;verbosity=normal"
                if ($LASTEXITCODE -ne 0) { throw "Unit tests failed" }
            }
            finally { Pop-Location }
        }
        'clean'   { & $msbuild $sln /p:Configuration=Release /t:Clean   /v:minimal }
    }
    Write-Ok "visualstudio-extension done."
}

# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------
switch ($Project) {
    'all' {
        Build-VsCode
        Build-Cli
        Build-VisualStudio
    }
    'vscode'      { Build-VsCode }
    'cli'         { Build-Cli }
    'visualstudio'{ Build-VisualStudio }
}

Write-Host "`nBuild complete." -ForegroundColor Green
