#!/usr/bin/env pwsh
<#
.SYNOPSIS
    Analyzes GitHub Copilot session files to extract and document their schema.

.DESCRIPTION
    This script scans Copilot session files (.json and .jsonl) and extracts:
    - All field names and their types
    - Field frequency (how often they appear)
    - New fields not in existing documentation
    - Sample values, only with -IncludeExamples

    Run this periodically to detect schema changes as Copilot evolves.

    Session files hold your prompts, responses, file paths and pasted content.
    By default no field values are recorded, so the output only describes the
    structure and is safe to commit. The one exception is the list of JSONL
    event type names (e.g. "session.start"), kept only when they look like
    identifiers.

.PARAMETER OutputFile
    Path to output the schema analysis JSON file.
    Default: docs/logFilesSchema/session-file-schema-analysis.json (tracked in git)

.PARAMETER MaxFiles
    Maximum number of files to analyze per location.
    Default: 10

.PARAMETER CompareWithExisting
    Compare with existing schema documentation and highlight new fields.
    Default: $true

.PARAMETER IncludeExamples
    Record up to 3 example values per field (strings truncated to 100
    characters). These are copied verbatim from your session logs, so the
    output can contain private prompt text: write it outside the repository
    and do not commit it. A warning is printed when examples are persisted.

.EXAMPLE
    .\.github\skills\copilot-log-analysis\analyze-session-schema.ps1
    Analyzes session files and writes the value-free schema to the docs folder.

.EXAMPLE
    .\.github\skills\copilot-log-analysis\analyze-session-schema.ps1 -MaxFiles 20 -OutputFile "temp-analysis.json"
    Analyzes up to 20 files and saves to a custom location.

.EXAMPLE
    .\.github\skills\copilot-log-analysis\analyze-session-schema.ps1 -IncludeExamples -OutputFile "$env:TEMP\schema-with-examples.json"
    Includes example values, written outside the repository.
#>

[CmdletBinding()]
param(
    [string]$OutputFile = "docs\logFilesSchema\session-file-schema-analysis.json",
    [int]$MaxFiles = 10,
    [bool]$CompareWithExisting = $true,
    [switch]$IncludeExamples
)

# JSONL event type names are reported even without -IncludeExamples, but only
# values shaped like identifiers, so a free-text "type" can never slip through.
$eventTypePattern = '^[A-Za-z0-9_.\-]{1,64}$'
$maxEventTypes = 50

# Helper function to get type name
function Get-TypeName {
    param($Value)
    
    if ($null -eq $Value) {
        return "null"
    }
    elseif ($Value -is [array]) {
        return "array"
    }
    elseif ($Value -is [PSCustomObject] -or $Value -is [hashtable]) {
        return "object"
    }
    elseif ($Value -is [bool]) {
        return "boolean"
    }
    elseif ($Value -is [int] -or $Value -is [long] -or $Value -is [double]) {
        return "number"
    }
    elseif ($Value -is [string]) {
        return "string"
    }
    else {
        return $Value.GetType().Name
    }
}

# Helper function to extract schema from object
function Get-ObjectSchema {
    param(
        [Parameter(Mandatory)]
        $Object,
        [string]$Path = "",
        [Parameter(Mandatory)]
        [ref]$Schema
    )
    
    if ($Object -is [PSCustomObject] -or $Object -is [hashtable]) {
        foreach ($property in $Object.PSObject.Properties) {
            $fieldPath = if ($Path) { "$Path.$($property.Name)" } else { $property.Name }
            $value = $property.Value
            $typeName = Get-TypeName $value
            
            # Initialize field info if not exists
            if (-not $Schema.Value.ContainsKey($fieldPath)) {
                $Schema.Value[$fieldPath] = @{
                    type = $typeName
                    count = 0
                }
                if ($IncludeExamples) {
                    $Schema.Value[$fieldPath].examples = @()
                }
            }
            
            # Update count
            $Schema.Value[$fieldPath].count++
            
            # Store example (opt-in, limit to 3 examples)
            if ($IncludeExamples -and $Schema.Value[$fieldPath].examples.Count -lt 3) {
                $exampleValue = if ($typeName -eq "string" -and $value.Length -gt 100) {
                    $value.Substring(0, 100) + "..."
                } elseif ($typeName -in @("array", "object")) {
                    if ($value -is [array]) {
                        "[array with $($value.Count) items]"
                    } else {
                        "[object]"
                    }
                } else {
                    $value
                }
                
                if ($Schema.Value[$fieldPath].examples -notcontains $exampleValue) {
                    $Schema.Value[$fieldPath].examples += $exampleValue
                }
            }
            
            # Recursively process objects and arrays
            if ($typeName -eq "object") {
                Get-ObjectSchema -Object $value -Path $fieldPath -Schema $Schema
            }
            elseif ($typeName -eq "array" -and $value.Count -gt 0) {
                # Analyze first few items in array
                $itemsToAnalyze = [Math]::Min(3, $value.Count)
                for ($i = 0; $i -lt $itemsToAnalyze; $i++) {
                    if ($value[$i] -is [PSCustomObject] -or $value[$i] -is [hashtable]) {
                        Get-ObjectSchema -Object $value[$i] -Path "$fieldPath[]" -Schema $Schema
                    }
                }
            }
        }
    }
}

Write-Host "=" * 80
Write-Host "GitHub Copilot Session File Schema Analyzer"
Write-Host "=" * 80
Write-Host ""

# VS Code variants to check
$vscodeVariants = @(
    "Code",               # Stable
    "Code - Insiders",    # Insiders
    "Code - Exploration", # Exploration builds
    "VSCodium",           # VSCodium
    "Cursor"              # Cursor editor
)

# Find session file locations
$locations = @{}

# Add locations for each VS Code variant
foreach ($variant in $vscodeVariants) {
    $variantKey = $variant -replace '\s', '' -replace '-', ''
    $basePath = Join-Path $env:APPDATA "$variant\User"
    
    # Only add if the variant exists
    if (Test-Path $basePath) {
        $locations["workspace-$variantKey"] = @{
            pattern = Join-Path $basePath "workspaceStorage\*\chatSessions\*.json"
            description = "Workspace chat sessions ($variant)"
            files = @()
        }
        
        $locations["global-$variantKey"] = @{
            pattern = Join-Path $basePath "globalStorage\emptyWindowChatSessions\*.json"
            description = "Global chat sessions ($variant)"
            files = @()
        }
        
        $locations["copilot-chat-$variantKey"] = @{
            pattern = Join-Path $basePath "globalStorage\github.copilot-chat\**\*.json"
            description = "Copilot Chat global storage ($variant)"
            files = @()
        }
    }
}

# Add Copilot CLI location (not variant-specific)
$locations["copilot-cli"] = @{
    pattern = Join-Path $env:USERPROFILE ".copilot\session-state\*.jsonl"
    description = "Copilot CLI sessions"
    files = @()
}

# Add OpenCode location
$openCodeDataDir = Join-Path $env:USERPROFILE ".local\share\opencode"
if (Test-Path $openCodeDataDir) {
    $locations["opencode"] = @{
        pattern = Join-Path $openCodeDataDir "storage\session\global\ses_*.json"
        description = "OpenCode sessions"
        files = @()
    }
}

# Collect files
Write-Host "Scanning for session files..."
Write-Host ""

foreach ($locKey in $locations.Keys) {
    $loc = $locations[$locKey]
    $foundFiles = Get-ChildItem -Path $loc.pattern -File -ErrorAction SilentlyContinue | Select-Object -First $MaxFiles
    $loc.files = $foundFiles
    Write-Host "  $($loc.description): Found $($foundFiles.Count) files"
}

Write-Host ""
Write-Host "Analyzing schemas..."
Write-Host ""

# Schema storage
$jsonSchema = @{}
$jsonlSchema = @{}
$jsonFileCount = 0
$jsonlFileCount = 0
$eventTypes = [System.Collections.Generic.List[string]]::new()

# Analyze JSON files (all locations except copilot-cli which is JSONL)
foreach ($locKey in $locations.Keys) {
    if ($locKey -eq "copilot-cli") { continue }
    
    $loc = $locations[$locKey]
    
    foreach ($file in $loc.files) {
        try {
            Write-Host "  Analyzing: $($file.Name)"
            $content = Get-Content $file.FullName -Raw | ConvertFrom-Json
            Get-ObjectSchema -Object $content -Schema ([ref]$jsonSchema) | Out-Null
            $jsonFileCount++
        }
        catch {
            Write-Warning "  Error analyzing $($file.Name): $($_.Exception.GetType().Name)"
        }
    }
}

# Analyze JSONL files
$loc = $locations["copilot-cli"]
foreach ($file in $loc.files) {
    try {
        Write-Host "  Analyzing: $($file.Name)"
        $lines = Get-Content $file.FullName
        
        foreach ($line in $lines) {
            if ($line.Trim()) {
                try {
                    $event = $line | ConvertFrom-Json
                    Get-ObjectSchema -Object $event -Schema ([ref]$jsonlSchema) | Out-Null
                    $eventType = $event.type
                    if ($eventType -is [string] -and $eventType -match $eventTypePattern -and
                        $eventTypes.Count -lt $maxEventTypes -and -not $eventTypes.Contains($eventType)) {
                        $eventTypes.Add($eventType)
                    }
                }
                catch {
                    # Skip malformed lines
                }
            }
        }
        $jsonlFileCount++
    }
    catch {
        Write-Warning "  Error analyzing $($file.Name): $($_.Exception.GetType().Name)"
    }
}

Write-Host ""
Write-Host "Analysis complete!"
Write-Host "  JSON files analyzed: $jsonFileCount"
Write-Host "  JSON fields found: $($jsonSchema.Count)"
Write-Host "  JSONL files analyzed: $jsonlFileCount"
Write-Host "  JSONL fields found: $($jsonlSchema.Count)"
Write-Host ""

# Sort schemas by field path
$jsonSchemaSorted = [ordered]@{}
$jsonSchema.Keys | Sort-Object | ForEach-Object {
    $jsonSchemaSorted[$_] = $jsonSchema[$_]
}

$jsonlSchemaSorted = [ordered]@{}
$jsonlSchema.Keys | Sort-Object | ForEach-Object {
    $jsonlSchemaSorted[$_] = $jsonlSchema[$_]
}

# Load existing schema documentation if comparing
$newJsonFields = @()
$newJsonlFields = @()

if ($CompareWithExisting) {
    $existingSchemaFile = "docs\logFilesSchema\session-file-schema.json"
    if (Test-Path $existingSchemaFile) {
        Write-Host "Comparing with existing schema documentation..."
        try {
            $existingSchema = Get-Content $existingSchemaFile -Raw | ConvertFrom-Json
            
            # Extract known field paths from existing documentation
            $knownJsonFields = @()
            $knownJsonlFields = @()
            
            # This is a simplified check - you might want to enhance this
            # to actually parse the nested schema structure
            $existingSchemaJson = $existingSchema | ConvertTo-Json -Depth 100
            
            foreach ($field in $jsonSchemaSorted.Keys) {
                if (-not $existingSchemaJson.Contains($field)) {
                    $newJsonFields += $field
                }
            }
            
            foreach ($field in $jsonlSchemaSorted.Keys) {
                if (-not $existingSchemaJson.Contains($field)) {
                    $newJsonlFields += $field
                }
            }
            
            if ($newJsonFields.Count -gt 0) {
                Write-Host ""
                Write-Host "  NEW JSON fields detected:" -ForegroundColor Yellow
                $newJsonFields | ForEach-Object { Write-Host "    - $_" -ForegroundColor Yellow }
            }
            
            if ($newJsonlFields.Count -gt 0) {
                Write-Host ""
                Write-Host "  NEW JSONL fields detected:" -ForegroundColor Yellow
                $newJsonlFields | ForEach-Object { Write-Host "    - $_" -ForegroundColor Yellow }
            }
            
            if ($newJsonFields.Count -eq 0 -and $newJsonlFields.Count -eq 0) {
                Write-Host "  No new fields detected." -ForegroundColor Green
            }
            
            Write-Host ""
        }
        catch {
            Write-Warning "Could not compare with existing schema: $_"
        }
    }
}

# Build output document
$output = [ordered]@{
    generatedAt = (Get-Date).ToString("yyyy-MM-ddTHH:mm:ss.fffZ")
    filesAnalyzed = [ordered]@{
        json = $jsonFileCount
        jsonl = $jsonlFileCount
    }
    newFieldsDetected = [ordered]@{
        json = $newJsonFields
        jsonl = $newJsonlFields
    }
    jsonFileSchema = [ordered]@{
        totalFields = $jsonSchemaSorted.Count
        fields = $jsonSchemaSorted
    }
    jsonlFileSchema = [ordered]@{
        totalFields = $jsonlSchemaSorted.Count
        fields = $jsonlSchemaSorted
    }
    topLevelJsonFields = @()
    commonJsonlEventTypes = @()
}

# Extract top-level JSON fields
$output.topLevelJsonFields = $jsonSchemaSorted.Keys | Where-Object { $_ -notlike "*.*" } | Sort-Object

# JSONL event types (identifier-shaped values only, collected during analysis)
$output.commonJsonlEventTypes = @($eventTypes | Sort-Object)

# Save output
$outputDir = Split-Path $OutputFile -Parent
if ($outputDir -and -not (Test-Path $outputDir)) {
    New-Item -ItemType Directory -Path $outputDir -Force | Out-Null
}

$output | ConvertTo-Json -Depth 10 | Set-Content $OutputFile -Encoding UTF8

Write-Host "Schema analysis saved to: $OutputFile" -ForegroundColor Green
if ($IncludeExamples) {
    Write-Warning "Example values copied from your session logs (prompts, titles, file paths) were written to $OutputFile. Review it and do not commit it or share it publicly."
    $repoRoot = if (Get-Command git -ErrorAction SilentlyContinue) { git rev-parse --show-toplevel 2>$null }
    if ($LASTEXITCODE -eq 0 -and $repoRoot) {
        $resolvedOutput = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($OutputFile)
        $resolvedRoot = [System.IO.Path]::GetFullPath($repoRoot)
        if ($resolvedOutput.StartsWith($resolvedRoot + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
            Write-Warning "$OutputFile is inside the git repository at $resolvedRoot. Move it out, or delete it before committing."
        }
    }
}
Write-Host ""
Write-Host "Summary:"
Write-Host "  Top-level JSON fields: $($output.topLevelJsonFields.Count)"
Write-Host "  Total JSON field paths: $($jsonSchemaSorted.Count)"
Write-Host "  Total JSONL field paths: $($jsonlSchemaSorted.Count)"
Write-Host ""

# Display top-level fields
Write-Host "Top-level JSON fields found:"
foreach ($field in $output.topLevelJsonFields) {
    $info = $jsonSchemaSorted[$field]
    Write-Host "  - $field [$($info.type)] (seen $($info.count) times)"
}

Write-Host ""
Write-Host "Done!"
