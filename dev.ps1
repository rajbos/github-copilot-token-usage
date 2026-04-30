#!/usr/bin/env pwsh
# Quick dev setup for the VS Code extension: install deps, compile, then open VS Code.

Push-Location "$PSScriptRoot/vscode-extension"
$succeeded = $false

try {
    Write-Host "Installing dependencies and building the VS Code extension..."
    npm ci && npm run compile
    if ($LASTEXITCODE -ne 0) {
        Write-Error "Build failed — VS Code will not be opened."
    } else {
        $succeeded = $true
    }
} finally {
    Pop-Location    
}

if ($succeeded) {
    Write-Host "Build succeeded — opening VS Code."
    code .
}