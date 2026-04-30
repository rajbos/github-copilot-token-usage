# publish.ps1
# Manual fallback for publishing to the VS Code Marketplace.
#
# PRIMARY METHOD: Use the GitHub Actions Release workflow (workflow_dispatch),
# which handles building, testing, releasing, and publishing in one step.
#
# Use this script only when you need to manually publish a pre-built VSIX
# (e.g., re-publishing after a marketplace upload failure).
#
# The extension is published under two IDs (dual-publish):
#   - RobBos.ai-engineering-fluency  (new/primary ID)
#   - RobBos.copilot-token-tracker   (legacy ID – kept for existing users)
#
# Usage:
#   .\publish.ps1 -VsixPath ".\ai-engineering-fluency-0.3.0.vsix"
#   .\publish.ps1 -LegacyVsixPath ".\copilot-token-tracker-0.3.0.vsix"
#   .\publish.ps1  # auto-detect both VSIXs in the current directory

param(
    [string]$VsixPath,        # Path to the primary (ai-engineering-fluency) .vsix
    [string]$LegacyVsixPath   # Path to the legacy (copilot-token-tracker) .vsix
)

$ErrorActionPreference = "Stop"

# ── Read version from package.json ───────────────────────────────────────────
$packageJson  = Get-Content -Path "package.json" -Raw | ConvertFrom-Json
$version      = $packageJson.version
$expectedTag  = "v$version"
$owner        = "rajbos"
$repo         = "github-copilot-token-usage"
$publisherName = "RobBos"

# ── Resolve / prompt for primary VSIX path ───────────────────────────────────
if ([string]::IsNullOrWhiteSpace($VsixPath)) {
    $defaultVsix = ".\ai-engineering-fluency-$version.vsix"
    if (Test-Path $defaultVsix) {
        $VsixPath = $defaultVsix
        Write-Host "Found primary VSIX: $VsixPath" -ForegroundColor Green
    } else {
        $VsixPath = Read-Host "Enter path to the primary (ai-engineering-fluency) .vsix"
    }
}

# ── Resolve legacy VSIX path (optional) ──────────────────────────────────────
if ([string]::IsNullOrWhiteSpace($LegacyVsixPath)) {
    $defaultLegacy = ".\copilot-token-tracker-$version.vsix"
    if (Test-Path $defaultLegacy) {
        $LegacyVsixPath = $defaultLegacy
        Write-Host "Found legacy VSIX:  $LegacyVsixPath" -ForegroundColor Green
    } else {
        Write-Host "⚠️  Legacy VSIX not found at $defaultLegacy — will only publish primary ID." -ForegroundColor Yellow
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

# ── Step 3b: Validate PAT ─────────────────────────────────────────────────────
Write-Host "`nValidating Personal Access Token (PAT)..." -ForegroundColor Cyan
$pat = $env:VSCE_PAT
if ([string]::IsNullOrWhiteSpace($pat)) {
    Write-Host "VSCE_PAT environment variable is not set." -ForegroundColor Yellow
    Write-Host ""
    Write-Host "You need a Personal Access Token from Azure DevOps:" -ForegroundColor Yellow
    Write-Host "  1. Go to https://dev.azure.com" -ForegroundColor Gray
    Write-Host "  2. User Settings → Personal Access Tokens" -ForegroundColor Gray
    Write-Host "  3. New token with 'Marketplace (Publish)' scope, all organisations" -ForegroundColor Gray
    Write-Host ""
    $pat = Read-Host "Enter your PAT (input is hidden)" -AsSecureString | ForEach-Object {
        [System.Runtime.InteropServices.Marshal]::PtrToStringAuto(
            [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($_))
    }
    if ([string]::IsNullOrWhiteSpace($pat)) {
        Write-Host "`n❌ No PAT provided. Cannot publish without a valid token." -ForegroundColor Red
        exit 1
    }
} else {
    Write-Host "✅ VSCE_PAT environment variable found." -ForegroundColor Green
}

# ── Step 4: Publish the primary VSIX (ai-engineering-fluency) ────────────────
Write-Host "`nPublishing $VsixPath to the VS Code Marketplace (primary ID)..." -ForegroundColor Cyan
npx vsce publish --packagePath $VsixPath --pat $pat

if ($LASTEXITCODE -ne 0) {
    Write-Host "`n❌ Publishing primary VSIX failed. Check the error messages above." -ForegroundColor Red
    exit 1
}
Write-Host "✅ Primary extension published successfully!" -ForegroundColor Green

# ── Step 5: Publish the legacy VSIX (copilot-token-tracker) ──────────────────
if (-not [string]::IsNullOrWhiteSpace($LegacyVsixPath) -and (Test-Path $LegacyVsixPath)) {
    Write-Host "`nPublishing $LegacyVsixPath to the VS Code Marketplace (legacy ID)..." -ForegroundColor Cyan
    npx vsce publish --packagePath $LegacyVsixPath --pat $pat
    if ($LASTEXITCODE -eq 0) {
        Write-Host "✅ Legacy extension published successfully!" -ForegroundColor Green
    } else {
        Write-Host "⚠️  Legacy VSIX publish failed — primary was already published. Check errors above." -ForegroundColor Yellow
    }
} else {
    Write-Host "⚠️  Skipping legacy VSIX publish (not found)." -ForegroundColor Yellow
}

Write-Host ""
Write-Host "It may take a few minutes to appear in the marketplace." -ForegroundColor Gray
Write-Host ""
Write-Host "📝 Commit and push the updated CHANGELOG.md:" -ForegroundColor Cyan
Write-Host "   git add CHANGELOG.md" -ForegroundColor Gray
Write-Host "   git commit -m 'chore: sync changelog for $expectedTag'" -ForegroundColor Gray
Write-Host "   git push" -ForegroundColor Gray
