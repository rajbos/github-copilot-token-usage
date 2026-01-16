---
name: copilot-log-analysis
description: Analyzing GitHub Copilot session log files to extract token usage, model information, and interaction data. Use when working with session files, understanding the extension's log analysis methods, or debugging token tracking issues.
---

# Copilot Log Analysis Skill

This skill documents the methods and approaches used by the GitHub Copilot Token Tracker extension to analyze Copilot session log files. These files contain chat sessions, token usage, and model information.

## Overview

The extension analyzes two types of log files:
- **`.json` files**: Standard VS Code Copilot Chat session files
- **`.jsonl` files**: Copilot CLI/Agent mode sessions (one JSON event per line)

## Session File Discovery

### Key Method: `getCopilotSessionFiles()`
**Location**: `src/extension.ts` (lines 975-1073)
**Helper Methods**: `getVSCodeUserPaths()` (lines 934-972), `scanDirectoryForSessionFiles()` (lines 1078-1110)

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
**Location**: `src/extension.ts` (lines 934-972)

Returns all possible VS Code user data paths for different variants and platforms.

### Helper Method: `scanDirectoryForSessionFiles()`
**Location**: `src/extension.ts` (lines 1078-1110)

Recursively scans directories for `.json` and `.jsonl` session files.

## Field Extraction Methods

### Parsing and Token Accounting: `parseSessionFileContent()`
**Location**: `src/sessionParser.ts` (lines 184-347)

**Purpose**: Parses session files and returns tokens, interactions, model usage, and editor type-safe model IDs.

**How it works:**
1. Accepts raw file content along with callbacks for token estimation and model detection.
2. Supports both `.json` (Copilot Chat) and `.jsonl` (CLI/agent) formats, including delta-based JSONL streams.
3. Counts interactions (user messages), input tokens, and output tokens while grouping by model.
4. Uses `estimateTokensFromText()` (lines 1139-1155 in `src/extension.ts`) for character-to-token estimation.

### Model Detection Logic: `getModelFromRequest()`
**Location**: `src/extension.ts` (lines 1102-1134)
- Primary: `request.result.metadata.modelId`
- Fallback: parses `request.result.details` for known model patterns
- Detects GPT-3.5-Turbo, GPT-4 family (4, 4.1, 4o, 4o-mini, 5, o3-mini, o4-mini), Claude Sonnet (3.5, 3.7, 4), Gemini (2.5 Pro, 3 Pro); defaults to `gpt-4`
- Display name mapping in `getModelDisplayName()` (lines 1778-1811) adds variants such as GPT-5 family, Claude Haiku, Claude Opus, Gemini 3 Flash, Grok, and Raptor when present in `metadata.modelId`.

### Editor Type Detection: `getEditorTypeFromPath()`
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

## Token Estimation Algorithm

### Character-to-Token Conversion: `estimateTokensFromText()`
**Location**: `src/extension.ts` (lines 1139-1155)

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

Stores pre-calculated tokens, interactions, model usage, and file mtime to avoid re-processing unchanged files.

### Cache Methods:
- `isCacheValid()` (lines 227-230): Validates cached entry by mtime
- `getCachedSessionData()` (lines 232-234): Retrieves cached data
- `setCachedSessionData()` (lines 236-254): Stores data with FIFO eviction after 1000 files
- `clearExpiredCache()` (lines 250-264): Drops cache entries for missing files
- `getSessionFileDataCached()` (lines 811-845): Reads session content, parses via `parseSessionFileContent()`, and caches results

## Schema Documentation

### Schema Files Location
**Directory**: `docs/logFilesSchema/`

**Key files:**
1. **`session-file-schema.json`**: Manual curated schema with descriptions
2. **`session-file-schema-analysis.json`**: Auto-generated field discovery (generated by PowerShell script)
3. **`README.md`**: Complete guide for schema analysis
4. **`SCHEMA-ANALYSIS.md`**: Quick reference guide
5. **`VSCODE-VARIANTS.md`**: VS Code variant detection documentation

**Note**: The analysis JSON file is auto-generated and may not exist in fresh clones. It is created by running the schema analysis script documented below.

### Schema Analysis
See the **Executable Scripts** section for available utilities:
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
const content = await fs.promises.readFile(filePath, 'utf8');

const estimate = (text: string, model = 'gpt-4o') => Math.ceil(text.length * 0.25);
const detectModel = (req: any) => req?.result?.metadata?.modelId ?? 'gpt-4o';

const parsed = parseSessionFileContent(filePath, content, estimate, detectModel);
const editorType = getEditorTypeFromPath(filePath);

console.log(`Tokens: ${parsed.tokens}`);
console.log(`Interactions: ${parsed.interactions}`);
console.log(`Editor: ${editorType}`);
console.log(`Models:`, parsed.modelUsage);
```

### Example 3: Processing daily statistics
```typescript
const now = new Date();
const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
const sessionFiles = await getCopilotSessionFiles();
const estimate = (text: string, model = 'gpt-4o') => Math.ceil(text.length * 0.25);
const detectModel = (req: any) => req?.result?.metadata?.modelId ?? 'gpt-4o';

let todayTokens = 0;
for (const file of sessionFiles) {
  const stats = fs.statSync(file);
  if (stats.mtime >= todayStart) {
    const content = await fs.promises.readFile(file, 'utf8');
    const parsed = parseSessionFileContent(file, content, estimate, detectModel);
    todayTokens += parsed.tokens;
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
