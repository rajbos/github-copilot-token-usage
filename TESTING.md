# Testing Progressive Loading for Diagnostics View

## What Changed

The diagnostics view now loads progressively:
1. **Before**: The diagnostics panel would not appear until ALL data was loaded (report generation, session file scanning, folder analysis, backend info). This could take 10-30+ seconds on systems with many session files.
2. **After**: The diagnostics panel appears immediately with a "Loading..." message, and data is loaded in the background and progressively updates the UI as it becomes available.

## How to Test

### Prerequisites
1. Open this project in VS Code
2. Press F5 to launch Extension Development Host
3. Wait for the extension to activate

### Test Steps

#### Test 1: Initial Load (First Open)
1. In the Extension Development Host, open the Command Palette (Ctrl+Shift+P / Cmd+Shift+P)
2. Run command: `Copilot Token Tracker: Generate Diagnostic Report`
3. **Expected Result**: 
   - The diagnostics panel should appear **immediately** (within 1 second)
   - The "Report" tab should show a loading message: "⏳ Loading diagnostic data..."
   - Within a few seconds (depending on session files), the report should update with actual data
   - The session folders table should appear
   - The "Session Files" tab count should update when detailed files are loaded

#### Test 2: Reopening Existing Panel
1. Close the diagnostics panel (X button)
2. Run the command again: `Copilot Token Tracker: Generate Diagnostic Report`
3. **Expected Result**: Same as Test 1 - immediate panel appearance with loading state

#### Test 3: Panel Already Open
1. With the diagnostics panel open and data loaded
2. Run the command again: `Copilot Token Tracker: Generate Diagnostic Report`
3. **Expected Result**: 
   - Panel should come to front immediately
   - Data should refresh in the background

#### Test 4: Copy Report During/After Loading
1. Open the diagnostics report
2. Immediately click "Copy to Clipboard" button (before data finishes loading)
3. **Expected Result**: Should copy whatever data is available (or empty if nothing loaded yet)
4. Wait for data to load completely
5. Click "Copy to Clipboard" again
6. **Expected Result**: Should copy the full diagnostic report

#### Test 5: Multiple Session Files (Performance)
1. If you have many GitHub Copilot session files (50+ files in `chatSessions` folders)
   - Typical locations:
     - Windows: `%APPDATA%\Code\User\workspaceStorage\*/chatSessions`
     - macOS: `~/Library/Application Support/Code/User/workspaceStorage/*/chatSessions`
     - Linux: `~/.config/Code/User/workspaceStorage/*/chatSessions`
   - You can check file count in the diagnostics report after it loads
2. Open the diagnostics report
3. **Expected Result**: 
   - Panel appears immediately
   - Loading message appears
   - Report text updates when ready
   - Session files table shows loading spinner initially
   - Session files populate progressively (may take 10-30 seconds for 500 files)

### Success Criteria

✅ Diagnostics panel appears within 1 second of running the command
✅ Loading message is visible before data loads
✅ Report text updates automatically when data is ready
✅ Session folders table appears when data is ready
✅ Session files table updates when background loading completes
✅ No console errors in Developer Tools
✅ Copy and other functions work correctly after data loads

### Observing the Loading Process

To see the loading process in action:
1. Open the Developer Tools in the Extension Development Host:
   - Help > Toggle Developer Tools
2. Go to the Console tab
3. Run the diagnostic report command
4. Look for log messages:
   - "🔍 Opening Diagnostic Report"
   - "✅ Diagnostic Report panel created"
   - "🔄 Loading diagnostic data in background..."
   - "✅ Diagnostic data loaded and sent to webview"

### Known Limitations

- If you close the panel while data is loading, the background loading will be aborted
- Copy/Issue functions will only work after the report text has loaded
- Session files will show a loading spinner until all files are analyzed (this is the slowest part)
