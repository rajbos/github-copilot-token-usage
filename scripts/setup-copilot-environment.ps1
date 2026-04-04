#!/usr/bin/env pwsh
<#
.SYNOPSIS
    Configure the GitHub repository's 'copilot' environment with Azure Storage credentials
    for the Copilot Coding Agent to download session logs and aggregated usage data.

.DESCRIPTION
    This script:
    1. Retrieves the Azure Storage account key using the Azure CLI
    2. Creates the 'copilot' environment on the GitHub repository (if needed)
    3. Sets the required environment variables and secrets using the GitHub CLI

.PARAMETER StorageAccount
    The name of your Azure Storage account.

.PARAMETER Repository
    The GitHub repository in 'owner/repo' format. Defaults to the current repo detected by gh.

.PARAMETER DatasetId
    The dataset identifier used by the extension (default: 'default').

.PARAMETER ContainerName
    The blob container name for session logs (default: 'copilot-session-logs').

.PARAMETER TableName
    The Azure Table Storage table name (default: 'usageAggDaily').

.PARAMETER TableDataDays
    Number of days of aggregated data to download (default: '30').

.EXAMPLE
    ./scripts/setup-copilot-environment.ps1 -StorageAccount "mycopilotusage"

.EXAMPLE
    ./scripts/setup-copilot-environment.ps1 -StorageAccount "mycopilotusage" -Repository "myorg/myrepo"
#>

param(
    [Parameter(Mandatory = $true)]
    [string]$StorageAccount,

    [Parameter(Mandatory = $false)]
    [string]$Repository,

    [Parameter(Mandatory = $false)]
    [string]$DatasetId = "default",

    [Parameter(Mandatory = $false)]
    [string]$ContainerName = "copilot-session-logs",

    [Parameter(Mandatory = $false)]
    [string]$TableName = "usageAggDaily",

    [Parameter(Mandatory = $false)]
    [string]$TableDataDays = "30"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# --- Pre-flight checks ---

function Test-Command([string]$Name) {
    $null -ne (Get-Command $Name -ErrorAction SilentlyContinue)
}

if (-not (Test-Command "az")) {
    Write-Error "Azure CLI (az) is required. Install from https://aka.ms/install-azure-cli"
}

if (-not (Test-Command "gh")) {
    Write-Error "GitHub CLI (gh) is required. Install from https://cli.github.com/"
}

# Verify Azure CLI is logged in
Write-Host "Checking Azure CLI authentication..." -ForegroundColor Cyan
$azAccount = az account show --output json 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Error "Not logged into Azure CLI. Run 'az login' first."
}
$account = $azAccount | ConvertFrom-Json
Write-Host "  Signed in as: $($account.user.name) (subscription: $($account.name))" -ForegroundColor Green

# Verify GitHub CLI is logged in
Write-Host "Checking GitHub CLI authentication..." -ForegroundColor Cyan
$ghStatus = gh auth status 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Error "Not logged into GitHub CLI. Run 'gh auth login' first."
}

# Detect repository if not provided
if (-not $Repository) {
    Write-Host "Detecting repository from git remote..." -ForegroundColor Cyan
    $Repository = gh repo view --json nameWithOwner --jq ".nameWithOwner" 2>&1
    if ($LASTEXITCODE -ne 0 -or -not $Repository) {
        Write-Error "Could not detect repository. Provide -Repository 'owner/repo' explicitly."
    }
}
Write-Host "  Repository: $Repository" -ForegroundColor Green

# --- Step 1: Get Storage Account Key ---

Write-Host ""
Write-Host "Step 1: Retrieving storage account key for '$StorageAccount'..." -ForegroundColor Cyan

$keyJson = az storage account keys list --account-name $StorageAccount --query "[0].value" --output tsv 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Error "Failed to retrieve storage account key. Ensure '$StorageAccount' exists and you have access.`n$keyJson"
}
$storageKey = $keyJson.Trim()
Write-Host "  Storage key retrieved successfully." -ForegroundColor Green

# --- Step 2: Set environment variables ---

Write-Host ""
Write-Host "Step 2: Configuring 'copilot' environment on $Repository..." -ForegroundColor Cyan

# Set environment variables (non-sensitive)
$variables = @{
    "COPILOT_STORAGE_ACCOUNT" = $StorageAccount
    "COPILOT_STORAGE_CONTAINER" = $ContainerName
    "COPILOT_DATASET_ID"       = $DatasetId
    "COPILOT_TABLE_NAME"       = $TableName
    "COPILOT_TABLE_DATA_DAYS"  = $TableDataDays
}

foreach ($kv in $variables.GetEnumerator()) {
    Write-Host "  Setting variable: $($kv.Key) = $($kv.Value)" -ForegroundColor Gray
    gh variable set $kv.Key --body $kv.Value --repo $Repository --env copilot 2>&1
    if ($LASTEXITCODE -ne 0) {
        Write-Warning "Failed to set variable $($kv.Key). The 'copilot' environment may need to be created first in the repo settings."
    }
}

# Set secret (sensitive)
Write-Host "  Setting secret: COPILOT_STORAGE_KEY" -ForegroundColor Gray
$storageKey | gh secret set COPILOT_STORAGE_KEY --repo $Repository --env copilot 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Warning "Failed to set secret COPILOT_STORAGE_KEY."
}

# --- Step 3: Verify ---

Write-Host ""
Write-Host "Step 3: Verifying configuration..." -ForegroundColor Cyan

$envVars = gh variable list --repo $Repository --env copilot --json name --jq ".[].name" 2>&1
if ($LASTEXITCODE -eq 0) {
    Write-Host "  Environment variables set:" -ForegroundColor Green
    foreach ($v in ($envVars -split "`n")) {
        if ($v.Trim()) { Write-Host "    - $($v.Trim())" -ForegroundColor Green }
    }
} else {
    Write-Warning "Could not list environment variables. Verify manually in repo settings."
}

$envSecrets = gh secret list --repo $Repository --env copilot --json name --jq ".[].name" 2>&1
if ($LASTEXITCODE -eq 0) {
    Write-Host "  Secrets set:" -ForegroundColor Green
    foreach ($s in ($envSecrets -split "`n")) {
        if ($s.Trim()) { Write-Host "    - $($s.Trim())" -ForegroundColor Green }
    }
} else {
    Write-Warning "Could not list secrets. Verify manually in repo settings."
}

# --- Done ---

Write-Host ""
Write-Host "Done! The 'copilot' environment on $Repository is configured." -ForegroundColor Green
Write-Host ""
Write-Host "Next steps:" -ForegroundColor Yellow
Write-Host "  1. Trigger the workflow to test: Actions > Copilot Setup Steps > Run workflow" -ForegroundColor Yellow
Write-Host "  2. Verify session logs download in the workflow run logs" -ForegroundColor Yellow
Write-Host "  3. Verify aggregated data downloads in the workflow run logs" -ForegroundColor Yellow
Write-Host ""
Write-Host "For more details, see docs/BLOB-UPLOAD-QUICKSTART.md" -ForegroundColor Gray
