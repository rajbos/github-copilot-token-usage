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
            'package' { npm ci; npm run build:production }
            'test'    { Write-Host "    (no CLI tests yet)" }
            'clean'   { Remove-Item -Recurse -Force dist -ErrorAction SilentlyContinue }
        }
        Write-Ok "cli done."
    }
    finally { Pop-Location }
}

# ---------------------------------------------------------------------------
# Visual Studio Extension  (placeholder — C#/.NET not yet scaffolded)
# ---------------------------------------------------------------------------
function Build-VisualStudio {
    Write-Step "visualstudio-extension: $Target"
    $slnFiles = Get-ChildItem -Path "$PSScriptRoot/visualstudio-extension" -Filter '*.sln' -Recurse -ErrorAction SilentlyContinue
    if (-not $slnFiles) {
        Write-Host "    (visualstudio-extension not yet scaffolded – skipping)" -ForegroundColor Yellow
        return
    }
    $sln = $slnFiles[0].FullName
    switch ($Target) {
        'build'   { dotnet build $sln --configuration Release }
        'package' { dotnet publish $sln --configuration Release }
        'test'    { dotnet test $sln --configuration Release }
        'clean'   { dotnet clean $sln }
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
