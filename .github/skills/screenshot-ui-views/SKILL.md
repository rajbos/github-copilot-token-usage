---
name: screenshot-ui-views
description: Generate screenshots of the Copilot Token Tracker extension UI using test data. Use when documenting UI changes or creating visual documentation.
---

# Screenshot UI Views Skill

This skill provides instructions and tools for generating screenshots of the GitHub Copilot Token Tracker extension's user interface. It uses synthetic test data to display realistic token usage statistics without requiring actual Copilot usage data.

## When to Use This Skill

Use this skill when you need to:
- Document UI changes in pull requests
- Update screenshots in README or documentation
- Create visual examples for user guides
- Test UI rendering with controlled data
- Capture before/after screenshots for UI improvements

## Overview

The screenshot generation process consists of:
1. **Test Data**: Synthetic session files in `test-data/chatSessions/`
2. **Automation Script**: `scripts/screenshot-ui-views.js` - Provides instructions and setup
3. **Extension Views**: Details, Chart, Usage Analysis, and Diagnostics panels
4. **Output**: Screenshots saved to `docs/images/screenshots/`

## Prerequisites

Before generating screenshots, ensure:
- Extension is built: `npm run compile`
- Test data exists: `test-data/chatSessions/*.json`
- VS Code is installed and accessible
- Node.js is available for running scripts

## Test Data Structure

### Location
`test-data/chatSessions/` - Contains sample Copilot session files

### Current Test Files

**sample-session-1.json**
- Mode: `ask` (regular chat)
- Model: GPT-4o (2024-11-20)
- Interactions: 2
- Topic: React/TypeScript development
- Token estimate: ~1,200 tokens

**sample-session-2.json**
- Mode: `edit` (code editing)
- Models: Claude 3.5 Sonnet, GPT-4o (mixed)
- Interactions: 3
- Topic: Python Fibonacci with tests
- Token estimate: ~2,500 tokens

**sample-session-3.json**
- Mode: `agent` (autonomous agent)
- Model: o1 (2024-12-17)
- Interactions: 1
- Topic: SQL schema design
- Token estimate: ~1,800 tokens

### Adding More Test Data

To create additional test sessions:

1. **Follow the schema** documented in `docs/logFilesSchema/session-file-schema.json`
2. **Use unique session IDs** (e.g., `test-session-004`)
3. **Set realistic timestamps** (epoch milliseconds)
4. **Include diverse content**:
   - Different models (gpt-4o, claude-3.5-sonnet, o1, etc.)
   - Different modes (ask, edit, agent)
   - Various message lengths
   - Multiple interactions per session

**Minimal template:**
```json
{
  "version": 3,
  "sessionId": "test-session-XXX",
  "responderUsername": "GitHub Copilot",
  "responderAvatarIconUri": { "id": "copilot" },
  "creationDate": 1705651200000,
  "lastMessageDate": 1705654800000,
  "mode": "ask",
  "requests": [
    {
      "requestId": "req-XXX",
      "message": {
        "text": "Your prompt here",
        "parts": [{ "text": "Your prompt here", "kind": "text" }]
      },
      "response": [
        {
          "value": "AI response text here",
          "kind": "markdownContent"
        }
      ],
      "result": {
        "metadata": { "model": "gpt-4o-2024-11-20" }
      }
    }
  ]
}
```

## Screenshot Generation Process

### Step 1: Run the Setup Script

```bash
node scripts/screenshot-ui-views.js
```

This script will:
- Verify test data exists
- Check extension is built
- Create output directory
- Generate detailed instructions (HTML file)
- Display manual steps

**Script options:**
```bash
node scripts/screenshot-ui-views.js --help
node scripts/screenshot-ui-views.js --output-dir custom/path
node scripts/screenshot-ui-views.js --test-data custom/test-data
```

### Step 2: Configure Environment

Set the test data path so the extension uses synthetic data:

**Windows PowerShell:**
```powershell
$env:COPILOT_TEST_DATA_PATH = "C:\path\to\repo\test-data\chatSessions"
```

**Linux/macOS:**
```bash
export COPILOT_TEST_DATA_PATH="/path/to/repo/test-data/chatSessions"
```

**Note**: The extension's `getCopilotSessionFiles()` method checks this environment variable first before scanning default VS Code locations.

### Step 3: Launch Extension Development Host

1. Open the project in VS Code
2. Press **F5** to start debugging
3. Wait for Extension Development Host window to open
4. Extension automatically loads test data

**Verification:**
- Status bar shows token count
- Open Developer Tools: Help > Toggle Developer Tools
- Console shows: "Found X session files"

### Step 4: Navigate UI and Capture Screenshots

Capture these views in sequence:

**1. Status Bar** (`01-status-bar.png`)
- Bottom status bar
- Shows: "🤖 <today> | <month>"
- Captures: Basic token display

**2. Hover Tooltip** (`02-hover-tooltip.png`)
- Hover mouse over status bar item
- Shows: Detailed breakdown with percentages
- Captures: Tooltip with model usage

**3. Details Panel** (`03-details-panel.png`)
- Click status bar item
- Shows: Comprehensive statistics table
- Captures: Main details view with all metrics

**4. Chart View** (`04-chart-view.png`)
- In Details panel, click "📊 Chart" button
- Shows: Daily token usage chart
- Captures: Visualization with model/editor filters

**5. Usage Analysis** (`05-usage-analysis.png`)
- Click "📈 Usage Analysis" button
- Shows: Interaction modes, context references, tools
- Captures: Usage patterns dashboard

**6. Diagnostics Panel** (`06-diagnostics-panel.png`)
- Click "🔍 Diagnostics" button
- Shows: System info, file locations, cache stats
- Captures: Diagnostic information

### Step 5: Save Screenshots

Save to: `docs/images/screenshots/`

**Recommended naming:**
- `01-status-bar.png`
- `02-hover-tooltip.png`
- `03-details-panel.png`
- `04-chart-view.png`
- `05-usage-analysis.png`
- `06-diagnostics-panel.png`

**Screenshot guidelines:**
- Use PNG format for quality
- Capture at 2x resolution if possible (Retina/HiDPI)
- Include relevant context (window chrome if helpful)
- Avoid capturing sensitive information
- Crop to relevant area

## Extension Implementation Details

### How Test Data is Loaded

**Location**: `src/extension.ts` (lines 1503-1610)
**Method**: `getCopilotSessionFiles()`

The method checks locations in this order:
1. `process.env.COPILOT_TEST_DATA_PATH` (if set) ✅ **Used for screenshots**
2. VS Code workspace storage paths
3. VS Code global storage paths
4. Copilot CLI session paths

When `COPILOT_TEST_DATA_PATH` is set, the extension treats files in that directory as if they were real Copilot session files.

### Token Estimation

**Location**: `src/extension.ts` (lines 1047-1121)
**Method**: `estimateTokensFromSession()`

Token counts are estimated using character-to-token ratios from `src/tokenEstimators.json`:
- GPT-4o: ~0.28 tokens per character
- Claude 3.5 Sonnet: ~0.29 tokens per character
- o1: ~0.27 tokens per character

### View Rendering

All webview content is generated in:
- **Details**: `src/webviewTemplates.ts` - `getDetailsHtml()`
- **Chart**: `src/webview/chart/main.ts`
- **Usage Analysis**: `src/webview/usage/main.ts`
- **Diagnostics**: `src/webview/diagnostics/main.ts`

## Automation Limitations

### Why Manual Screenshots?

VS Code extension UI automation is complex because:
- Extensions run in a separate process
- Webviews have restricted DOM access
- Headless testing requires significant setup
- Screenshot APIs are limited in extension context

### Current Approach

The current approach uses **manual screenshots with guided instructions** because:
- ✅ Simple and reliable
- ✅ Works on all platforms
- ✅ No complex dependencies
- ✅ Developer can verify quality
- ❌ Requires manual effort

### Future Automation Options

For full automation, consider:

**1. VS Code Extension Test Runner**
```typescript
import { runTests } from '@vscode/test-electron';
// Implement screenshot capture in test runner
```

**2. Playwright with VS Code Web**
```javascript
// Test VS Code in browser with Playwright
const page = await browser.newPage();
await page.goto('https://vscode.dev');
```

**3. Puppeteer with Webview**
```javascript
// Capture webview content directly
const screenshot = await page.screenshot({ path: 'view.png' });
```

**References:**
- [VS Code Extension Testing](https://code.visualstudio.com/api/working-with-extensions/testing-extension)
- [Webview API](https://code.visualstudio.com/api/extension-guides/webview)
- [Playwright VS Code Testing](https://playwright.dev/)

## Troubleshooting

### Extension Not Loading Test Data

**Symptoms:**
- Status bar shows "# 0 | 0"
- Console shows "Total session files found: 0"

**Solutions:**
1. Verify environment variable is set: `echo $env:COPILOT_TEST_DATA_PATH` (PowerShell) or `echo $COPILOT_TEST_DATA_PATH` (Bash)
2. Restart VS Code after setting environment variable
3. Check test data files exist: `ls test-data/chatSessions/`
4. Verify JSON syntax: `node -e "JSON.parse(fs.readFileSync('test-data/chatSessions/sample-session-1.json'))"`

### Extension Shows Different Numbers

**Possible causes:**
- Test data was modified
- Cache is interfering
- Extension is reading real session files instead

**Solutions:**
1. Delete extension cache: Look for `.copilot-token-tracker-cache.json` in workspace
2. Verify `COPILOT_TEST_DATA_PATH` is absolute path
3. Check Developer Tools console for file paths being scanned

### Screenshot Quality Issues

**Tips:**
- Enable HiDPI/Retina display scaling
- Use native screenshot tools (not browser dev tools)
- Crop to relevant area after capture
- Use PNG for lossless quality

## Related Files

- **Test Data**: `test-data/chatSessions/*.json`, `test-data/README.md`
- **Automation Script**: `scripts/screenshot-ui-views.js`
- **Session Schema**: `docs/logFilesSchema/session-file-schema.json`
- **Extension Source**: `src/extension.ts`
- **Webview Templates**: `src/webviewTemplates.ts`, `src/webview/*/main.ts`
- **Existing Screenshots**: `docs/images/*.png`

## Example Workflow

```bash
# 1. Ensure extension is built
npm run compile

# 2. Run screenshot setup script
node scripts/screenshot-ui-views.js

# 3. Set environment variable (PowerShell example)
$env:COPILOT_TEST_DATA_PATH = "$(pwd)\test-data\chatSessions"

# 4. Launch VS Code and start debugging
# Press F5 in VS Code

# 5. In Extension Development Host:
#    - Verify status bar shows tokens
#    - Navigate through views
#    - Take screenshots manually

# 6. Save screenshots to docs/images/screenshots/
```

## Updating Screenshots in Documentation

After generating new screenshots:

1. **Review quality**: Check resolution, cropping, content
2. **Update references**: Modify README.md or docs if paths changed
3. **Commit changes**: Include screenshots in version control
4. **Document changes**: Note what changed in PR description

## Contributing

When adding new UI features:
1. Update test data if needed for new views
2. Generate screenshots showing new functionality
3. Update this skill documentation
4. Include before/after screenshots in PR

## Summary

This skill provides:
- ✅ Synthetic test data for controlled screenshots
- ✅ Setup script with detailed instructions
- ✅ Clear process for capturing all extension views
- ✅ Documentation for troubleshooting and automation
- ✅ Future-ready for full automation when feasible

The manual screenshot approach balances simplicity and quality while remaining open to future automation improvements.
