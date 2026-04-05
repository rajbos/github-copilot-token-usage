# Screenshot Generation Guide

This guide explains how to generate screenshots of the Copilot Token Tracker extension UI for documentation purposes.

## Overview

The extension includes a complete screenshot automation infrastructure that uses synthetic test data to display realistic token usage statistics without requiring actual Copilot usage data.

## Quick Start

```bash
# 1. Ensure extension is built
npm run compile

# 2. Run the screenshot setup script
node scripts/screenshot-ui-views.js

# 3. Follow the displayed instructions to:
#    - Set COPILOT_TEST_DATA_PATH environment variable
#    - Launch Extension Development Host (F5 in VS Code)
#    - Capture screenshots of all views
#    - Save to docs/images/screenshots/
```

## Key Components

### 1. Test Data
- **Location**: `test-data/chatSessions/`
- **Files**: 3 sample session files with diverse content
- **Purpose**: Provides realistic data for screenshot generation

### 2. Automation Script
- **Location**: `scripts/screenshot-ui-views.js`
- **Purpose**: Validates prerequisites and generates instructions
- **Output**: Creates `screenshot-instructions.html` with detailed steps

### 3. Agent Skill Documentation
- **Location**: `.github/skills/screenshot-ui-views/SKILL.md`
- **Purpose**: Complete documentation for AI agents and developers
- **Contents**: 
  - Test data structure and how to add more
  - Step-by-step screenshot capture process
  - Environment configuration
  - Troubleshooting guide
  - Future automation options

### 4. Extension Support
- **Modification**: `src/extension.ts` (lines 1519-1536)
- **Feature**: Reads `COPILOT_TEST_DATA_PATH` environment variable
- **Purpose**: Allows extension to load test data instead of real session files

## Screenshot Views to Capture

1. **Status Bar** (`01-status-bar.png`) - Token count in bottom status bar
2. **Hover Tooltip** (`02-hover-tooltip.png`) - Detailed breakdown on hover
3. **Details Panel** (`03-details-panel.png`) - Main statistics view
4. **Chart View** (`04-chart-view.png`) - Daily usage visualization
5. **Usage Analysis** (`05-usage-analysis.png`) - Interaction patterns dashboard
6. **Diagnostics Panel** (`06-diagnostics-panel.png`) - System information

## Environment Setup

### Windows PowerShell
```powershell
$env:COPILOT_TEST_DATA_PATH = "C:\path\to\repo\test-data\chatSessions"
```

### Linux/macOS
```bash
export COPILOT_TEST_DATA_PATH="/path/to/repo/test-data/chatSessions"
```

## Troubleshooting

### Extension shows "# 0 | 0" in status bar
- Verify environment variable is set correctly
- Restart VS Code after setting the variable
- Check that test data files exist in the specified path

### Extension loads real data instead of test data
- Ensure `COPILOT_TEST_DATA_PATH` uses absolute path
- Verify the path contains `.json` files
- Check Developer Tools console for "Using test data from:" message

### JSON validation errors
- Validate test data files: `node -e "JSON.parse(fs.readFileSync('test-data/chatSessions/sample-session-1.json'))"`
- Check for syntax errors in JSON files
- Refer to `docs/logFilesSchema/session-file-schema.json` for correct structure

## Adding More Test Data

To create additional test sessions for different scenarios:

1. **Copy an existing sample file** from `test-data/chatSessions/`
2. **Modify the content**:
   - Change `sessionId` to be unique (e.g., `test-session-004`)
   - Update timestamps to current epoch milliseconds
   - Change message content and responses
   - Adjust model names for variety
3. **Validate JSON**: Run `node -e "JSON.parse(fs.readFileSync('path/to/new-file.json'))"`
4. **Test**: Re-run the extension to see updated statistics

See `test-data/README.md` for a minimal template and detailed guidelines.

## Automation Limitations

The current implementation requires manual screenshot capture because:
- VS Code extensions run in a separate, restricted process
- Webviews have limited DOM access from outside
- Headless extension testing requires complex setup
- No built-in screenshot API for extension webviews

**Future automation options:**
- VS Code Extension Test Runner with screenshot capabilities
- Playwright with VS Code Web testing
- Puppeteer for webview content capture

See `.github/skills/screenshot-ui-views/SKILL.md` for detailed automation discussion.

## Related Documentation

- **Agent Skill**: `.github/skills/screenshot-ui-views/SKILL.md`
- **Test Data**: `test-data/README.md`
- **Screenshot Directory**: `docs/images/screenshots/README.md`
- **Session Schema**: `docs/logFilesSchema/session-file-schema.json`

## Contributing

When adding new UI features or making changes:
1. Update test data if new fields are needed
2. Generate screenshots showing the new functionality
3. Update this guide if the process changes
4. Include before/after screenshots in your pull request

## Summary

This infrastructure provides:
- ✅ Reproducible screenshots using synthetic data
- ✅ Clear documentation and automation scripts
- ✅ Support for all extension views
- ✅ Easy addition of new test scenarios
- ✅ Future-ready for full automation when feasible

The manual screenshot approach balances simplicity, reliability, and quality while remaining flexible for future improvements.
