# publish.ps1
# Publishes the extension to the VS Code Marketplace using a VSIX downloaded
# from the GitHub release. Run AFTER the GitHub Actions release workflow has
# created the GitHub release and you have downloaded the .vsix asset.
#
# Usage:
#   .\publish.ps1 -VsixPath ".\copilot-token-tracker-0.0.13.vsix"

param(
    [string]$VsixPath  # Path to the .vsix downloaded from the GitHub release
)

$ErrorActionPreference = "Stop"

# ── Read version from package.json ───────────────────────────────────────────
$packageJson  = Get-Content -Path "package.json" -Raw | ConvertFrom-Json
$version      = $packageJson.version
$expectedTag  = "v$version"
$owner        = "rajbos"
$repo         = "github-copilot-token-usage"
$publisherName = "RobBos"

# ── Resolve / prompt for VSIX path ───────────────────────────────────────────
if ([string]::IsNullOrWhiteSpace($VsixPath)) {
    # Default: look for a matching VSIX in the current directory
    $defaultVsix = ".\copilot-token-tracker-$version.vsix"
    if (Test-Path $defaultVsix) {
        $VsixPath = $defaultVsix
        Write-Host "Found VSIX: $VsixPath" -ForegroundColor Green
    } else {
        $VsixPath = Read-Host "Enter path to the .vsix downloaded from the GitHub release"
    }
}

if (-not (Test-Path $VsixPath)) {
    Write-Host "`n❌ VSIX not found: $VsixPath" -ForegroundColor Red
    Write-Host "   Download it from: https://github.com/$owner/$repo/releases/tag/$expectedTag" -ForegroundColor Yellow
    exit 1
}
Write-Host "Using VSIX: $VsixPath" -ForegroundColor Cyan

# ── Step 1: Validate GitHub release exists ────────────────────────────────────
Write-Host "`nValidating GitHub release $expectedTag..." -ForegroundColor Cyan
$apiUrl = "https://api.github.com/repos/$owner/$repo/releases/tags/$expectedTag"
try {
    $release = Invoke-RestMethod -Uri $apiUrl -Method Get -Headers @{
        "Accept"     = "application/vnd.github+json"
        "User-Agent" = "PowerShell-Script"
    }
    Write-Host "✅ GitHub release found: $($release.html_url)" -ForegroundColor Green
} catch {
    if ($_.Exception.Response.StatusCode -eq 404) {
        Write-Host "❌ GitHub release $expectedTag not found." -ForegroundColor Red
        Write-Host "   Create it at: https://github.com/$owner/$repo/releases/new" -ForegroundColor Yellow
    } else {
        Write-Host "❌ Failed to reach GitHub API: $($_.Exception.Message)" -ForegroundColor Red
    }
    exit 1
}

# ── Step 2: Sync CHANGELOG.md from the release notes ─────────────────────────
Write-Host "`nSyncing CHANGELOG.md from GitHub releases..." -ForegroundColor Cyan
npm run sync-changelog
if ($LASTEXITCODE -ne 0) {
    Write-Host "⚠️  CHANGELOG sync failed. Continuing anyway." -ForegroundColor Yellow
}

# ── Step 3: Marketplace login ─────────────────────────────────────────────────
Write-Host "`nChecking marketplace login status..." -ForegroundColor Cyan
$vsceListOutput = npx vsce ls-publishers 2>&1
$isLoggedIn = $LASTEXITCODE -eq 0

if (-not $isLoggedIn) {
    Write-Host "You are not logged in to the VS Code Marketplace." -ForegroundColor Yellow
    Write-Host ""
    Write-Host "To publish extensions you need a Personal Access Token from Azure DevOps:" -ForegroundColor Yellow
    Write-Host "  1. Go to https://dev.azure.com" -ForegroundColor Gray
    Write-Host "  2. User Settings → Personal Access Tokens" -ForegroundColor Gray
    Write-Host "  3. New token with 'Marketplace (Publish)' scope, all organisations" -ForegroundColor Gray
    Write-Host ""
    $publisher = Read-Host "Enter your publisher name (default: $publisherName)"
    if ([string]::IsNullOrWhiteSpace($publisher)) { $publisher = $publisherName }
    Write-Host "`nLogging in as '$publisher'..." -ForegroundColor Cyan
    npx vsce login $publisher
    if ($LASTEXITCODE -ne 0) {
        Write-Host "`n❌ Login failed." -ForegroundColor Red
        exit 1
    }
    Write-Host "Login successful!" -ForegroundColor Green
} else {
    Write-Host "Already logged in to the marketplace." -ForegroundColor Green
}

# ── Step 4: Publish the downloaded VSIX ──────────────────────────────────────
Write-Host "`nPublishing $VsixPath to the VS Code Marketplace..." -ForegroundColor Cyan
npx vsce publish --packagePath $VsixPath

if ($LASTEXITCODE -eq 0) {
    Write-Host "`n✅ Extension published successfully!" -ForegroundColor Green
    Write-Host "It may take a few minutes to appear in the marketplace." -ForegroundColor Gray
    Write-Host ""
    Write-Host "📝 Commit and push the updated CHANGELOG.md:" -ForegroundColor Cyan
    Write-Host "   git add CHANGELOG.md" -ForegroundColor Gray
    Write-Host "   git commit -m 'chore: sync changelog for $expectedTag'" -ForegroundColor Gray
    Write-Host "   git push" -ForegroundColor Gray
} else {
    Write-Host "`n❌ Publishing failed. Check the error messages above." -ForegroundColor Red
    exit 1
}

