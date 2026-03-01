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
# EnumWindows is included so we can scan all top-level windows directly,
# which is necessary for Electron/VS Code whose helper processes often have
# empty MainWindowHandle in Get-Process output.

$win32Code = @"
using System;
using System.Runtime.InteropServices;
using System.Text;

public class Win32 {
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
    [DllImport("user32.dll")] public static extern int  GetWindowText(IntPtr hWnd, StringBuilder sb, int n);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern IntPtr GetWindowDC(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern int   ReleaseDC(IntPtr hWnd, IntPtr hDC);
    [DllImport("user32.dll")] public static extern bool  PrintWindow(IntPtr hWnd, IntPtr hdcBlt, uint nFlags);
    [DllImport("gdi32.dll")]  public static extern IntPtr CreateCompatibleDC(IntPtr hDC);
    [DllImport("gdi32.dll")]  public static extern IntPtr CreateCompatibleBitmap(IntPtr hDC, int w, int h);
    [DllImport("gdi32.dll")]  public static extern IntPtr SelectObject(IntPtr hDC, IntPtr hObj);
    [DllImport("gdi32.dll")]  public static extern bool   DeleteDC(IntPtr hDC);
    [DllImport("gdi32.dll")]  public static extern bool   DeleteObject(IntPtr hObj);
    [DllImport("dwmapi.dll")] public static extern int    DwmGetWindowAttribute(IntPtr hWnd, int attr, out RECT pv, int cb);
    [DllImport("user32.dll")] public static extern void   mouse_event(uint dwFlags, uint dx, uint dy, uint cButtons, IntPtr dwExtraInfo);

    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

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

# Script-scoped state for the EnumWindows callback (prevents GC of the delegate).
$script:_enumFoundWindows = [System.Collections.ArrayList]::new()
$script:_enumSearchTitle  = ""
$script:_enumCallback     = [Win32+EnumWindowsProc]{
    param([IntPtr]$hWnd, [IntPtr]$lParam)
    if ([Win32]::IsWindowVisible($hWnd)) {
        $sb = [System.Text.StringBuilder]::new(256)
        [Win32]::GetWindowText($hWnd, $sb, 256) | Out-Null
        $t = $sb.ToString()
        if ($t -ne "" -and $t -like "*$script:_enumSearchTitle*") {
            $script:_enumFoundWindows.Add($hWnd) | Out-Null
        }
    }
    return $true
}

function Find-WindowsWithTitle([string]$Title) {
    $script:_enumFoundWindows.Clear()
    $script:_enumSearchTitle = $Title
    [Win32]::EnumWindows($script:_enumCallback, [IntPtr]::Zero) | Out-Null
    return @($script:_enumFoundWindows)
}

function Invoke-CaptureWindow([IntPtr]$hWnd, [string]$FilePath) {
    if ([Win32]::IsIconic($hWnd)) { [Win32]::ShowWindow($hWnd, 9) | Out-Null }  # SW_RESTORE

    # DWMWA_EXTENDED_FRAME_BOUNDS (9) returns the physical pixel rect of the window,
    # bypassing all DPI virtualization — reliable on any scaling factor.
    $rect = New-Object Win32+RECT
    [Win32]::DwmGetWindowAttribute($hWnd, 9, [ref]$rect, [System.Runtime.InteropServices.Marshal]::SizeOf($rect)) | Out-Null
    $w = $rect.Right  - $rect.Left
    $h = $rect.Bottom - $rect.Top

    # PrintWindow with PW_RENDERFULLCONTENT (0x2) asks the window to render itself
    # into our DC — works for Electron/hardware-accelerated windows, DPI-independent.
    $hDC       = [Win32]::GetWindowDC($hWnd)
    $hCompatDC = [Win32]::CreateCompatibleDC($hDC)
    $hBitmap   = [Win32]::CreateCompatibleBitmap($hDC, $w, $h)
    $hOld      = [Win32]::SelectObject($hCompatDC, $hBitmap)
    try {
        [Win32]::PrintWindow($hWnd, $hCompatDC, 2) | Out-Null  # 2 = PW_RENDERFULLCONTENT
        $bmp = [System.Drawing.Image]::FromHbitmap($hBitmap)
        try { $bmp.Save($FilePath, [System.Drawing.Imaging.ImageFormat]::Png) }
        finally { $bmp.Dispose() }
    } finally {
        [Win32]::SelectObject($hCompatDC, $hOld) | Out-Null
        [Win32]::DeleteDC($hCompatDC) | Out-Null
        [Win32]::DeleteObject($hBitmap) | Out-Null
        [Win32]::ReleaseDC($hWnd, $hDC) | Out-Null
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
    Write-Note "Visible top-level windows (EnumWindows):"
    Find-WindowsWithTitle "" | ForEach-Object {
        $sb = [System.Text.StringBuilder]::new(256)
        [Win32]::GetWindowText($_, $sb, 256) | Out-Null
        Write-Note "  $($sb.ToString())"
    }
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

function Invoke-VsCodeCommand([IntPtr]$Window, [string]$CommandId) {
    [Win32]::SetForegroundWindow($Window) | Out-Null
    Start-Sleep -Milliseconds 200
    [System.Windows.Forms.SendKeys]::SendWait("{ESC}")
    Start-Sleep -Milliseconds 200
    [System.Windows.Forms.SendKeys]::SendWait("^+p")
    Start-Sleep -Milliseconds 700
    [System.Windows.Forms.SendKeys]::SendWait($CommandId)
    Start-Sleep -Milliseconds 700
    [System.Windows.Forms.SendKeys]::SendWait("{ENTER}")
    Start-Sleep -Milliseconds 400
}

function Close-AllEditors([IntPtr]$Window) {
    # Close all editor tabs
    Invoke-VsCodeCommand $Window "workbench.action.closeAllEditors"
    # Close bottom panel (terminal/output/etc.) — closePanel is a no-op if already hidden
    Invoke-VsCodeCommand $Window "workbench.action.closePanel"
}

function Invoke-PanelScreenshot {
    param(
        [IntPtr]$Window,
        [string]$CommandName,
        [string]$OutputFile,
        [string]$Label
    )
    Write-Note "Opening panel: $Label"
    Close-AllEditors $Window
    [Win32]::SetForegroundWindow($Window) | Out-Null
    Start-Sleep -Milliseconds 300

    [System.Windows.Forms.SendKeys]::SendWait("{ESC}")  # close any open palette/menu first
    Start-Sleep -Milliseconds 300
    [System.Windows.Forms.SendKeys]::SendWait("^+p")   # Ctrl+Shift+P — opens fresh palette with "> "
    Start-Sleep -Milliseconds 800
    # Palette opens with "> " and cursor at end — type the command name directly.
    [System.Windows.Forms.SendKeys]::SendWait($CommandName)
    Start-Sleep -Milliseconds 1200
    [System.Windows.Forms.SendKeys]::SendWait("{ENTER}")
    Start-Sleep -Seconds $PanelRenderWait

    $w = Get-DevHostWindow
    if ($w -ne [IntPtr]::Zero) { $Window = $w }

    Invoke-CaptureWindow $Window $OutputFile
    Write-Ok "Screenshot saved: $(Split-Path $OutputFile -Leaf)"
}

# ─── Capture screenshots ─────────────────────────────────────────────────────

# Reset webview zoom to 100% so all screenshots start from a consistent baseline.
Write-Note "Resetting zoom to 100%..."
[Win32]::SetForegroundWindow($hwnd) | Out-Null
Start-Sleep -Milliseconds 200
Invoke-VsCodeCommand $hwnd "workbench.action.zoomReset"

# ── 01: Status bar strip ─────────────────────────────────────────────────────
Write-Note "Closing all editors and panels before screenshots..."
Close-AllEditors $hwnd

# ── 01: Status bar strip ─────────────────────────────────────────────────────
Write-Note "Taking status bar strip screenshot (01 Toolbar info)"
[Win32]::SetForegroundWindow($hwnd) | Out-Null
Start-Sleep -Milliseconds 800

# Capture only the right ~40% of the status bar (where our extension sits).
# Use GetWindowRect for bitmap dimensions (matches what PrintWindow actually renders).
# DwmGetWindowAttribute gives the visible content rect — we derive scale from it.
$dwmRect = New-Object Win32+RECT
[Win32]::DwmGetWindowAttribute($hwnd, 9, [ref]$dwmRect,
    [System.Runtime.InteropServices.Marshal]::SizeOf($dwmRect)) | Out-Null
$logicalRect = New-Object Win32+RECT
[Win32]::GetWindowRect($hwnd, [ref]$logicalRect) | Out-Null
$logH  = $logicalRect.Bottom - $logicalRect.Top
$dwmH  = $dwmRect.Bottom - $dwmRect.Top
$scale = if ($logH -gt 0) { $dwmH / $logH } else { 1.0 }

# PrintWindow bitmap size comes from GetWindowRect physical pixels
$fullW = [int](($logicalRect.Right  - $logicalRect.Left) * $scale)
$fullH = [int](($logicalRect.Bottom - $logicalRect.Top)  * $scale)

$statusBarH = 22   # VS Code status bar height in logical pixels
$physBarH = [int](($statusBarH + 4) * $scale)   # +4px safety margin for border/shadow

# Crop: right 26.4% of window (= 66% of previous 40%), bottom $physBarH rows
$cropX = [int]($fullW * 0.736)
$cropY = $fullH - $physBarH
$cropW = $fullW - $cropX
$cropH = $physBarH

# Full PrintWindow capture then crop
$hDC       = [Win32]::GetWindowDC($hwnd)
$hCompatDC = [Win32]::CreateCompatibleDC($hDC)
$hBitmap   = [Win32]::CreateCompatibleBitmap($hDC, $fullW, $fullH)
$hOld      = [Win32]::SelectObject($hCompatDC, $hBitmap)
[Win32]::PrintWindow($hwnd, $hCompatDC, 2) | Out-Null  # PW_RENDERFULLCONTENT
$fullBmp = [System.Drawing.Image]::FromHbitmap($hBitmap)
[Win32]::SelectObject($hCompatDC, $hOld) | Out-Null
[Win32]::DeleteDC($hCompatDC) | Out-Null
[Win32]::DeleteObject($hBitmap) | Out-Null
[Win32]::ReleaseDC($hwnd, $hDC) | Out-Null

$cropBmp = New-Object System.Drawing.Bitmap($cropW, $cropH)
$g = [System.Drawing.Graphics]::FromImage($cropBmp)
try {
    $srcRect  = New-Object System.Drawing.Rectangle($cropX, $cropY, $cropW, $cropH)
    $destRect = New-Object System.Drawing.Rectangle(0, 0, $cropW, $cropH)
    $g.DrawImage($fullBmp, $destRect, $srcRect, [System.Drawing.GraphicsUnit]::Pixel)
    $cropBmp.Save((Join-Path $ImagesOutputPath "01 Toolbar info.png"),
        [System.Drawing.Imaging.ImageFormat]::Png)
} finally {
    $g.Dispose(); $cropBmp.Dispose(); $fullBmp.Dispose()
}
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

    # Crop: right 40% of window, bottom 35% of height (covers status bar + tooltip above it)
    # Use GetWindowRect for bitmap size to match what PrintWindow actually renders.
    $logRect2 = New-Object Win32+RECT
    [Win32]::GetWindowRect($hwnd, [ref]$logRect2) | Out-Null
    $dwmRect2 = New-Object Win32+RECT
    [Win32]::DwmGetWindowAttribute($hwnd, 9, [ref]$dwmRect2,
        [System.Runtime.InteropServices.Marshal]::SizeOf($dwmRect2)) | Out-Null
    $scale2 = if (($logRect2.Bottom - $logRect2.Top) -gt 0) {
        ($dwmRect2.Bottom - $dwmRect2.Top) / ($logRect2.Bottom - $logRect2.Top) } else { 1.0 }
    $fw = [int](($logRect2.Right  - $logRect2.Left) * $scale2)
    $fh = [int](($logRect2.Bottom - $logRect2.Top)  * $scale2)

    $hDC2       = [Win32]::GetWindowDC($hwnd)
    $hCompatDC2 = [Win32]::CreateCompatibleDC($hDC2)
    $hBitmap2   = [Win32]::CreateCompatibleBitmap($hDC2, $fw, $fh)
    $hOld2      = [Win32]::SelectObject($hCompatDC2, $hBitmap2)
    [Win32]::PrintWindow($hwnd, $hCompatDC2, 2) | Out-Null
    $fullBmp2 = [System.Drawing.Image]::FromHbitmap($hBitmap2)
    [Win32]::SelectObject($hCompatDC2, $hOld2) | Out-Null
    [Win32]::DeleteDC($hCompatDC2) | Out-Null
    [Win32]::DeleteObject($hBitmap2) | Out-Null
    [Win32]::ReleaseDC($hwnd, $hDC2) | Out-Null

    $p2CropX = [int]($fw * 0.736)
    $p2CropH = [int]($fh * 0.35) + [int](4 * $scale2)   # +4px safety margin
    $p2CropY = $fh - $p2CropH
    if ($p2CropY -lt 0) { $p2CropY = 0; $p2CropH = $fh }
    $p2CropW = $fw - $p2CropX

    $cropBmp2 = New-Object System.Drawing.Bitmap($p2CropW, $p2CropH)
    $g2 = [System.Drawing.Graphics]::FromImage($cropBmp2)
    try {
        $srcRect2  = New-Object System.Drawing.Rectangle($p2CropX, $p2CropY, $p2CropW, $p2CropH)
        $destRect2 = New-Object System.Drawing.Rectangle(0, 0, $p2CropW, $p2CropH)
        $g2.DrawImage($fullBmp2, $destRect2, $srcRect2, [System.Drawing.GraphicsUnit]::Pixel)
        $cropBmp2.Save((Join-Path $ImagesOutputPath "02 Popup.png"),
            [System.Drawing.Imaging.ImageFormat]::Png)
    } finally {
        $g2.Dispose(); $cropBmp2.Dispose(); $fullBmp2.Dispose()
    }
    Write-Ok "Screenshot saved: 02 Popup.png"
} catch {
    Write-Warn "Could not capture status bar hover screenshot: $_"
    Write-Warn "Update '02 Popup.png' manually if needed."
}

# ── 03: Details panel ────────────────────────────────────────────────────────
Invoke-PanelScreenshot -Window $hwnd `
    -CommandName "Copilot Token Tracker: Show Token Usage Details" `
    -OutputFile  (Join-Path $ImagesOutputPath "03 Detail panel.png") `
    -Label       "Details Panel"

$hwnd = Get-DevHostWindow

# ── 04: Chart view (by model — default) ──────────────────────────────────────
Invoke-PanelScreenshot -Window $hwnd `
    -CommandName "Copilot Token Tracker: Show Token Usage Chart" `
    -OutputFile  (Join-Path $ImagesOutputPath "04 Chart.png") `
    -Label       "Chart View (by model)"

# ── 04 Chart_02: Chart view (by model) ───────────────────────────────────────
$hwnd = Get-DevHostWindow
Write-Note "Re-opening chart panel and switching to 'By Model' view for 04 Chart_02.png..."

try {
    if ($hwnd -ne [IntPtr]::Zero) {
        Close-AllEditors $hwnd
        # Re-open the chart panel via command palette so it gets fresh keyboard focus,
        # then immediately Tab to "By Model" (second toggle button) before anything else
        # can grab focus.
        [Win32]::SetForegroundWindow($hwnd) | Out-Null
        Start-Sleep -Milliseconds 300
        [System.Windows.Forms.SendKeys]::SendWait("{ESC}")
        Start-Sleep -Milliseconds 200
        [System.Windows.Forms.SendKeys]::SendWait("^+p")
        Start-Sleep -Milliseconds 800
        [System.Windows.Forms.SendKeys]::SendWait("Copilot Token Tracker: Show Token Usage Chart")
        Start-Sleep -Milliseconds 1200
        [System.Windows.Forms.SendKeys]::SendWait("{ENTER}")
        Start-Sleep -Seconds $PanelRenderWait

        # Getting keyboard focus INTO a VS Code webview's DOM requires a physical click
        # inside the webview content area. We click at 25% of the window height from the
        # DWM rect top — this reliably lands in the summary/cards section, which is
        # non-interactive (plain divs), so the click just transfers DOM focus to body.
        # At 35% the toggle buttons start (confirmed empirically), so 25% is safely above.
        $cfR = New-Object Win32+RECT
        [Win32]::DwmGetWindowAttribute($hwnd, 9, [ref]$cfR,
            [System.Runtime.InteropServices.Marshal]::SizeOf($cfR)) | Out-Null
        $cfX = $cfR.Left + [int](($cfR.Right  - $cfR.Left) / 2)
        $cfY = $cfR.Top  + [int](($cfR.Bottom - $cfR.Top ) * 0.25)
        [Win32]::SetForegroundWindow($hwnd) | Out-Null
        Start-Sleep -Milliseconds 300
        [Win32]::SetCursorPos($cfX, $cfY) | Out-Null
        Start-Sleep -Milliseconds 150
        [Win32]::mouse_event(0x02, 0, 0, 0, [IntPtr]::Zero)
        Start-Sleep -Milliseconds 50
        [Win32]::mouse_event(0x04, 0, 0, 0, [IntPtr]::Zero)
        Start-Sleep -Milliseconds 400

        # Tab from wherever the click landed focus to "By Model".
        # The click at 25% height lands near the toggle row, so only a couple
        # of tabs are needed: view-total(1) → view-model(2).
        foreach ($_ in 1..2) {
            [System.Windows.Forms.SendKeys]::SendWait("{TAB}")
            Start-Sleep -Milliseconds 150
        }
        [System.Windows.Forms.SendKeys]::SendWait("{ENTER}")
        Start-Sleep -Seconds $PanelRenderWait

        $hwnd = Get-DevHostWindow
        Invoke-CaptureWindow $hwnd (Join-Path $ImagesOutputPath "04 Chart_02.png")
        Write-Ok "Screenshot saved: 04 Chart_02.png"
    }
} catch {
    Write-Warn "Could not auto-capture 04 Chart_02.png: $_"
    Write-Warn "Open the Chart panel, switch to 'By Model', and take a screenshot manually."
}

# ── 05: Fluency Score panel ───────────────────────────────────────────────────
$hwnd = Get-DevHostWindow
Write-Note "Opening Fluency Score panel..."
Close-AllEditors $hwnd
[Win32]::SetForegroundWindow($hwnd) | Out-Null
Start-Sleep -Milliseconds 300
[System.Windows.Forms.SendKeys]::SendWait("{ESC}")
Start-Sleep -Milliseconds 300
[System.Windows.Forms.SendKeys]::SendWait("^+p")
Start-Sleep -Milliseconds 800
[System.Windows.Forms.SendKeys]::SendWait("Copilot Token Tracker: Show Copilot Fluency Score")
Start-Sleep -Milliseconds 1200
[System.Windows.Forms.SendKeys]::SendWait("{ENTER}")
Start-Sleep -Seconds $PanelRenderWait

# Zoom out twice so more of the fluency dashboard is visible in the screenshot.
Write-Note "Zooming out fluency panel twice..."
[System.Windows.Forms.SendKeys]::SendWait("^-")
Start-Sleep -Milliseconds 300
[System.Windows.Forms.SendKeys]::SendWait("^-")
Start-Sleep -Milliseconds 500

$hwnd = Get-DevHostWindow
Invoke-CaptureWindow $hwnd (Join-Path $ImagesOutputPath "05 Fluency Score.png")
Write-Ok "Screenshot saved: 05 Fluency Score.png"

# Reset zoom back to 100% after the fluency screenshot.
Invoke-VsCodeCommand $hwnd "workbench.action.zoomReset"

# ─── Summary ─────────────────────────────────────────────────────────────────

Write-Host ""
Write-Host "   📸 Screenshot capture complete!" -ForegroundColor Green
Write-Host ""
Write-Host "   Manual review checklist:" -ForegroundColor Cyan
Write-Host "   - [ ] 01 Toolbar info.png  — status bar shows token counts"  -ForegroundColor Gray
Write-Host "   - [ ] 02 Popup.png         — hover tooltip shows breakdown"  -ForegroundColor Gray
Write-Host "   - [ ] 03 Detail panel.png  — details panel looks correct"    -ForegroundColor Gray
Write-Host "   - [ ] 04 Chart.png         — chart by model renders correctly" -ForegroundColor Gray
Write-Host "   - [ ] 04 Chart_02.png      — chart by model (verify manually)"  -ForegroundColor Gray
Write-Host "   - [ ] 05 Fluency Score.png — fluency score dashboard looks correct" -ForegroundColor Gray
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
