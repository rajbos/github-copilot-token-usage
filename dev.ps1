#!/usr/bin/env pwsh
# Quick dev setup for the VS Code extension: install deps, compile, then open VS Code.

Push-Location "$PSScriptRoot/vscode-extension"

try {
    npm ci && npm run compile
    if ($LASTEXITCODE -eq 0) {
        code .
    } else {
        Write-Error "Build failed — VS Code will not be opened."
    }
} finally {
    Pop-Location
}
