# This script builds the extension and publishes it to the VS Code Marketplace.

# Ensure the script stops on errors
$ErrorActionPreference = "Stop"

# 1. Run the build script to create the VSIX package
Write-Host "Building extension..." -ForegroundColor Cyan
& .\build.ps1
if ($LASTEXITCODE -ne 0) {
    Write-Host "Build failed. Please fix the errors and try again." -ForegroundColor Red
    exit 1
}

# 2. Check if we're already logged in to vsce
Write-Host "`nChecking marketplace login status..." -ForegroundColor Cyan
$publisherName = "RobBos"  # From package.json

# Try to get the list of publishers (this will fail if not logged in)
$vsceListOutput = npx vsce ls-publishers 2>&1
$isLoggedIn = $LASTEXITCODE -eq 0

if (-not $isLoggedIn) {
    Write-Host "You are not logged in to the VS Code Marketplace." -ForegroundColor Yellow
    Write-Host ""
    Write-Host "To publish extensions, you need a Personal Access Token from Azure DevOps:" -ForegroundColor Yellow
    Write-Host "1. Go to https://dev.azure.com" -ForegroundColor Gray
    Write-Host "2. Click User Settings -> Personal Access Tokens" -ForegroundColor Gray
    Write-Host "3. Create new token with 'Marketplace (Publish)' scope" -ForegroundColor Gray
    Write-Host "4. Set organization to 'All accessible organizations'" -ForegroundColor Gray
    Write-Host ""
    
    $publisher = Read-Host "Enter your publisher name (default: $publisherName from package.json)"
    if ([string]::IsNullOrWhiteSpace($publisher)) {
        $publisher = $publisherName
    }
    
    Write-Host "`nLogging in as '$publisher'..." -ForegroundColor Cyan
    Write-Host "You will be prompted for your Personal Access Token." -ForegroundColor Gray
    npx vsce login $publisher
    
    if ($LASTEXITCODE -ne 0) {
        Write-Host "`nLogin failed. Cannot publish without authentication." -ForegroundColor Red
        exit 1
    }
    Write-Host "Login successful!" -ForegroundColor Green
} else {
    Write-Host "Already logged in to the marketplace." -ForegroundColor Green
}

# 3. Publish the extension
Write-Host "`nPublishing extension to the VS Code Marketplace..." -ForegroundColor Cyan
npx vsce publish

if ($LASTEXITCODE -eq 0) {
    Write-Host "`n✅ Extension published successfully!" -ForegroundColor Green
    Write-Host "It may take a few minutes to appear in the marketplace." -ForegroundColor Gray
} else {
    Write-Host "`n❌ Publishing failed. Please check the error messages above." -ForegroundColor Red
    exit 1
}
