# Copilot CLI Session Log Format Changes

## Overview

The GitHub Copilot CLI has changed its session storage format. This document describes the changes and their impact on the Copilot Token Tracker extension.

## Date of Change

The format change was observed in early 2026 (exact date unknown, detected February 2026).

## Format Changes

### Old Format (Before 2026)

Copilot CLI session files contained full JSONL (JSON Lines) data with complete conversation history:

**File Examples:**
- `copilot.cli.workspaceSessions.*.json`
- `copilot.cli.oldGlobalSessions.json`

**Content Format:**
```jsonl
{"type":"user.message","timestamp":"2024-01-01T12:00:00Z","data":{"content":"How do I create a React component?"}}
{"type":"assistant.message","timestamp":"2024-01-01T12:00:05Z","data":{"content":"Here's how to create a React component..."}}
{"type":"tool.result","timestamp":"2024-01-01T12:00:10Z","data":{"tool":"search","result":"..."}}
```

**Characteristics:**
- Multiple lines, each containing a valid JSON object
- Each line represents an event (user message, assistant response, tool result)
- Contains full conversation history with timestamps
- Can be parsed line-by-line with `JSON.parse()`

### New Format (2026+)

Copilot CLI session files now contain only a session identifier:

**File Examples:**
- `copilot.cli.workspaceSessions.*.json`
- `copilot.cli.oldGlobalSessions.json`

**Content Format:**
```
e62ba546-5a3f-4c1a-9b2c-8d4e6f7g8h9i
```

**Characteristics:**
- Single line containing only a UUID (session ID)
- No JSON structure
- No conversation data
- Cannot be parsed with `JSON.parse()` (will throw SyntaxError)

## Impact on Extension

### Error Symptoms

When the extension encountered these new format files (before the fix), it logged warnings like:

```
[11:02:34 PM] WARNING: Error analyzing session file details for C:\Users\RobBos\AppData\Roaming\Code\User\globalStorage\github.copilot-chat\copilot.cli.workspaceSessions.423f810e-e0a8-445f-9516-841fe1c446dc.json: SyntaxError: Unexpected token 'e', "e62ba546-5"... is not valid JSON

[11:02:35 PM] WARNING: Error analyzing session file details for C:\Users\RobBos\AppData\Roaming\Code\User\globalStorage\github.copilot-chat\copilot.cli.oldGlobalSessions.json: SyntaxError: Unexpected token 'a', "afcac95b-3"... is not valid JSON
```

### Code Locations (Before Fix)

The errors occurred in `src/extension.ts` in multiple methods that parse session files:

1. **getSessionFileDetails()** - Line ~3668: `JSON.parse(fileContent)` 
2. **countInteractionsInSession()** - Line ~1938: `JSON.parse(fileContent)`
3. **getModelUsageFromSession()** - Line ~2069: `JSON.parse(fileContent)`
4. **trackEnhancedMetrics()** - Line ~2613: Attempted to parse as JSONL
5. **estimateTokensFromSession()** - Line ~4446: `JSON.parse(fileContent)`
6. **showFormattedJsonlFile()** - Line ~5092: `JSON.parse(lines[i])`
7. **getSessionLogData()** - Line ~3782: Attempted to parse as JSONL

### Behavior Before Fix

- Extension attempted to parse the UUID string as JSON
- JSON.parse() threw a SyntaxError
- Error was caught and logged as a warning
- Session file was skipped (returned empty details with 0 interactions)
- No crash or data corruption

## Fix Implementation

### Detection Helper Method

A reusable helper method was added to detect UUID-only files:

```typescript
/**
 * Check if file content is a UUID-only pointer file (new Copilot CLI format).
 * These files contain only a session ID instead of actual session data.
 * @param content The file content to check
 * @returns true if the content is a UUID-only pointer file
 */
private isUuidPointerFile(content: string): boolean {
    const trimmedContent = content.trim();
    return /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(trimmedContent);
}
```

This helper method (line ~4608) centralizes the UUID detection logic, making it easier to maintain and update.

### Usage Pattern

All methods that read session files now use this helper:

```typescript
// Check if this is a UUID-only file (new Copilot CLI format)
if (this.isUuidPointerFile(fileContent)) {
    // Skip parsing and return appropriate empty value
    return;
}
```

### Changes Made

The UUID detection was added to all 7 methods that read session files:

1. **getSessionFileDetails()** (line ~3543)
   - Returns empty details with 0 interactions
   
2. **getSessionLogData()** (line ~3806)
   - Returns complete SessionLogData structure with empty turns
   
3. **countInteractionsInSession()** (line ~1912)
   - Returns 0 (no interactions)
   
4. **getModelUsageFromSession()** (line ~1971)
   - Returns empty ModelUsage object
   
5. **trackEnhancedMetrics()** (line ~2617)
   - Returns early (no metrics to track)
   
6. **estimateTokensFromSession()** (line ~4442)
   - Returns 0 (no tokens to estimate)
   
7. **showFormattedJsonlFile()** (line ~5090)
   - Shows informational message to user explaining the new format

### Behavior After Fix

- UUID-only files are detected before parsing attempts
- No warnings or errors are logged
- Files are silently skipped with appropriate empty/zero values
- No impact on other session file formats
- Backwards compatible with old JSONL format

## Likely Reason for Change

The Copilot CLI likely moved to a new architecture where:

1. **Session Index Files**: The `.json` files now act as session pointers/indexes
2. **Separate Data Store**: Actual session data is stored elsewhere (possibly in a database, binary format, or encrypted storage)
3. **Benefits**:
   - Better performance (don't need to parse large JSON files)
   - Better security (session data not stored in plain text)
   - More efficient storage and retrieval
   - Easier session management and cleanup

## Where is the Actual Data?

The actual session data is likely stored in one of these locations:

1. **Local Database**: SQLite or similar (e.g., `~/.copilot/sessions.db`)
2. **Cloud Storage**: Synced with GitHub servers
3. **Binary Format**: Custom binary format in `~/.copilot/` directory
4. **Encrypted Store**: Encrypted local storage

**Action Needed**: Further investigation required to locate the actual session data storage.

## Recommendations

### For Extension Users

- These files will now be silently skipped - no warnings will appear
- No action required - the extension continues to work with other session file formats
- Copilot CLI token usage will not be tracked until the new data store is located

### For Extension Developers

1. ✅ **Detection**: UUID-only files are now detected before parsing
2. ✅ **Skip Gracefully**: These files are skipped without logging errors
3. ⏳ **Future Enhancement**: If the new data store location is discovered, add support for reading it
4. ✅ **Backwards Compatibility**: Old JSONL format is still fully supported

## Testing

### UUID Detection Tests

The UUID regex has been tested with:
- Valid UUIDs (lowercase, uppercase, mixed)
- Invalid UUIDs (wrong characters, wrong format)
- JSON content
- Plain text
- Content with whitespace/newlines (properly trimmed)

All tests pass successfully.

### Compilation

- ✅ TypeScript compilation successful
- ✅ ESLint validation passed
- ✅ No type errors

## Related Files

- `src/extension.ts` - Main parsing logic (7 methods updated)
- `docs/SESSION-LOG-FORMATS.md` - General session log format documentation (if exists)

## References

- GitHub Copilot CLI documentation (if available)
- VS Code Copilot extension session storage paths
- Issue reports from users experiencing the SyntaxError warnings
