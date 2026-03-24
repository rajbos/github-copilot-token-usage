# Debugging the Extension - Zero Token Count Issue

## How to View Logs

1. **Press F5** to start debugging (or use the experimental instance if already running)
2. In the experimental instance:
   - Go to **View > Output** (or press `Ctrl+Alt+O`)
   - In the dropdown **"Show output from:"**, select **"Copilot Token Tracker"**

## What the Logs Will Tell You

When the toolbar shows "0 | 0", check these log entries:

### 1. Extension Initialization
```
[HH:mm:ss] === Copilot Token Tracker Extension Starting ===
[HH:mm:ss] Package GUID: 6B8CA5B3-1A9F-4C2E-8F3D-7E2A1B4C9D0F
[HH:mm:ss] Initializing commands...
[HH:mm:ss] === Extension Initialized Successfully ===
```
✅ **Good**: Extension loaded properly

### 2. Session Discovery
```
[HH:mm:ss] Refreshing token stats...
[HH:mm:ss] Starting stats build...
[HH:mm:ss] Discovering sessions from logs...
[HH:mm:ss] Checking log directory: C:\Users\[username]\AppData\Local\Temp\VSGitHubCopilotLogs
[HH:mm:ss] Found X log files
[HH:mm:ss] Found Y sessions from logs
```

**Possible Issues:**
- ❌ **"Log directory not found"**: Visual Studio hasn't created Copilot Chat logs yet
- ❌ **"Found 0 log files"**: No recent Copilot Chat activity
- ❌ **"Found 0 sessions from logs"**: Log files don't contain session paths

### 3. Filesystem Discovery
```
[HH:mm:ss] Discovering sessions from filesystem...
[HH:mm:ss] Scanning filesystem starting from home: C:\Users\[username]
[HH:mm:ss] Added scan root: C:\repos
[HH:mm:ss] Added scan root: C:\code
[HH:mm:ss] Found copilot-chat dir: C:\path\to\.vs\solution\copilot-chat
[HH:mm:ss] Found Z session files in: C:\path\to\.vs\solution\copilot-chat\hash\sessions
[HH:mm:ss] Found N additional sessions from filesystem
```

**Possible Issues:**
- ❌ **No "Found copilot-chat dir" messages**: No Visual Studio solutions with Copilot Chat usage
- ❌ **"Found 0 session files"**: The sessions directory exists but is empty

### 4. Stats Aggregation
```
[HH:mm:ss] Discovered M session files
[HH:mm:ss] Successfully parsed P sessions
[HH:mm:ss] Stats aggregated - Today: 1,234, Last30Days: 45,678
[HH:mm:ss] Stats updated: Today=1234, Last30Days=45678
```

**Possible Issues:**
- ❌ **"Discovered 0 session files"**: No sessions found anywhere
- ❌ **"Successfully parsed 0 sessions"**: Session files exist but couldn't be parsed (wrong format/corrupted)
- ❌ **"Today: 0, Last30Days: 0"**: Sessions parsed but all are older than 30 days OR token data missing

## Common Causes of "0 | 0"

### 1. Never Used Visual Studio Copilot Chat
The extension only tracks **Visual Studio Copilot Chat** sessions, not VS Code or GitHub.com.

**Solution**: Use Copilot Chat in Visual Studio at least once:
- Open Copilot Chat pane: **View > Copilot Chat**
- Ask a question
- Wait 5 minutes for the extension to refresh stats

### 2. Session Files in Unexpected Location
The extension looks for session files in:
- Log path: `%LOCALAPPDATA%\Temp\VSGitHubCopilotLogs\*.chat.log`
- Filesystem: `.vs\{solution}\copilot-chat\{hash}\sessions\`

**Solution**: Check the log output to see what paths it's scanning and compare with where your session files actually are.

### 3. Old Session Files
If all your Copilot Chat usage is older than 30 days, both "Today" and "Last30Days" will be zero.

**Solution**: Use Copilot Chat in the current Visual Studio session.

### 4. Parsing Failures
Session files might exist but fail to parse (format changes, corruption, etc.).

**Solution**: Look for ERROR messages in the logs about parsing failures.

## Next Steps

After reviewing the logs, you'll know:
1. ✅ Are session files being discovered?
2. ✅ Are they being parsed successfully?
3. ✅ Are they within the 30-day window?
4. ✅ Do they contain token usage data?

Share the relevant log entries and I can help debug further!
