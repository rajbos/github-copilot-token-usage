# capture-screenshots.ps1
# Win32 screenshot capture helper — called by scripts/pre-release.js on Windows.
# Launches VS Code Extension Development Host with the screenshots workspace,
# captures all required panel screenshots, then prompts to close the host.
#
# Parameters are supplied by the Node.js pre-release script; you can also invoke
# this script standalone for testing:
#
#   .\scripts\capture-screenshots.ps1 `
#       -ExtensionPath   "C:\path\to\repo" `
#       -ImagesOutputPath "C:\path\to\repo\docs\images"

param(
    [string]$ExtensionPath    = $PSScriptRoot + "\..",
    [string]$ImagesOutputPath = $PSScriptRoot + "\..\docs\images",
    [int]$VsCodeStartupWait   = 8,   # seconds to wait for VS Code to fully load
    [int]$PanelRenderWait     = 4    # seconds to wait after opening each panel
)

$ErrorActionPreference = "Stop"

# Resolve to absolute paths
$ExtensionPath    = (Resolve-Path $ExtensionPath).Path
$ImagesOutputPath = (Resolve-Path $ImagesOutputPath -ErrorAction SilentlyContinue)?.Path
if (-not $ImagesOutputPath) {
    $ImagesOutputPath = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath(
        (Join-Path $ExtensionPath "docs\images"))
    New-Item -ItemType Directory -Path $ImagesOutputPath -Force | Out-Null
}

$ScreenshotsWorkspace = Join-Path $ExtensionPath "screenshots"

# ─── Helpers ────────────────────────────────────────────────────────────────

function Write-Ok([string]$Message)   { Write-Host "   ✅ $Message" -ForegroundColor Green }
function Write-Warn([string]$Message) { Write-Host "   ⚠️  $Message" -ForegroundColor Yellow }
function Write-Note([string]$Message) { Write-Host "   ℹ️  $Message" -ForegroundColor Gray }

# ─── Load Win32 APIs ────────────────────────────────────────────────────────
# Only bare P/Invoke signatures — no generics, no Drawing types.
# Higher-level logic (window enumeration, capture) is done in PowerShell so
# that .NET type-forwarding issues on .NET 6+ don't affect compilation.

$win32Code = @"
using System;
using System.Runtime.InteropServices;

public class Win32 {
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left, Top, Right, Bottom; }
}
"@

try {
    Add-Type -TypeDefinition $win32Code
    Add-Type -AssemblyName "System.Drawing"
    Add-Type -AssemblyName "System.Windows.Forms"
} catch {
    Write-Warn "Could not load Win32 screenshot helper: $_"
    Write-Warn "Install .NET Desktop Runtime if System.Drawing is missing."
    exit 1
}

# ─── PowerShell wrappers for Win32 helpers ──────────────────────────────────

function Find-WindowsWithTitle([string]$Title) {
    # Use the Process API instead of EnumWindows to avoid delegate/GC issues.
    return @(Get-Process -Name "Code" -ErrorAction SilentlyContinue |
        Where-Object { $_.MainWindowTitle -like "*$Title*" } |
        Select-Object -ExpandProperty MainWindowHandle |
        Where-Object { $_ -ne [IntPtr]::Zero })
}

function Invoke-CaptureWindow([IntPtr]$hWnd, [string]$FilePath) {
    if ([Win32]::IsIconic($hWnd)) { [Win32]::ShowWindow($hWnd, 9) | Out-Null }  # SW_RESTORE
    $rect = New-Object Win32+RECT
    [Win32]::GetWindowRect($hWnd, [ref]$rect) | Out-Null
    $w = $rect.Right  - $rect.Left
    $h = $rect.Bottom - $rect.Top
    $bmp = New-Object System.Drawing.Bitmap($w, $h)
    $g   = [System.Drawing.Graphics]::FromImage($bmp)
    try {
        $g.CopyFromScreen($rect.Left, $rect.Top, 0, 0, (New-Object System.Drawing.Size($w, $h)))
        $bmp.Save($FilePath, [System.Drawing.Imaging.ImageFormat]::Png)
    } finally {
        $g.Dispose()
        $bmp.Dispose()
    }
}


# ─── Wait for Extension Development Host ────────────────────────────────────

Write-Host ""
Write-Host "   👉 Press F5 in your current VS Code window to launch the Extension Development Host." -ForegroundColor Cyan
Write-Host "      Then switch back here and press Enter to continue." -ForegroundColor Cyan
Read-Host "   Press Enter when the Extension Development Host is ready"

Write-Note "Looking for Extension Development Host window..."

# Poll for up to $VsCodeStartupWait seconds in case it's still loading
$deadline = (Get-Date).AddSeconds($VsCodeStartupWait)
$hwnd = [IntPtr]::Zero
do {
    $found = Find-WindowsWithTitle "Extension Development Host"
    if ($found.Count -gt 0) { $hwnd = $found[0]; break }
    Start-Sleep -Seconds 1
} while ((Get-Date) -lt $deadline)

if ($hwnd -eq [IntPtr]::Zero) {
    Write-Warn "Could not find an Extension Development Host window."
    Write-Warn "Make sure you pressed F5 in VS Code and the host finished loading."
    exit 1
}
Write-Ok "Found Extension Development Host window (handle: $hwnd)"

Write-Note "Waiting $PanelRenderWait more seconds for the extension to fully initialize..."
Start-Sleep -Seconds $PanelRenderWait

# ─── Window helpers ─────────────────────────────────────────────────────────

function Get-DevHostWindow {
    $w = Find-WindowsWithTitle "Extension Development Host"
    if ($w.Count -gt 0) { return $w[0] }
    return [IntPtr]::Zero
}

function Invoke-PanelScreenshot {
    param(
        [IntPtr]$Window,
        [string]$CommandName,
        [string]$OutputFile,
        [string]$Label
    )
    Write-Note "Opening panel: $Label"
    [Win32]::SetForegroundWindow($Window) | Out-Null
    Start-Sleep -Milliseconds 500

    [System.Windows.Forms.SendKeys]::SendWait("^+p")   # Ctrl+Shift+P
    Start-Sleep -Milliseconds 800
    [System.Windows.Forms.SendKeys]::SendWait("^a")    # select all existing text
    Start-Sleep -Milliseconds 200
    [System.Windows.Forms.SendKeys]::SendWait($CommandName)
    Start-Sleep -Milliseconds 1000
    [System.Windows.Forms.SendKeys]::SendWait("{ENTER}")
    Start-Sleep -Seconds $PanelRenderWait

    $w = Get-DevHostWindow
    if ($w -ne [IntPtr]::Zero) { $Window = $w }

    Invoke-CaptureWindow $Window $OutputFile
    Write-Ok "Screenshot saved: $(Split-Path $OutputFile -Leaf)"
}

# ─── Capture screenshots ─────────────────────────────────────────────────────

# ── 01: Status bar (full window) ─────────────────────────────────────────────
Write-Note "Taking full window screenshot for status bar reference (01 Toolbar info)"
[Win32]::SetForegroundWindow($hwnd) | Out-Null
Start-Sleep -Milliseconds 800
Invoke-CaptureWindow $hwnd (Join-Path $ImagesOutputPath "01 Toolbar info.png")
Write-Ok "Screenshot saved: 01 Toolbar info.png"

# ── 02: Hover popup ───────────────────────────────────────────────────────────
Write-Note "Attempting status bar hover screenshot (02 Popup)"
[Win32]::SetForegroundWindow($hwnd) | Out-Null
Start-Sleep -Milliseconds 500

try {
    $rect = New-Object Win32+RECT
    [Win32]::GetWindowRect($hwnd, [ref]$rect) | Out-Null
    # Status bar is at the very bottom; token tracker is right-aligned.
    # Aim for ~85% from left, 12px from bottom.
    $targetX = [int]($rect.Left + ($rect.Right - $rect.Left) * 0.85)
    $targetY = [int]($rect.Bottom - 12)
    [Win32]::SetCursorPos($targetX, $targetY) | Out-Null
    Write-Note "Mouse moved to status bar area ($targetX, $targetY) — waiting for tooltip..."
    Start-Sleep -Seconds 3
    Invoke-CaptureWindow $hwnd (Join-Path $ImagesOutputPath "02 Popup.png")
    Write-Ok "Screenshot saved: 02 Popup.png"
} catch {
    Write-Warn "Could not capture status bar hover screenshot: $_"
    Write-Warn "Update '02 Popup.png' manually if needed."
}

# ── 03: Details panel ────────────────────────────────────────────────────────
Invoke-PanelScreenshot -Window $hwnd `
    -CommandName "Show Token Usage Details" `
    -OutputFile  (Join-Path $ImagesOutputPath "03 Detail panel.png") `
    -Label       "Details Panel"

$hwnd = Get-DevHostWindow

# ── 04: Chart view (by model — default) ──────────────────────────────────────
Invoke-PanelScreenshot -Window $hwnd `
    -CommandName "Show Token Usage Chart" `
    -OutputFile  (Join-Path $ImagesOutputPath "04 Chart.png") `
    -Label       "Chart View (by model)"

# ── 04 Chart_02: Chart view (by editor) ──────────────────────────────────────
$hwnd = Get-DevHostWindow
Write-Note "Attempting to switch chart to 'by editor' view for 04 Chart_02.png..."
Write-Note "(Click position is approximate — verify the screenshot manually.)"

try {
    if ($hwnd -ne [IntPtr]::Zero) {
        $rect = New-Object Win32+RECT
        [Win32]::GetWindowRect($hwnd, [ref]$rect) | Out-Null
        [Win32]::SetForegroundWindow($hwnd) | Out-Null
        Start-Sleep -Milliseconds 500

        # Approximate position of "By Editor" button: ~30% from left, ~15% from top
        $btnX = [int]($rect.Left + ($rect.Right - $rect.Left) * 0.30)
        $btnY = [int]($rect.Top  + ($rect.Bottom - $rect.Top) * 0.15)

        [System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point($btnX, $btnY)
        Start-Sleep -Milliseconds 300

        $mouseSig = '[DllImport("user32.dll")] public static extern void mouse_event(uint f, int x, int y, uint d, int e);'
        if (-not ([System.Management.Automation.PSTypeName]'MouseClick').Type) {
            Add-Type -MemberDefinition $mouseSig -Name 'MouseClick' -Namespace ''
        }
        [MouseClick]::mouse_event(2, 0, 0, 0, 0)   # MOUSEEVENTF_LEFTDOWN
        Start-Sleep -Milliseconds 100
        [MouseClick]::mouse_event(4, 0, 0, 0, 0)   # MOUSEEVENTF_LEFTUP
        Start-Sleep -Seconds $PanelRenderWait

        Invoke-CaptureWindow $hwnd (Join-Path $ImagesOutputPath "04 Chart_02.png")
        Write-Ok "Screenshot saved: 04 Chart_02.png"
        Write-Note "Verify this screenshot — the click position is approximate."
    }
} catch {
    Write-Warn "Could not auto-capture 04 Chart_02.png: $_"
    Write-Warn "Open the Chart panel, switch to 'By Editor', and take a screenshot manually."
}

# ─── Summary ─────────────────────────────────────────────────────────────────

Write-Host ""
Write-Host "   📸 Screenshot capture complete!" -ForegroundColor Green
Write-Host ""
Write-Host "   Manual review checklist:" -ForegroundColor Cyan
Write-Host "   - [ ] 01 Toolbar info.png  — status bar shows token counts"  -ForegroundColor Gray
Write-Host "   - [ ] 02 Popup.png         — hover tooltip shows breakdown"  -ForegroundColor Gray
Write-Host "   - [ ] 03 Detail panel.png  — details panel looks correct"    -ForegroundColor Gray
Write-Host "   - [ ] 04 Chart.png         — chart by model renders correctly" -ForegroundColor Gray
Write-Host "   - [ ] 04 Chart_02.png      — chart by editor (verify manually)" -ForegroundColor Gray
Write-Host ""

# ─── Close dev host ──────────────────────────────────────────────────────────

$closeConfirm = Read-Host "   Close the VS Code Extension Development Host? [y/N]"
if ($closeConfirm -in @('y', 'Y', 'yes', 'Yes')) {
    $procs = Get-Process -Name "Code" -ErrorAction SilentlyContinue |
        Where-Object { $_.MainWindowTitle -like "*Extension Development Host*" }
    if ($procs) {
        $procs | Stop-Process -Force
        Write-Ok "Extension Development Host closed"
    }
}
