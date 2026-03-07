# Ensures host directories used as devcontainer bind mounts exist before Docker tries to mount them.
# If "Code - Insiders" is not installed, we create an empty directory so the mount succeeds;
# the extension then falls back to the always-present "Code" (stable) data automatically.

# ── Detect which VS Code edition launched this devcontainer ──────────────────
$launchedFrom = "Unknown"

# $env:VSCODE_PID is set by VS Code in its integrated terminal / task runner.
# Use it to look up the executable path of the launching process.
if ($env:VSCODE_PID) {
    try {
        $vsProc = Get-Process -Id $env:VSCODE_PID -ErrorAction Stop
        $exePath = $vsProc.MainModule.FileName
        if ($exePath -match 'Insiders') {
            $launchedFrom = "Code - Insiders"
        } else {
            $launchedFrom = "Code"
        }
        Write-Host "Detected VS Code edition from PID $($env:VSCODE_PID): $launchedFrom ($exePath)"
    } catch {
        Write-Host "Could not resolve VSCODE_PID $($env:VSCODE_PID): $_"
    }
}

# Fallback: scan running processes for Code/Code-Insiders executables
if ($launchedFrom -eq "Unknown") {
    $insidersRunning = Get-Process -ErrorAction SilentlyContinue |
        Where-Object { try { $_.MainModule.FileName -match 'Code.*Insiders' } catch { $false } } |
        Select-Object -First 1

    $stableRunning = Get-Process -ErrorAction SilentlyContinue |
        Where-Object { try { $_.MainModule.FileName -match '\\Code\\' } catch { $false } } |
        Select-Object -First 1

    if ($insidersRunning) {
        $launchedFrom = "Code - Insiders (detected from running process)"
    } elseif ($stableRunning) {
        $launchedFrom = "Code (detected from running process)"
    } else {
        $launchedFrom = "Could not detect (no Code process found; defaulting to stable)"
    }
    Write-Host "VS Code edition (fallback detection): $launchedFrom"
}

$activeSubPath = if ($launchedFrom -match 'Insiders') { "Code - Insiders\User" } else { "Code\User" }
$activePath = Join-Path $env:APPDATA $activeSubPath
Write-Host "Active VS Code session data: $activePath"

# ── Ensure both mount source directories exist ───────────────────────────────
$stablePath  = Join-Path $env:APPDATA "Code\User"
$insidersPath = Join-Path $env:APPDATA "Code - Insiders\User"

foreach ($entry in @(
    @{ Path = $stablePath;   Label = "Code (stable)" },
    @{ Path = $insidersPath; Label = "Code - Insiders" }
)) {
    if (-not (Test-Path $entry.Path)) {
        Write-Host "$($entry.Label) not found at '$($entry.Path)'. Creating empty directory so the bind mount does not fail."
        New-Item -ItemType Directory -Force $entry.Path | Out-Null
    } else {
        $marker = if ($entry.Path -eq $activePath) { " ← active" } else { "" }
        Write-Host "$($entry.Label) found at '$($entry.Path)'.$marker"
    }
}
