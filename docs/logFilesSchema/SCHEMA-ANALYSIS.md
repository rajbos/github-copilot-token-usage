# Session File Schema Analysis

Quick guide for analyzing and updating Copilot session file schemas.

## Quick Start

**Analyze current session files:**
```powershell
.\.github\skills\copilot-log-analysis\analyze-session-schema.ps1
```

**View results:**
- Auto-generated analysis: `docs\logFilesSchema\session-file-schema-analysis.json`
- Manual documentation: `docs\logFilesSchema\session-file-schema.json`
- Detailed guide: `docs\logFilesSchema\README.md`
- **VS Code variants info: `docs\logFilesSchema\VSCODE-VARIANTS.md`** ⭐

## What This Does

The analysis script:
1. ✅ Scans all Copilot session file locations
2. ✅ Extracts field names, types, and sample values
3. ✅ Compares with existing documentation
4. ✅ Highlights new/changed fields
5. ✅ Generates detailed JSON report

## When to Run

- 📅 After Copilot updates
- 📅 When adding new extension features
- 📅 Monthly maintenance check
- 📅 When investigating unknown fields

## Output Files

| File | Purpose |
|------|---------|
| `docs/logFilesSchema/session-file-schema.json` | **Manual** curated schema documentation with descriptions |
| `docs/logFilesSchema/session-file-schema-analysis.json` | **Auto-generated** field discovery and analysis |
| `docs/logFilesSchema/README.md` | Complete guide for working with schemas |

## Common Commands

```powershell
# Standard analysis (10 files per location)
.\scripts\analyze-session-schema.ps1

# Analyze more files for better coverage
.\scripts\analyze-session-schema.ps1 -MaxFiles 20

# Save to different location
.\scripts\analyze-session-schema.ps1 -OutputFile "analysis-$(Get-Date -Format 'yyyy-MM-dd').json"

# Skip comparison (faster)
.\scripts\analyze-session-schema.ps1 -CompareWithExisting $false
```

## Finding Specific Information

**Check for new fields:**
```powershell
$analysis = Get-Content docs\logFilesSchema\session-file-schema-analysis.json | ConvertFrom-Json
$analysis.newFieldsDetected
```

**Find token-related fields:**
```powershell
$analysis = Get-Content docs\logFilesSchema\session-file-schema-analysis.json | ConvertFrom-Json
$analysis.jsonFileSchema.fields.PSObject.Properties | Where-Object { $_.Name -like "*token*" }
```

**List all top-level fields:**
```powershell
$analysis = Get-Content docs\logFilesSchema\session-file-schema-analysis.json | ConvertFrom-Json
$analysis.topLevelJsonFields
```

## Session File Locations

The script scans these locations for all VS Code variants:

**VS Code Variants Checked:**
- Code (Stable)
- Code - Insiders
- Code - Exploration
- VSCodium
- Cursor

**For each variant:**
- **Workspace**: `%APPDATA%\{Variant}\User\workspaceStorage\*\chatSessions\*.json`
- **Global**: `%APPDATA%\{Variant}\User\globalStorage\emptyWindowChatSessions\*.json`
- **Copilot Chat**: `%APPDATA%\{Variant}\User\globalStorage\github.copilot-chat\**\*.json`

**Variant-independent:**
- **CLI**: `%USERPROFILE%\.copilot\session-state\*.jsonl`

**Remote/Server paths (Linux):**
- `~/.vscode-server/data/User`
- `~/.vscode-server-insiders/data/User`
- `~/.vscode-remote/data/User`

> **Note:** The extension checks all these locations automatically. The script focuses on local Windows installations but can be adapted for remote scenarios.

## Key Insights

**From session-file-schema.json:**
- 🎯 Primary data source: `requests[].message.parts[].text` (input)
- 🎯 Primary data source: `requests[].response[].value` (output)
- 🎯 Model detection: `requests[].result.details`
- 🎯 Interaction count: `requests.length`

**File formats:**
- `.json` - Standard VS Code Copilot Chat sessions
- `.jsonl` - Copilot CLI/Agent mode (one JSON object per line)

## Next Steps

1. Run the analysis script
2. Check `newFieldsDetected` in the output
3. If new fields found, investigate their purpose
4. Update `logFilesSchema/session-file-schema.json` with findings
5. Consider updating extension code if useful data found

## Need More Info?

See `docs/logFilesSchema/README.md` for complete documentation.
