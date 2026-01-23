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

## GitHub Actions Workflow Integration

### Automated Screenshot Generation Workflow

A GitHub Actions workflow is available to automate the environment setup and generate screenshot instructions as artifacts.

**Workflow file**: `.github/workflows/screenshot-generation.yml`

### How to Use the Workflow

**Triggering manually:**
1. Go to repository → Actions tab
2. Select "Generate Extension Screenshots" workflow
3. Click "Run workflow"
4. Download artifacts when complete

**What the workflow provides:**
- ✅ Automated environment setup (VS Code, virtual display, test data)
- ✅ Extension build verification
- ✅ Screenshot instructions artifact (HTML checklist)
- ✅ CI environment for testing the skill execution

**Limitations:**
- ⚠️ Cannot capture actual screenshots in headless CI (no interactive GUI)
- ⚠️ Native VS Code UI requires manual capture
- ⚠️ Webviews could be captured with additional automation (Chrome DevTools Protocol)

**Best practice:**
1. Use workflow to verify skill works in CI
2. Download instruction artifact
3. Run locally for actual screenshot capture: `node scripts/screenshot-ui-views.js`
4. Upload screenshots to repository

### Using with GitHub Copilot CLI

**From Copilot chat:**
```
@workspace /skill screenshot-ui-views
```

This invokes the skill which will:
1. Verify prerequisites
2. Build the extension
3. Launch VS Code with test data
4. Generate capture instructions
5. Wait for manual screenshot capture

**In a Copilot agent workflow:**
```bash
# Agent can execute the skill automation
gh copilot invoke screenshot-ui-views

# Or directly run the script
node scripts/screenshot-ui-views.js
```

The agent will handle all setup, then provide instructions for final capture.

### Implementation in Current Codebase

### Agent-Executable Screenshot Generation

This skill can be executed by GitHub Copilot agents to automate screenshot generation. The approach combines automated preparation with programmatic UI control.

### How Agent Execution Works

When invoked by a Copilot agent, the skill:
1. **Prepares environment** - Builds extension, sets up test data
2. **Launches VS Code** - Opens Extension Development Host programmatically
3. **Captures screenshots** - Uses automation tools to control UI and capture views
4. **Saves output** - Stores screenshots in docs directory

### Automated Screenshot Script

**Location**: `scripts/automated-screenshots.js`

This script provides full automation suitable for agent execution:

```javascript
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

async function captureExtensionScreenshots() {
  // 1. Build extension
  console.log('Building extension...');
  await exec('npm run compile');
  
  // 2. Set test data path
  process.env.COPILOT_TEST_DATA_PATH = path.join(__dirname, '..', 'test-data', 'chatSessions');
  
  // 3. Launch VS Code with extension
  console.log('Launching VS Code...');
  const vscodeProcess = spawn('code', [
    '--extensionDevelopmentPath=' + path.join(__dirname, '..'),
    '--new-window'
  ]);
  
  // 4. Wait for extension to load (5 seconds)
  await new Promise(resolve => setTimeout(resolve, 5000));
  
  // 5. Use VS Code automation API to capture screenshots
  // Note: This requires VS Code's remote debugging protocol
  const browser = await chromium.connectOverCDP('http://localhost:9222');
  const contexts = browser.contexts();
  const page = contexts[0].pages()[0];
  
  // 6. Navigate and capture each view
  await captureStatusBar(page);
  await captureDetailsPanel(page);
  await captureChartView(page);
  await captureUsageAnalysis(page);
  await captureDiagnostics(page);
  
  // 7. Cleanup
  vscodeProcess.kill();
  await browser.close();
}

async function captureStatusBar(page) {
  const statusBar = await page.waitForSelector('.statusbar');
  await statusBar.screenshot({ path: 'docs/images/screenshots/01-status-bar.png' });
}

// Additional capture functions...
```

### Prerequisites for Automation

**Required packages:**
```bash
npm install --save-dev playwright @playwright/test
```

**VS Code requirements:**
- VS Code installed and in PATH
- Extension built: `npm run compile`
- Test data available: `test-data/chatSessions/`

### Agent Execution Flow

When a Copilot agent invokes this skill:

```
1. Agent runs: npm run compile
   → Builds extension bundle

2. Agent executes: node scripts/automated-screenshots.js
   → Launches VS Code with extension
   → Waits for UI to load
   → Captures screenshots programmatically
   → Saves to docs/images/screenshots/

3. Agent verifies: Check screenshots exist
   → ls docs/images/screenshots/
   → Confirm all 6 views captured

4. Agent reports: Screenshot generation complete
   → Lists captured files
   → Notes any failures
```

### Platform-Specific Considerations

**Windows:**
- VS Code command: `code.cmd`
- Path separators: `\`
- PowerShell execution: Set `$env:` variables

**macOS/Linux:**
- VS Code command: `code`
- Path separators: `/`
- Shell execution: `export` variables

**Headless environments (CI):**
- Requires virtual display: `Xvfb` on Linux
- Or use `playwright:chromium` with `--headless=new`
- Limited to webview capture (not native UI)

### Automation Limitations

**What CAN be automated:**
- ✅ Extension building and preparation
- ✅ Test data generation and configuration
- ✅ VS Code launching with extension loaded
- ✅ Webview content capture (via Chrome DevTools Protocol)
- ✅ Programmatic navigation between views

**What CANNOT be automated easily:**
- ❌ Native VS Code UI elements (status bar, tooltips) without CDP
- ❌ OS-native context menus and dialogs
- ❌ Hover states and transitions without event simulation
- ❌ Capturing across multiple monitors/displays

### Hybrid Approach (Recommended for Agents)

The optimal approach for agent skills combines automation with guided manual steps:

**Agent automates:**
1. Build extension: `npm run compile`
2. Generate test data: Create/verify session files
3. Configure environment: Set `COPILOT_TEST_DATA_PATH`
4. Create instructions: Generate HTML guide with checklist
5. Launch VS Code: Open Extension Development Host

**Human completes:**
1. Navigate UI: Click through views
2. Capture screenshots: Use OS screenshot tools
3. Verify quality: Check resolution and content

**Rationale:**
- Balances automation with quality control
- Works reliably across all platforms
- Doesn't require complex GUI automation setup
- Human verification ensures screenshots are useful

### Implementation in Current Codebase

The `scripts/screenshot-ui-views.js` implements the hybrid approach with full automation:

**What it does:**
1. ✅ Verifies prerequisites (VS Code, test data, screenshot directory)
2. ✅ Builds extension (`npm run compile`)
3. ✅ Launches VS Code Extension Development Host with test data
4. ✅ Generates detailed HTML instructions for screenshot capture
5. ✅ Keeps process alive while you capture screenshots

**Agent execution:**
```bash
node scripts/screenshot-ui-views.js
```

This single command handles all automation setup, then waits for human screenshot capture.

**Output:**
- Extension Development Host running with test data
- `screenshot-instructions.html` with detailed capture checklist
- Ready for manual screenshot capture

## Automation with Agent Skills

### Agent-Executable Screenshot Generation

This skill is designed for execution by GitHub Copilot agents, combining automated preparation with guided capture.

### Agent Execution Flow

When invoked by a Copilot agent:

```
1. Agent verifies: Prerequisites (VS Code, test data, build tools)
   → Checks installation and availability

2. Agent builds: Extension compilation
   → npm run compile

3. Agent launches: VS Code Extension Development Host
   → Sets COPILOT_TEST_DATA_PATH environment
   → Opens with extension loaded

4. Agent generates: Detailed instructions (HTML)
   → Creates screenshot-instructions.html
   → Provides capture checklist

5. Human completes: Screenshot capture
   → Follows checklist to capture 6 views
   → Saves to docs/images/screenshots/
```

### What Agents CAN Automate

- ✅ Environment verification (VS Code installed, PATH configured)
- ✅ Dependency installation (npm packages, Playwright)
- ✅ Extension building (compile TypeScript, bundle)
- ✅ Test data setup (verify session files exist)
- ✅ VS Code launching (with test data environment)
- ✅ Instruction generation (HTML checklist with styling)
- ✅ Directory creation (screenshot output folder)

### What Requires Human Interaction

- ❌ Actual screenshot capture (GUI interaction)
- ❌ Visual quality verification (theme consistency)
- ❌ Tooltip and hover state capture (timing-sensitive)
- ❌ Cross-platform testing (Windows/macOS/Linux UI differences)

### Platform-Specific Automation

**Windows (PowerShell):**
```powershell
# Agent sets environment variable
$env:COPILOT_TEST_DATA_PATH = "C:\path\to\test-data\chatSessions"

# Agent runs automation
node scripts/screenshot-ui-views.js

# VS Code command
code.cmd --extensionDevelopmentPath=. --new-window
```

**macOS/Linux (Bash):**
```bash
# Agent sets environment variable
export COPILOT_TEST_DATA_PATH="/path/to/test-data/chatSessions"

# Agent runs automation
node scripts/screenshot-ui-views.js

# VS Code command
code --extensionDevelopmentPath=. --new-window
```

**CI/Headless (GitHub Actions):**
```bash
# Virtual display for Linux
Xvfb :99 -screen 0 1920x1080x24 &
export DISPLAY=:99

# Limited automation - instructions only
timeout 15s node scripts/screenshot-ui-views.js || true
```

### Hybrid Approach (Recommended)

The optimal workflow combines agent automation with human verification:

**Phase 1: Agent Automation (5 minutes)**
1. Verify VS Code installation: `code --version`
2. Check test data: `ls test-data/chatSessions/*.json`
3. Build extension: `npm run compile`
4. Set environment: `COPILOT_TEST_DATA_PATH=...`
5. Launch VS Code: Spawn Extension Development Host
6. Generate instructions: Create HTML checklist

**Phase 2: Human Capture (10 minutes)**
1. Open generated `screenshot-instructions.html`
2. Verify extension loaded (status bar shows tokens)
3. Navigate through 6 views (Details, Chart, Analysis, etc.)
4. Capture screenshots with OS tool (Snipping Tool, Cmd+Shift+4)
5. Save to `docs/images/screenshots/`
6. Verify quality and consistency

**Rationale:**
- Agents excel at environment setup and repeatability
- Humans excel at visual verification and edge cases
- Balances automation efficiency with quality assurance
- Works reliably across all platforms without complex GUI automation

### References

- [VS Code Extension Testing](https://code.visualstudio.com/api/working-with-extensions/testing-extension)
- [Chrome DevTools Protocol](https://chromedevtools.github.io/devtools-protocol/)
- [Playwright for VS Code](https://playwright.dev/docs/debug#vs-code-debugger)
- [GitHub Copilot Agent Skills](https://docs.github.com/en/copilot/concepts/agents/about-agent-skills)

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
