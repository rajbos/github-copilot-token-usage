# Documentation

This directory contains documentation for the GitHub Copilot Token Tracker extension.

## Log Files Schema Documentation

For comprehensive documentation about Copilot session log file schemas, see:

📂 **[logFilesSchema/](logFilesSchema/)** - Complete schema documentation and analysis tools

### Quick Links

- **[SCHEMA-ANALYSIS.md](logFilesSchema/SCHEMA-ANALYSIS.md)** - Quick reference guide
- **[session-file-schema.json](logFilesSchema/session-file-schema.json)** - Manual schema documentation
- **[session-file-schema-analysis.json](logFilesSchema/session-file-schema-analysis.json)** - Auto-generated analysis
- **[README.md](logFilesSchema/README.md)** - Detailed guide for working with schemas
- **[VSCODE-VARIANTS.md](logFilesSchema/VSCODE-VARIANTS.md)** - VS Code variants support info

### Quick Start

```powershell
# Analyze current session files
.\.github\skills\copilot-log-analysis\analyze-session-schema.ps1

# View results
Get-Content docs\logFilesSchema\session-file-schema-analysis.json | ConvertFrom-Json
```

See [logFilesSchema/SCHEMA-ANALYSIS.md](logFilesSchema/SCHEMA-ANALYSIS.md) for more information.
