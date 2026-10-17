#!/usr/bin/env pwsh
<#
.SYNOPSIS
    Root build orchestrator for the AI Engineering Fluency mono-repo.

.DESCRIPTION
    Builds one or more sub-projects from the repo root so that nothing gets missed.
    Projects:
      vscode-extension  – VS Code extension (TypeScript / Node.js)
      cli               – Command-line tool  (TypeScript / Node.js)
      sharing           – Self-hosted sharing server (TypeScript / Node.js)
      visualstudio-extension – Visual Studio extension (C# / .NET)
      jetbrains-plugin  – JetBrains IDE plugin (Kotlin / Gradle / IntelliJ Platform)
      desktop           – Electron desktop app (reuses the extension's webview bundles)

.PARAMETER Project
    Which project(s) to build.  Accepts: all | vscode | cli | sharing | visualstudio | jetbrains | desktop
    Default: all

.PARAMETER Target
    Which build target to run.  Accepts: build | package | test | clean
    Default: build

.PARAMETER SkipInstall
    Skip all `pnpm install --frozen-lockfile` dependency installs (assumes node_modules is already
    current in each project).  Useful for fast local iteration.

.EXAMPLE
    ./build.ps1
    # builds vscode-extension and cli (default: all, build)

.EXAMPLE
    ./build.ps1 -Project vscode -Target test
    # runs tests for the VS Code extension only

.EXAMPLE
    ./build.ps1 -Project cli -SkipInstall
    # builds the CLI without re-running pnpm install --frozen-lockfile (node_modules must be current)
#>

param(
    [ValidateSet('all', 'vscode', 'cli', 'visualstudio', 'sharing', 'jetbrains', 'desktop')]
    [string] $Project = 'all',

    [ValidateSet('build', 'package', 'test', 'clean')]
    [string] $Target = 'build',

    [switch] $SkipInstall
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Write-Step([string]$msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Write-Ok([string]$msg)   { Write-Host "    $msg" -ForegroundColor Green }
function Write-Err([string]$msg)  { Write-Host "    ERROR: $msg" -ForegroundColor Red }

# Tracks directories whose npm dependencies were already installed during this
# invocation, so a full build doesn't re-run `pnpm install --frozen-lockfile` (which wipes
# node_modules) for the same project multiple times.
$script:npmInstalled = @{}

function Ensure-PnpmDeps([string]$dir) {
    if ($SkipInstall) { return }
    $key = (Resolve-Path $dir).Path
    if ($script:npmInstalled.ContainsKey($key)) { return }
    Push-Location $key
    try {
        pnpm install --frozen-lockfile
        if ($LASTEXITCODE -ne 0) { throw "pnpm install --frozen-lockfile failed in $key" }
    }
    finally { Pop-Location }
    $script:npmInstalled[$key] = $true
}

# ---------------------------------------------------------------------------
# VS Code Extension
# ---------------------------------------------------------------------------
function Build-VsCode {
    Write-Step "vscode-extension: $Target"
    Push-Location "$PSScriptRoot/vscode-extension"
    try {
        switch ($Target) {
            'build'   { Ensure-PnpmDeps .; pnpm run validate }
            'package' { Ensure-PnpmDeps .; pnpm run package; pnpm exec vsce package --no-dependencies }
            'test'    { Ensure-PnpmDeps .; pnpm run test:node }
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
            'build'   { Ensure-PnpmDeps .; pnpm run build }
            'package' { Ensure-PnpmDeps .; pnpm run build:production; & pwsh -NoProfile -File bundle-exe.ps1 -SkipBuild }
            'test'    {
                # test:unit imports the built library from dist/lib, so build first (same order as CI).
                Ensure-PnpmDeps .
                pnpm run build
                if ($LASTEXITCODE -ne 0) { throw "CLI build failed" }
                pnpm run test:unit
                if ($LASTEXITCODE -ne 0) { throw "CLI tests failed" }
            }
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
        Ensure-PnpmDeps .
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

    # Always rebuild the vscode-extension webview bundles so the VS extension
    # gets the latest compiled JS (labels, strings, etc.)
    Write-Step "vscode-extension: compile (for VS webview bundles)"
    Push-Location "$PSScriptRoot/vscode-extension"
    try {
        Ensure-PnpmDeps .
        pnpm run compile
        if ($LASTEXITCODE -ne 0) { throw "vscode-extension compile failed" }
        Write-Ok "vscode-extension compiled."
    }
    finally { Pop-Location }

    # Copy compiled webview bundles into the VS extension project
    $webviewSrc = Join-Path $PSScriptRoot 'vscode-extension' 'dist' 'webview'
    $webviewDst = Join-Path $PSScriptRoot 'visualstudio-extension' 'src' 'AIEngineeringFluency' 'webview'
    if (-not (Test-Path $webviewDst)) { New-Item -ItemType Directory -Path $webviewDst -Force | Out-Null }
    foreach ($bundle in @('details', 'chart', 'usage', 'diagnostics', 'environmental', 'maturity')) {
        $src = Join-Path $webviewSrc "$bundle.js"
        if (Test-Path $src) {
            Copy-Item $src (Join-Path $webviewDst "$bundle.js") -Force
        }
    }
    Write-Ok "Copied webview bundles to visualstudio-extension/webview/"

    # Always rebuild the CLI exe from source so the VS extension has the latest
    # maturity scoring labels and other runtime logic.
    Build-CliExe

    # Copy the CLI exe and its runtime assets into the VS extension project
    $cliExe = Join-Path $PSScriptRoot 'cli' 'dist' 'copilot-token-tracker.exe'
    $vsCliDir = Join-Path $PSScriptRoot 'visualstudio-extension' 'src' 'AIEngineeringFluency' 'cli-bundle'
    if (-not (Test-Path $vsCliDir)) { New-Item -ItemType Directory -Path $vsCliDir -Force | Out-Null }
    Copy-Item $cliExe (Join-Path $vsCliDir 'copilot-token-tracker.exe') -Force
    # sql.js WASM binary is loaded at runtime from the same directory as the exe
    $wasmSrc = Join-Path $PSScriptRoot 'cli' 'dist' 'sql-wasm.wasm'
    if (Test-Path $wasmSrc) {
        Copy-Item $wasmSrc (Join-Path $vsCliDir 'sql-wasm.wasm') -Force
    }
    Write-Ok "Copied CLI exe + sql-wasm.wasm to cli-bundle/"

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
            # Restore SDK-style projects (needs dotnet restore, not nuget restore)
            dotnet restore "$PSScriptRoot/visualstudio-extension/src/AIEngineeringFluency.Tests/AIEngineeringFluency.Tests.csproj"
            dotnet restore "$PSScriptRoot/visualstudio-extension/src/AIEngineeringFluencyRunner/AIEngineeringFluencyRunner.csproj"
            & $msbuild $sln /p:Configuration=Release /t:Build /v:minimal
            if ($LASTEXITCODE -ne 0) { throw "MSBuild build failed" }
        }
        'package' {
            dotnet restore "$PSScriptRoot/visualstudio-extension/src/AIEngineeringFluency.Tests/AIEngineeringFluency.Tests.csproj"
            dotnet restore "$PSScriptRoot/visualstudio-extension/src/AIEngineeringFluencyRunner/AIEngineeringFluencyRunner.csproj"
            & $msbuild $sln /p:Configuration=Release /t:Rebuild /v:minimal
            if ($LASTEXITCODE -ne 0) { throw "MSBuild rebuild failed" }
        }
        'test'    {
            # 1. Restore SDK-style projects first, then build the full solution with MSBuild
            dotnet restore "$PSScriptRoot/visualstudio-extension/src/AIEngineeringFluency.Tests/AIEngineeringFluency.Tests.csproj"
            dotnet restore "$PSScriptRoot/visualstudio-extension/src/AIEngineeringFluencyRunner/AIEngineeringFluencyRunner.csproj"
            & $msbuild $sln /p:Configuration=Release /t:Build /v:minimal
            if ($LASTEXITCODE -ne 0) { throw "MSBuild failed before running tests" }

            # 2. Run tests with dotnet test --no-build (avoids re-invoking VSSDK build targets)
            Push-Location "$PSScriptRoot/visualstudio-extension"
            try {
                $testProj = "src/AIEngineeringFluency.Tests/AIEngineeringFluency.Tests.csproj"
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
        'clean'   { & $msbuild $sln /p:Configuration=Release /t:Clean /v:minimal }
    }
    Write-Ok "visualstudio-extension done."
}

# ---------------------------------------------------------------------------
# JetBrains Plugin
#
# Prereq: JDK 21+ on PATH (the included Gradle wrapper handles Gradle itself).
# Always rebuilds the vscode-extension webview bundles and the CLI binary
# first so the plugin gets the latest UI + stats engine. The Gradle
# `prepareBundledAssets` task copies them into the plugin resources.
# ---------------------------------------------------------------------------
function Build-Jetbrains {
    Write-Step "jetbrains-plugin: $Target"

    if (-not (Test-Path "$PSScriptRoot/jetbrains-plugin/build.gradle.kts")) {
        Write-Host "    (jetbrains-plugin not yet scaffolded - skipping)" -ForegroundColor Yellow
        return
    }

    # Ensure Java is available; the wrapper script otherwise fails with a cryptic error.
    $java = Get-Command java -ErrorAction SilentlyContinue
    if (-not $java) {
        Write-Err "Java not found on PATH - install JDK 21+ (e.g. `winget install Microsoft.OpenJDK.21`)"
        return
    }

    # Always refresh the inputs the plugin embeds.
    Write-Step "vscode-extension: compile (for JetBrains webview bundles)"
    Push-Location "$PSScriptRoot/vscode-extension"
    try {
        Ensure-PnpmDeps .
        pnpm run compile
        if ($LASTEXITCODE -ne 0) { throw "vscode-extension compile failed" }
    }
    finally { Pop-Location }

    # Bundle the CLI exe so the JetBrains plugin can ship it for Windows users.
    Build-CliExe

    Push-Location "$PSScriptRoot/jetbrains-plugin"
    try {
        $gw = if ($IsWindows -or $env:OS -eq 'Windows_NT') { '.\gradlew.bat' } else { './gradlew' }
        switch ($Target) {
            'build'   { & $gw buildPlugin --no-daemon }
            'package' { & $gw buildPlugin --no-daemon }
            'test'    { & $gw test --no-daemon }
            'clean'   { & $gw clean --no-daemon }
        }
        if ($LASTEXITCODE -ne 0) { throw "Gradle target '$Target' failed" }
        Write-Ok "jetbrains-plugin done."
    }
    finally { Pop-Location }
}

# ---------------------------------------------------------------------------
# Sharing Server
# ---------------------------------------------------------------------------
function Build-Sharing {
    Write-Step "sharing-server: $Target"
    Push-Location "$PSScriptRoot/sharing-server"
    try {
        switch ($Target) {
            'build'   { Ensure-PnpmDeps .; pnpm run build }
            'package' { Ensure-PnpmDeps .; pnpm run build:production }
            'test'    {
                Ensure-PnpmDeps .
                pnpm test
                if ($LASTEXITCODE -ne 0) { throw "Sharing-server tests failed" }
            }
            'clean'   { Remove-Item -Recurse -Force dist -ErrorAction SilentlyContinue }
        }
        Write-Ok "sharing-server done."
    }
    finally { Pop-Location }
}

# ---------------------------------------------------------------------------
# Desktop App
# ---------------------------------------------------------------------------
function Build-Desktop {
    Write-Step "desktop: $Target"
    if ($Target -ne 'clean') {
        # The app copies the extension's webview bundles and imports the CLI's
        # stats logic from source, so both siblings need their dependencies.
        Ensure-PnpmDeps "$PSScriptRoot/vscode-extension"
        Ensure-PnpmDeps "$PSScriptRoot/cli"
    }
    if ($Target -in 'build', 'package') {
        # Rebuild the webview bundles the app copies. desktop/esbuild.js only
        # builds them when they are missing, so without this a standalone
        # desktop build would ship whatever stale bundles dist/webview holds.
        # Production (minified) for 'package', matching desktop-publish.yml.
        Write-Step "vscode-extension: webview bundles (for desktop)"
        Push-Location "$PSScriptRoot/vscode-extension"
        try {
            if ($Target -eq 'package') { node esbuild.js --production } else { node esbuild.js }
            if ($LASTEXITCODE -ne 0) { throw "vscode-extension webview build failed" }
        }
        finally { Pop-Location }
    }
    Push-Location "$PSScriptRoot/desktop"
    try {
        # $LASTEXITCODE is only meaningful right after a native command: 'clean'
        # runs none, and under StrictMode an unset one would throw. So each pnpm
        # target checks its own exit code.
        $npmScript = switch ($Target) {
            'build'   { 'build' }
            'package' { 'dist' }
            # No unit tests yet: type-check plus the checks that keep the app in
            # step with the extension's views (message contract, theme tokens).
            'test'    { 'check' }
            default   { $null }
        }
        if ($npmScript) {
            Ensure-PnpmDeps .
            pnpm run $npmScript
            if ($LASTEXITCODE -ne 0) { throw "Desktop target '$Target' failed (pnpm run $npmScript)" }
        } else {
            Remove-Item -Recurse -Force dist, release -ErrorAction SilentlyContinue
        }
        Write-Ok "desktop done."
    }
    finally { Pop-Location }
}

switch ($Project) {
    'all' {
        Build-VsCode
        Build-Cli
        Build-Sharing
        Build-VisualStudio
        Build-Jetbrains
        Build-Desktop
    }
    'vscode'      { Build-VsCode }
    'cli'         { Build-Cli }
    'sharing'     { Build-Sharing }
    'visualstudio'{ Build-VisualStudio }
    'jetbrains'   { Build-Jetbrains }
    'desktop'     { Build-Desktop }
}

Write-Host "`nBuild complete." -ForegroundColor Green
