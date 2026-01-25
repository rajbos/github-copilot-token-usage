---
name: copilot-log-analysis
description: Analyzing GitHub Copilot session log files to extract token usage, model info, and interaction data. Use when working with session files or debugging token tracking.
---

# Copilot Log Analysis Skill

This skill documents the methods and approaches used by the GitHub Copilot Token Tracker extension to analyze Copilot session log files. These files contain chat sessions, token usage, and model information.

## Overview

The extension analyzes two types of log files:
- **`.json` files**: Standard VS Code Copilot Chat session files
- **`.jsonl` files**: Copilot CLI/Agent mode sessions (one JSON event per line)

## Session File Discovery

### Key Method: `getCopilotSessionFiles()`
**Location**: `src/extension.ts` (lines 905-1017)
**Helper Methods**: `getVSCodeUserPaths()` (lines 860-903), `scanDirectoryForSessionFiles()` (lines 1020-1045)

This method discovers session files across all VS Code variants and locations:

**Supported VS Code Variants:**
- VS Code (Stable)
- VS Code Insiders
- VS Code Exploration
- VSCodium
- Cursor
- VS Code Server/Remote

**File Locations Checked:**

1. **Workspace Storage**: `{VSCode User Path}/workspaceStorage/{workspace-id}/chatSessions/*.json`
2. **Global Storage (Legacy)**: `{VSCode User Path}/globalStorage/emptyWindowChatSessions/*.json`
3. **Copilot Chat Extension Storage**: `{VSCode User Path}/globalStorage/github.copilot-chat/**/*.json`
4. **Copilot CLI Sessions**: `~/.copilot/session-state/*.jsonl`

**Platform-Specific Paths:**
- **Windows**: `%APPDATA%/{Variant}/User`
- **macOS**: `~/Library/Application Support/{Variant}/User`
- **Linux**: `~/.config/{Variant}/User` (respects `XDG_CONFIG_HOME`)
- **Remote/Server**: `~/.vscode-server/data/User`, `~/.vscode-server-insiders/data/User`

### Helper Method: `getVSCodeUserPaths()`
**Location**: `src/extension.ts` (lines 860-903)

Returns all possible VS Code user data paths for different variants and platforms.

### Helper Method: `scanDirectoryForSessionFiles()`
**Location**: `src/extension.ts` (lines 1020-1045)

Recursively scans directories for `.json` and `.jsonl` session files.

## Field Extraction Methods

### 1. Token Estimation: `estimateTokensFromSession()`
**Location**: `src/extension.ts` (lines 1047-1088)

**Purpose**: Estimates total tokens used in a session by analyzing message content.

**How it works:**
1. Reads session file content
2. Dispatches to format-specific handler:
   - `.jsonl` files → `estimateTokensFromJsonlSession()` (lines 1094-1121)
   - `.json` files → analyzes `requests` array

**For JSON files:**
- **Input tokens**: Extracted from `requests[].message.parts[].text`
- **Output tokens**: Extracted from `requests[].response[].value`
- Uses model-specific character-to-token ratios from `tokenEstimators.json`

**For JSONL files:**
- Processes line-by-line JSON events
- **Copilot CLI format** (uses `type` field):
  - **User messages**: `type: 'user.message'`, field: `data.content`
  - **Assistant messages**: `type: 'assistant.message'`, field: `data.content`
  - **Tool results**: `type: 'tool.result'`, field: `data.output`
- **VS Code Incremental format** (uses `kind` field):
  - **User requests**: `kind: 1`, field: `request.message.parts[].text`
  - **Assistant responses**: `kind: 2`, field: `response[].value`, `model`

### 2. Interaction Counting: `countInteractionsInSession()`
**Location**: `src/extension.ts` (lines 615-651)

**Purpose**: Counts the number of user interactions in a session.

**How it works:**

**For JSON files:**
- Counts items in `requests` array
- Each request = one user interaction

**For JSONL files:**
- **Copilot CLI format**: Counts events with `type: 'user.message'`
- **VS Code Incremental format**: Counts events with `kind: 1`
- Processes line-by-line, skipping malformed lines
- **Note**: Sessions with 0 interactions (empty `requests: []` or no `kind: 1` entries) are filtered out in diagnostics view

### 3. Model Usage Extraction: `getModelUsageFromSession()`
**Location**: `src/extension.ts` (lines 653-729)

**Purpose**: Extracts per-model token usage (input vs output).

**How it works:**

**For JSON files:**
- Iterates through `requests` array
- Determines model using `getModelFromRequest()` helper (lines 1123-1145)
- Tracks input tokens from `message.parts[].text`
- Tracks output tokens from `response[].value`

**For JSONL files (Copilot CLI format):**
- Default model: `gpt-4o` (for CLI sessions)
- Reads `event.model` if specified
- Categorizes by event type:
  - `user.message` → input tokens
  - `assistant.message` → output tokens
  - `tool.result` → input tokens (context)

**For JSONL files (VS Code Incremental format):**
- Reads `model` field from `kind: 2` response entries
- Categorizes by kind:
  - `kind: 1` → input tokens (from `request.message.parts[].text`)
  - `kind: 2` → output tokens (from `response[].value`)

**Model Detection Logic**: `getModelFromRequest()`
- Primary: `request.result.metadata.modelId`
- Fallback: Parse `request.result.details` string for model names
- Detected patterns (defined in code lines 1129-1143):
  - OpenAI: GPT-3.5-Turbo, GPT-4, GPT-4.1, GPT-4o, GPT-4o-mini, GPT-5, o3-mini, o4-mini
  - Anthropic: Claude Sonnet 3.5, Claude Sonnet 3.7, Claude Sonnet 4
  - Google: Gemini 2.5 Pro, Gemini 3 Pro (Preview), Gemini 3 Pro
  - Default fallback: gpt-4

**Note**: The display name mapping in `getModelDisplayName()` includes additional model variants (GPT-5 family, Claude Haiku, Claude Opus, Gemini 3 Flash, Grok, Raptor) that may appear if specified via `metadata.modelId` but are not pattern-matched from `result.details`.

### 4. Editor Type Detection: `getEditorTypeFromPath()`
**Location**: `src/extension.ts` (lines 111-143)

**Purpose**: Determines which VS Code variant created the session file.

**Detection patterns:**
- Contains `/.copilot/session-state/` → `'Copilot CLI'`
- Contains `/code - insiders/` → `'VS Code Insiders'`
- Contains `/code - exploration/` → `'VS Code Exploration'`
- Contains `/vscodium/` → `'VSCodium'`
- Contains `/cursor/` → `'Cursor'`
- Contains `.vscode-server-insiders/` → `'VS Code Server (Insiders)'`
- Contains `.vscode-server/` → `'VS Code Server'`
- Contains `/code/` → `'VS Code'`
- Default → `'Unknown'`

### 5. Session Title Extraction
**Location**: `src/extension.ts` in `getSessionFileDetails()` method

**Purpose**: Extracts the session title for display in diagnostics.

**How it works:**

**For JSON files:**
1. Primary: `customTitle` field from root of session object
2. Fallback: `generatedTitle` from response items (e.g., thinking blocks, tool invocations)
   - Iterates through `requests[].response[]` looking for `generatedTitle`

**For JSONL files (Incremental format):**
1. Primary: `customTitle` from the `kind: 0` header entry
2. Fallback: `generatedTitle` from `kind: 2` response entries

**For JSONL files (CLI format):**
- Not available (CLI sessions don't have titles)

**Note**: `customTitle` is user-defined (when they rename the session). `generatedTitle` is AI-generated summary text found in thinking blocks or tool results.

## Token Estimation Algorithm

### Character-to-Token Conversion: `estimateTokensFromText()`
**Location**: `src/extension.ts` (lines 1147-1160)

**Approach**: Uses model-specific character-to-token ratios
- Default ratio: 0.25 (4 characters per token)
- Model-specific ratios loaded from `src/tokenEstimators.json`
- Formula: `Math.ceil(text.length * tokensPerChar)`

**Model matching:**
- Checks if model name includes the key from tokenEstimators
- Example: `gpt-4o` matches key `gpt-4o`

## Caching Strategy

### Cache Structure: `SessionFileCache`
**Location**: `src/extension.ts` (lines 72-77)

Stores pre-calculated data to avoid re-processing unchanged files:
```typescript
{
  tokens: number,
  interactions: number,
  modelUsage: ModelUsage,
  mtime: number  // file modification timestamp
}
```

### Cache Methods:
- **`isCacheValid()`** (lines 165-168): Checks if cache is valid for file
- **`getCachedSessionData()`** (lines 170-172): Retrieves cached data
- **`setCachedSessionData()`** (lines 174-186): Stores data with size limit (1000 files max)
- **`clearExpiredCache()`** (lines 188-201): Removes cache for deleted files

### Cached Wrapper Methods:
- `estimateTokensFromSessionCached()` (lines 755-758)
- `countInteractionsInSessionCached()` (lines 760-763)
- `getModelUsageFromSessionCached()` (lines 765-768)

All use `getSessionFileDataCached()` (lines 732-753) which:
1. Checks cache validity using file mtime
2. Returns cached data if valid
3. Otherwise reads file and caches result

## Schema Documentation

### Schema Files Location
**Directory**: `docs/logFilesSchema/`

**Key files:**
1. **`session-file-schema.json`**: Manual curated schema with descriptions
2. **`session-file-schema-analysis.json`**: Auto-generated field discovery (generated by PowerShell script)
3. **`README.md`**: Complete guide for schema analysis
4. **`SCHEMA-ANALYSIS.md`**: Quick reference guide
5. **`VSCODE-VARIANTS.md`**: VS Code variant detection documentation

**Note**: The analysis JSON file is auto-generated and may not exist in fresh clones. It's created by running the schema analysis script documented in the README.

### Schema Analysis
See the **Executable Scripts** section above for three available scripts:
1. `get-session-files.js` - Quick session file discovery
2. `diagnose-session-files.js` - Detailed diagnostics
3. `analyze-session-schema.ps1` - PowerShell schema analysis

## JSON File Structure (VS Code Sessions)

**Primary fields used by extension:**

```json
{
  "requests": [
    {
      "message": {
        "parts": [
          { "text": "user message content" }
        ]
      },
      "response": [
        { "value": "assistant response content" }
      ],
      "result": {
        "metadata": {
          "modelId": "gpt-4o"
        },
        "details": "Used GPT-4o model"
      }
    }
  ]
}
```

**Key paths:**
- Input tokens: `requests[].message.parts[].text`
- Output tokens: `requests[].response[].value`
- Model ID: `requests[].result.metadata.modelId`
- Model details: `requests[].result.details`
- Interaction count: `requests.length`

## JSONL File Structure (Copilot CLI)

**Event types:**

```jsonl
{"type": "user.message", "data": {"content": "..."}, "model": "gpt-4o"}
{"type": "assistant.message", "data": {"content": "..."}}
{"type": "tool.result", "data": {"output": "..."}}
```

**Key fields:**
- Event type: `type`
- User input: `data.content` (when `type: 'user.message'`)
- Assistant output: `data.content` (when `type: 'assistant.message'`)
- Tool output: `data.output` (when `type: 'tool.result'`)
- Model: `model` (optional, defaults to `gpt-4o`)

## JSONL File Structure (VS Code Incremental)

**Introduced in**: VS Code Insiders ~0.25+ (April 2025)

This is a newer incremental format used by VS Code Insiders that logs session data progressively. Unlike the CLI format that uses `type`, this format uses `kind` to identify log entry types.

**Entry kinds:**

```jsonl
{"kind": 0, "sessionId": "...", "customTitle": "Session Title", "mode": "agent", "version": 1}
{"kind": 1, "requestId": "...", "request": {"message": {"parts": [{"text": "user prompt"}]}}}
{"kind": 2, "requestId": "...", "response": [{"value": "assistant reply"}], "model": "claude-3.5-sonnet"}
```

**Kind values:**
- `kind: 0` - Session header (contains `sessionId`, `customTitle`, `mode`, `version`)
- `kind: 1` - User request (contains `requestId`, `request.message.parts[].text`)
- `kind: 2` - Assistant response (contains `requestId`, `response[].value`, `model`)

**Key fields:**
- Session title: `customTitle` (when `kind: 0`)
- User input: `request.message.parts[].text` (when `kind: 1`)
- Assistant output: `response[].value` (when `kind: 2`)
- Model: `model` (when `kind: 2`, e.g., `claude-3.5-sonnet`)

**Format detection:**
```javascript
// Read first line of JSONL file
const firstLine = JSON.parse(lines[0]);
if ('kind' in firstLine) {
    // VS Code Incremental format
} else if ('type' in firstLine) {
    // Copilot CLI format
}
```

**Official source reference**: 
- `vscode-copilot-chat/src/vs/workbench/contrib/chat/common/chatSessionsProvider.d.ts`

## Pricing and Cost Calculation

### Pricing Data
**Location**: `src/modelPricing.json`

Contains per-million-token costs for input and output:
```json
{
  "pricing": {
    "gpt-4o": {
      "inputCostPerMillion": 1.75,
      "outputCostPerMillion": 14.0,
      "category": "gpt-4"
    }
  }
}
```

### Cost Calculation: `calculateEstimatedCost()`
**Location**: `src/extension.ts` (lines 776-802)

**Formula:**
- Input cost = `(inputTokens / 1_000_000) * inputCostPerMillion`
- Output cost = `(outputTokens / 1_000_000) * outputCostPerMillion`
- Total cost = input cost + output cost
- Fallback to `gpt-4o-mini` pricing for unknown models

## Executable Scripts

This skill includes three executable scripts that can be run directly to analyze session files. **Always run scripts with their appropriate command first** before attempting to read or modify them.

### Script 1: Quick Session File Discovery

**Purpose**: Quickly discover all Copilot session files on your system with summary statistics.

**Location**: `.github/skills/copilot-log-analysis/get-session-files.js`

**When to use:**
- Need a quick overview of session file locations
- Want to know how many session files exist
- Need sample paths for manual inspection
- Troubleshooting why session files aren't being found

**Usage:**
```bash
# Basic output with summary statistics
node .github/skills/copilot-log-analysis/get-session-files.js

# Show all file paths (verbose mode)
node .github/skills/copilot-log-analysis/get-session-files.js --verbose

# JSON output for programmatic use
node .github/skills/copilot-log-analysis/get-session-files.js --json
```

**What it does:**
- Scans all VS Code variants (Stable, Insiders, Cursor, VSCodium, etc.)
- Finds files in workspace storage, global storage, and Copilot CLI locations
- Categorizes files by location and editor type
- Shows total counts and sample file paths

**Example output:**
```
Platform: win32
Home directory: C:\Users\YourName

VS Code installations found:
  C:\Users\YourName\AppData\Roaming\Code\User
  C:\Users\YourName\AppData\Roaming\Code - Insiders\User

Total session files found: 274

Session files by location:
  Workspace Storage: 192 files
  Global Storage (Legacy): 67 files
  Copilot Chat Extension: 6 files
  Copilot CLI: 9 files

Session files by editor:
  VS Code: 265 files
  VS Code Insiders: 9 files
```

### Script 2: Detailed Session File Diagnostics

**Purpose**: Comprehensive diagnostic tool that analyzes session file structure, content, and provides debugging information.

**Location**: `.github/skills/copilot-log-analysis/diagnose-session-files.js`

**When to use:**
- Debugging session file discovery issues
- Need detailed information about session file structure
- Investigating token counting discrepancies
- Troubleshooting parser failures
- Understanding session file metadata and format variations

**Usage:**
```bash
# Basic diagnostic report
node .github/skills/copilot-log-analysis/diagnose-session-files.js

# Verbose output with all file paths and details
node .github/skills/copilot-log-analysis/diagnose-session-files.js --verbose
```

**What it does:**
- Discovers all session files across VS Code variants
- Reports file locations, counts, and metadata
- Analyzes file structure (JSON vs JSONL format)
- Validates session file integrity
- Provides diagnostic information for troubleshooting
- Shows file modification times and sizes

### Script 3: Schema Analysis and Field Discovery

**Purpose**: PowerShell script that analyzes session files to discover field structures and generate schema documentation.

**Location**: `.github/skills/copilot-log-analysis/analyze-session-schema.ps1`

**When to use:**
- Need to understand the complete structure of session files
- Discovering new fields added by VS Code updates
- Generating schema documentation
- Understanding field variations across different VS Code versions
- Creating or updating schema reference files

**Usage:**
```powershell
# Analyze session files and generate schema
pwsh .github/skills/copilot-log-analysis/analyze-session-schema.ps1

# Specify custom output directory
pwsh .github/skills/copilot-log-analysis/analyze-session-schema.ps1 -OutputPath ./output
```

**What it does:**
- Scans all discovered session files
- Extracts and catalogs all field names and structures
- Generates JSON schema documentation
- Creates field analysis reports
- Outputs to `docs/logFilesSchema/session-file-schema-analysis.json`
- Documents field types, occurrences, and variations

**Note**: This script generates the `session-file-schema-analysis.json` file referenced in the Schema Documentation section below.

## Usage Examples

### Example 1: Finding all session files
```typescript
const sessionFiles = await getCopilotSessionFiles();
console.log(`Found ${sessionFiles.length} session files`);
```

### Example 2: Analyzing a specific session file
```typescript
const filePath = '/path/to/session.json';
const stats = fs.statSync(filePath);
const mtime = stats.mtime.getTime();

// Get all data (cached if unchanged)
const tokens = await estimateTokensFromSessionCached(filePath, mtime);
const interactions = await countInteractionsInSessionCached(filePath, mtime);
const modelUsage = await getModelUsageFromSessionCached(filePath, mtime);
const editorType = getEditorTypeFromPath(filePath);

console.log(`Tokens: ${tokens}`);
console.log(`Interactions: ${interactions}`);
console.log(`Editor: ${editorType}`);
console.log(`Models:`, modelUsage);
```

### Example 3: Processing daily statistics
```typescript
const now = new Date();
const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
const sessionFiles = await getCopilotSessionFiles();

let todayTokens = 0;
for (const file of sessionFiles) {
  const stats = fs.statSync(file);
  if (stats.mtime >= todayStart) {
    todayTokens += await estimateTokensFromSessionCached(file, stats.mtime.getTime());
  }
}
```

## Diagnostic Tools

### Output Channel Logging
**Location**: Throughout `src/extension.ts`

Methods available:
- `log(message)` (line 146): Info-level logging
- `warn(message)` (line 151): Warning-level logging
- `error(message, error?)` (line 156): Error-level logging

All logs go to "GitHub Copilot Token Tracker" output channel.

### Diagnostic Report Generation
**Method**: `generateDiagnosticReport()`
**Location**: `src/extension.ts` (lines 1813-2019)

Creates comprehensive report including:
- System information (OS, Node version, environment)
- GitHub Copilot extension status
- Session file discovery results
- Token usage statistics
- No sensitive data (code/conversations excluded)

**Access via:**
- Command Palette: "Generate Diagnostic Report"
- Details panel: "Diagnostics" button

## File References

When working with log analysis, refer to these files:

1. **Main implementation**: `src/extension.ts`
   - All field extraction methods
   - Session file discovery logic
   - Caching implementation

2. **Configuration files**:
   - `src/tokenEstimators.json` - Token estimation ratios
   - `src/modelPricing.json` - Model pricing data
   - `src/README.md` - Data files documentation

3. **Schema documentation**: `docs/logFilesSchema/`
   - Complete schema reference
   - Field analysis tools
   - VS Code variant information

4. **Skill resources**: `.github/skills/copilot-log-analysis/`
   - `get-session-files.js` - Quick session file discovery script
   - `diagnose-session-files.js` - Detailed diagnostic tool
   - `analyze-session-schema.ps1` - PowerShell schema analysis script
   - `SKILL.md` - This documentation

5. **Project instructions**: `.github/copilot-instructions.md`
   - Architecture overview
   - Development guidelines

## Common Issues and Solutions

### Issue: No session files found
**Solution**: 
1. Run diagnostic script: `node .github/skills/copilot-log-analysis/diagnose-session-files.js`
2. Check if Copilot Chat extension is active
3. Verify user has started at least one Copilot Chat session
4. Check OS-specific paths are correct

### Issue: Token counts seem incorrect
**Solution**:
1. Verify `tokenEstimators.json` has correct ratios for models
2. Check if new models need to be added
3. Review session file content to verify expected structure
4. Check cache hasn't become stale (cache uses mtime)

### Issue: Model not detected properly
**Solution**:
1. Check `getModelFromRequest()` detection logic
2. Review `request.result.details` string patterns
3. Add new model pattern if needed
4. Update `modelPricing.json` with new model

## Notes

- All file paths must be absolute
- Token estimation is approximate (character-based)
- Caching significantly improves performance
- Session files grow over time as conversations continue
- JSONL format is newer (Copilot CLI/Agent mode)
- The extension processes files sequentially with progress callbacks
