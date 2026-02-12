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

When the extension encounters these new format files, it logs warnings like:

```
[11:02:34 PM] WARNING: Error analyzing session file details for C:\Users\RobBos\AppData\Roaming\Code\User\globalStorage\github.copilot-chat\copilot.cli.workspaceSessions.423f810e-e0a8-445f-9516-841fe1c446dc.json: SyntaxError: Unexpected token 'e', "e62ba546-5"... is not valid JSON

[11:02:35 PM] WARNING: Error analyzing session file details for C:\Users\RobBos\AppData\Roaming\Code\User\globalStorage\github.copilot-chat\copilot.cli.oldGlobalSessions.json: SyntaxError: Unexpected token 'a', "afcac95b-3"... is not valid JSON
```

### Code Location

The errors occur in `src/extension.ts` in the `getSessionFileDetails()` method:

1. **Line 3668**: `JSON.parse(fileContent)` - Attempts to parse regular JSON
2. **Line 3624**: `JSON.parse(line)` - Attempts to parse JSONL line-by-line
3. **Line 3740**: Error is caught and logged as a warning

### Current Behavior

- Extension attempts to parse the UUID string as JSON
- JSON.parse() throws a SyntaxError
- Error is caught and logged as a warning
- Session file is skipped (returns empty details with 0 interactions)
- No crash or data corruption

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

- These warnings are harmless - they indicate files that can't be parsed but don't affect functionality
- No action required - the extension continues to work with other session file formats

### For Extension Developers

1. **Detection**: Add logic to detect UUID-only files before attempting JSON parsing
2. **Skip Gracefully**: Skip these files without logging errors
3. **Future Enhancement**: If the new data store location is discovered, add support for reading it
4. **Backwards Compatibility**: Keep support for old JSONL format (some users may have old files)

## Detection Logic

To detect UUID-only files:

```typescript
// Check if content is just a UUID (no JSON structure)
const trimmedContent = fileContent.trim();
const isUuidOnly = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(trimmedContent);

if (isUuidOnly) {
    // This is a session ID pointer file, not actual session data
    // Skip parsing and return empty details
    return details;
}
```

## Testing

To test the fix, create test files in the format:

```bash
# Create new format file (UUID only)
echo "e62ba546-5a3f-4c1a-9b2c-8d4e6f7g8h9i" > test-uuid.json

# Create old format file (JSONL)
echo '{"type":"user.message","timestamp":"2024-01-01T12:00:00Z"}' > test-jsonl.jsonl
```

The extension should:
- Skip the UUID-only file without errors
- Parse the JSONL file normally

## Related Files

- `src/extension.ts` - Main parsing logic
- `docs/SESSION-LOG-FORMATS.md` - General session log format documentation

## References

- GitHub Copilot CLI documentation (if available)
- VS Code Copilot extension session storage paths
