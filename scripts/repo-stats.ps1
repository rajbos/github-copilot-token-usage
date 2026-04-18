<#
.SYNOPSIS
    Calculates repository statistics: file counts, lines of code, file sizes, and disk usage.

.DESCRIPTION
    Scans the repository (excluding common build/dependency directories) and reports:
    - Total number of tracked files
    - Number of code files vs documentation files
    - Lines of actual code (docs excluded)
    - Average and max code file size in lines
    - Size on disk (total and code-only)

    Documentation files (markdown, txt, license files) are counted separately from code.

.PARAMETER Path
    Root path of the repository. Defaults to the parent of the script's directory.

.EXAMPLE
    ./scripts/repo-stats.ps1
#>
[CmdletBinding()]
param(
    [string]$Path = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
)

$ErrorActionPreference = 'Stop'

# Directories to exclude from the scan (build artifacts, deps, VCS internals).
$excludeDirs = @(
    'node_modules', 'dist', 'out', 'bin', 'obj', '.git', '.vs', '.vscode-test',
    'coverage', '.nyc_output', 'packages', '.next', '.turbo', 'TestResults'
)

# Relative path fragments to exclude (generated/bundled webview output committed to the repo).
$excludePathFragments = @(
    'visualstudio-extension/src/CopilotTokenTracker/webview',
    'visualstudio-extension\src\CopilotTokenTracker\webview'
)

# File names to exclude (lockfiles etc. that aren't hand-written code).
$excludeFileNames = @('package-lock.json', 'yarn.lock', 'pnpm-lock.yaml')

# File extensions considered "documentation" (excluded from code stats).
$docExtensions = @('.md', '.markdown', '.txt', '.rst', '.adoc')

# Files considered documentation by name (no extension or generic names).
$docFileNames = @('LICENSE', 'NOTICE', 'COPYING', 'AUTHORS', 'CHANGELOG')

# Directories whose contents are always treated as documentation.
$docDirs = @('docs', 'doc', 'documentation')

# File extensions considered "code" for LOC counting.
$codeExtensions = @(
    '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
    '.cs', '.csx', '.vb', '.fs',
    '.ps1', '.psm1', '.psd1',
    '.py', '.rb', '.go', '.rs', '.java', '.kt',
    '.c', '.cpp', '.cc', '.h', '.hpp',
    '.html', '.css', '.scss', '.less',
    '.json', '.yaml', '.yml', '.xml',
    '.sh', '.bash',
    '.sql'
)

function Test-ExcludedPath {
    param([string]$FullPath, [string]$Root)
    $rel = $FullPath.Substring($Root.Length).TrimStart('\','/')
    $parts = $rel -split '[\\/]'
    foreach ($p in $parts) {
        if ($excludeDirs -contains $p) { return $true }
    }
    $relNorm = $rel -replace '\\','/'
    foreach ($frag in $excludePathFragments) {
        $fragNorm = $frag -replace '\\','/'
        if ($relNorm -like "$fragNorm*") { return $true }
    }
    return $false
}

# Detects minified / bundled files by sampling avg line length.
# Minified JS/CSS typically has very long lines (few line breaks).
function Test-IsMinified {
    param([System.IO.FileInfo]$File)
    if ($File.Name -match '\.min\.(js|css|mjs)$') { return $true }
    if ($File.Length -lt 10KB) { return $false }
    $ext = $File.Extension.ToLowerInvariant()
    if ($ext -notin '.js', '.mjs', '.cjs', '.css') { return $false }
    try {
        $content = Get-Content -LiteralPath $File.FullName -Raw -ErrorAction Stop
        $lineCount = ($content -split "`n").Count
        if ($lineCount -le 0) { return $false }
        $avgLineLen = $content.Length / $lineCount
        return ($avgLineLen -gt 500)
    } catch {
        return $false
    }
}

function Get-FileCategory {
    param([System.IO.FileInfo]$File, [string]$Root)
    $ext = $File.Extension.ToLowerInvariant()
    $base = $File.BaseName.ToUpperInvariant()
    $nameUpper = $File.Name.ToUpperInvariant()

    $rel = $File.FullName.Substring($Root.Length).TrimStart('\','/')
    $firstSeg = ($rel -split '[\\/]')[0].ToLowerInvariant()
    if ($docDirs -contains $firstSeg) { return 'doc' }

    if ($excludeFileNames -contains $File.Name) { return 'other' }
    if (Test-IsMinified -File $File) { return 'other' }

    if ($docExtensions -contains $ext) { return 'doc' }
    if ($docFileNames -contains $base) { return 'doc' }
    if ($docFileNames -contains $nameUpper) { return 'doc' }
    if ($codeExtensions -contains $ext) { return 'code' }
    return 'other'
}

Write-Host "Scanning: $Path" -ForegroundColor Cyan

$allFiles = Get-ChildItem -Path $Path -Recurse -File -Force |
    Where-Object { -not (Test-ExcludedPath -FullPath $_.FullName -Root $Path) }

$codeFiles = @()
$docFiles = @()
$otherFiles = @()

foreach ($f in $allFiles) {
    switch (Get-FileCategory -File $f -Root $Path) {
        'code' { $codeFiles += $f }
        'doc'  { $docFiles += $f }
        default { $otherFiles += $f }
    }
}

# Count lines of code per file (non-empty lines).
$codeStats = foreach ($f in $codeFiles) {
    $lines = 0
    try {
        $lines = (Get-Content -LiteralPath $f.FullName -ErrorAction Stop | Measure-Object -Line).Lines
    } catch {
        $lines = 0
    }
    [PSCustomObject]@{
        Path  = $f.FullName
        Lines = $lines
        Size  = $f.Length
    }
}

$totalLoc    = ($codeStats | Measure-Object -Property Lines -Sum).Sum
$avgLoc      = if ($codeStats.Count -gt 0) { [math]::Round($totalLoc / $codeStats.Count, 1) } else { 0 }
$maxFile     = $codeStats | Sort-Object Lines -Descending | Select-Object -First 1
$sizeBytes   = ($allFiles | Measure-Object -Property Length -Sum).Sum
$codeBytes   = ($codeFiles | Measure-Object -Property Length -Sum).Sum

function Format-Size {
    param([long]$Bytes)
    if ($Bytes -ge 1GB) { return "{0:N2} GB" -f ($Bytes / 1GB) }
    if ($Bytes -ge 1MB) { return "{0:N2} MB" -f ($Bytes / 1MB) }
    if ($Bytes -ge 1KB) { return "{0:N2} KB" -f ($Bytes / 1KB) }
    return "$Bytes B"
}

Write-Host ""
Write-Host "=== Repository Stats ===" -ForegroundColor Green
Write-Host ("Root:              {0}" -f $Path)
Write-Host ("Total files:       {0}" -f $allFiles.Count)
Write-Host ("  Code files:      {0}" -f $codeFiles.Count)
Write-Host ("  Doc files:       {0}" -f $docFiles.Count)
Write-Host ("  Other files:     {0}" -f $otherFiles.Count)
Write-Host ""
Write-Host ("Lines of code:     {0:N0}" -f $totalLoc)
Write-Host ("Avg lines/file:    {0}" -f $avgLoc)
if ($maxFile) {
    $relMax = $maxFile.Path.Substring($Path.Length).TrimStart('\','/')
    Write-Host ("Largest file:      {0} ({1:N0} lines)" -f $relMax, $maxFile.Lines)
}
Write-Host ""
Write-Host ("Size on disk:      {0}" -f (Format-Size $sizeBytes))
Write-Host ("Code-only size:    {0}" -f (Format-Size $codeBytes))
Write-Host ""
Write-Host "Top 5 largest code files by lines:" -ForegroundColor Yellow
$codeStats | Sort-Object Lines -Descending | Select-Object -First 5 | ForEach-Object {
    $rel = $_.Path.Substring($Path.Length).TrimStart('\','/')
    Write-Host ("  {0,6:N0}  {1}" -f $_.Lines, $rel)
}

# Return an object for scripting scenarios.
[PSCustomObject]@{
    TotalFiles    = $allFiles.Count
    CodeFiles     = $codeFiles.Count
    DocFiles      = $docFiles.Count
    OtherFiles    = $otherFiles.Count
    LinesOfCode   = $totalLoc
    AvgLinesPerCodeFile = $avgLoc
    MaxFileLines  = if ($maxFile) { $maxFile.Lines } else { 0 }
    MaxFilePath   = if ($maxFile) { $maxFile.Path } else { $null }
    SizeOnDiskBytes = $sizeBytes
    CodeSizeBytes = $codeBytes
} | Out-Null
