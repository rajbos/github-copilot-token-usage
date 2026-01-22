# GitHub Copilot Token Tracker

A VS Code extension that shows your daily and monthly GitHub Copilot estimated token usage in the status bar. It reads GitHub Copilot Chat session logs and computes local aggregates.

Optionally, you can enable an **opt-in Azure Storage backend** to sync aggregates from all your VS Code instances (across machines, profiles, and windows) into **your own Azure Storage account** for cross-device reporting.

You can also use a **shared Azure Storage account** (a “shared storage server” for the team) so that multiple developers sync into the same dataset and a team lead can view aggregated usage across the team (with explicit per-user consent).

## Features

- **Real-time Token Tracking**: Displays current day and month token usage in the status bar
- **Usage Analysis Dashboard**: Comprehensive analytics on how you use Copilot (modes, tool calls, context references, MCP tools)
- **Automatic Updates**: Refreshes every 5 minutes to show the latest usage
- **Click to Refresh**: Click the status bar item to manually refresh the token count
- **Smart Estimation**: Uses character-based analysis with model-specific ratios for token estimation
- **Intelligent Caching**: Caches processed session files to speed up subsequent updates when files haven't changed
- **Diagnostic Reporting**: Generate comprehensive diagnostic reports to help troubleshoot issues

### Cloud Backend (Opt-in)

- **Cross-device analytics**: Syncs daily aggregates from all machines into a user-owned Azure Storage account
- **Azure Storage Tables backend**: Stores/query pre-aggregated rollups (not raw prompts)
- **Secure by default**: Uses **Microsoft Entra ID (Azure RBAC)** via `DefaultAzureCredential` (no secrets in settings)
- **Advanced auth option**: Optional Storage **Shared Key** mode stored in VS Code SecretStorage (never in Settings Sync)
- **Graceful fallback**: If Azure is unavailable or permissions are missing, local-only mode keeps working

### Reporting & Filtering

- **Details view filters**: Lookback window + Model + Workspace + Machine + (optional) User filters
- **Export**: Export the current filtered view as JSON (for spreadsheets / dashboards / scripts)
- **Status bar scope selector** *(Planned)*: Toggle **All machines** | **This machine** | **Current workspace**

### Team / Multi-user (Optional)

- **Shared storage for teams**: Multiple developers can write to the same Azure Storage account/dataset for centralized reporting
- **Explicit consent gating**: No per-user identifier is written unless you explicitly enable team sharing
- **Governed identity modes**: Pseudonymous hashing, validated team aliases, or Entra object IDs
- **User filtering**: When enabled, aggregates can be filtered by user in the details view


## Status Bar Display

The extension shows token usage in the format: `# <today> | <this month>` in the status bar:

![Status Bar Display](docs/images/01%20Toolbar%20info.png)  

Hovering on the status bar item shows a detailed breakdown of token usage:
![Hover Details](docs/images/02%20Popup.png)  

Clicking the status bar item opens a detailed view with comprehensive statistics:
![Detailed View](docs/images/03%20Detail%20panel.png)  

Chart overview per day, with option to view per model as well:  
![Chart View](docs/images/04%20Chart.png)  

Or per supported editor:
![Chart View](docs/images/04%20Chart_02.png)  
Supported editors are:

- `Code` — Stable VS Code release
- `Code - Insiders` — VS Code Insiders (preview) builds
- `Code - Exploration` — Exploration/pre-release builds
- `VSCodium` — Community-built VS Code distribution
- `Cursor` — Cursor editor

## Performance Optimization

The extension uses intelligent caching to improve performance:

- **File Modification Tracking**: Only re-processes session files when they have been modified since the last read
- **Efficient Cache Management**: Stores calculated token counts, interaction counts, and model usage data for each file
- **Memory Management**: Automatically limits cache size to prevent memory issues (maximum 1000 cached files)
- **Cache Statistics**: Logs cache hit/miss rates to help monitor performance improvements

This caching significantly reduces the time needed for periodic updates, especially when you have many chat session files.

## Cloud Backend (Azure Storage)

The cloud backend is **disabled by default**. When enabled, the extension periodically uploads daily aggregates to Azure Storage Tables and queries them for cross-device reporting.

### Authentication

- **Recommended**: Entra ID (Azure RBAC) using `DefaultAzureCredential` (Azure CLI / VS Code Azure Account / Managed Identity)
- **Advanced**: Storage Shared Key (stored in VS Code SecretStorage, per-machine, does not sync)

### Required Azure Roles (Typical)

Data-plane (tables):
- **Storage Table Data Contributor** (sync/write)
- **Storage Table Data Reader** (read-only reporting)

Management-plane (wizard/provisioning):
- **Contributor** (or a more scoped role) at subscription or resource group scope

Important: management roles do not automatically grant data-plane access.

### Team Sharing with a Shared Storage Account

To share usage with team members, configure all participants to point at the same Azure Storage account and `datasetId`.

- **Team lead / admins**: typically provision the storage account and tables, and grant data-plane roles.
- **Contributors (writers)**: need **Storage Table Data Contributor** to upload aggregates.
- **Readers (reporting)**: can be granted **Storage Table Data Reader** for read-only reporting.
- **Privacy guardrail**: per-user identity is only included when the developer has explicitly enabled team sharing; otherwise their aggregates are stored without a user identifier.

### Commands

- `Copilot Token Tracker: Configure Backend` — guided setup wizard for Azure resources and settings
- `Copilot Token Tracker: Copy Backend Config` — copies shareable config without secrets
- `Copilot Token Tracker: Export Current View` — exports filtered backend/local view as JSON

Shared Key management (only if using shared-key auth):
- `Copilot Token Tracker: Set Backend Shared Key`
- `Copilot Token Tracker: Rotate Backend Shared Key`
- `Copilot Token Tracker: Clear Backend Shared Key`

Ask:
- `Copilot Token Tracker: Ask About Usage`

## Diagnostic Reporting

If you experience issues with the extension, you can generate a diagnostic report to help troubleshoot problems. The diagnostic report includes:

- Extension and VS Code version information
- System details (OS, Node version, environment)
- GitHub Copilot extension status and versions
- Session file discovery results (locations only, no content)
- Aggregated token usage statistics
- Cache performance metrics

**To generate a diagnostic report:**

1. Click the status bar item to open the detailed view
2. Click the **"Diagnostics"** button at the bottom
3. Review the report in the new panel
4. Use the **"Copy to Clipboard"** button to copy the report for sharing
5. Use the **"Open GitHub Issue"** button to submit an issue with the report

Alternatively, you can use the Command Palette:
- Press `Ctrl+Shift+P` (Windows/Linux) or `Cmd+Shift+P` (macOS)
- Type "Copilot Token Tracker: Generate Diagnostic Report"
- Press Enter

**Note**: The diagnostic report does not include any of your code or conversation content. It only includes file locations, sizes, and aggregated statistics.

## Usage Analysis Dashboard

The extension includes a comprehensive usage analysis dashboard that helps you understand how you interact with GitHub Copilot.

**Tracked Metrics:**
- **Interaction Modes**: Ask (chat), Edit (code modifications), Agent (autonomous tasks)
- **Context References**: #file, #selection, #symbol, #codebase, @workspace, @terminal, @vscode
- **Tool Calls**: Functions and tools invoked by Copilot
- **MCP Tools**: Model Context Protocol server and tool usage

**To access the dashboard:**
1. Click the status bar item to open the details panel
2. Click the **"📊 Usage Analysis"** button
3. Or use the Command Palette: "Copilot Token Tracker: Show Usage Analysis Dashboard"

The dashboard provides insights into your prompting patterns and helps you optimize your Copilot workflow. For detailed information about the metrics and how to interpret them, see [Usage Analysis Documentation](docs/USAGE-ANALYSIS.md).

## Known Issues

- The numbers shown are **estimates**, computed from Copilot Chat session logs.
- If you use multiple machines (or multiple VS Code profiles/windows), local-only mode will only reflect what’s on the current machine.
- The cloud backend improves cross-device coverage, but it still depends on what Copilot logs exist on each machine.
- Premium Requests are not tracked and shown in this extension
- The numbers are based on the amount of text in the chat sessions, not the actual tokens used. This is an estimation and may not be 100% accurate. We use an average character-to-token ratio for each model to estimate the token count, which is visible in the detail panel when you click on the status bar item.
- Same for the information on amount of trees that are needed to compensate your usage.

> **Warning**
>
> Some discovery paths for session logs can vary by OS and editor variant. If you run into missing session files on your platform, please open an issue with a diagnostic report.

## Development

[![Build](https://github.com/rajbos/github-copilot-token-usage/actions/workflows/build.yml/badge.svg)](https://github.com/rajbos/github-copilot-token-usage/actions/workflows/build.yml)

### Building the Extension

1. Install dependencies:
   ```bash
   npm install
   ```

2. Build the extension:
   ```bash
   npm run compile    # Development build
   npm run package    # Production build
   ```

3. Run tests:
   ```bash
   npm test
   ```

4. Create VSIX package:
   ```bash
   npx vsce package
   ```

### Running the Extension Locally

To test and debug the extension in a local VS Code environment:

1. Install dependencies:
   ```bash
   npm install
   ```

2. Start watch mode (automatically recompiles on file changes):
   ```bash
   npm run watch
   ```

3. In VS Code, press **F5** to launch the Extension Development Host
   - This opens a new VS Code window with the extension running
   - The original window shows debug output and allows you to set breakpoints

4. In the Extension Development Host window:
   - The extension will be active and you'll see the token tracker in the status bar
   - Any changes you make to the code will be automatically compiled (thanks to watch mode)
   - Reload the Extension Development Host window (Ctrl+R or Cmd+R) to see your changes

5. To view console logs and debug information:
   - In the Extension Development Host window, open Developer Tools: **Help > Toggle Developer Tools**
   - Check the Console tab for any `console.log` output from the extension

### Available Scripts

- `npm run lint` - Run ESLint
- `npm run check-types` - Run TypeScript type checking
- `npm run compile` - Build development version
- `npm run package` - Build production version
- `npm run watch` - Watch mode for development
- `npm test` - Run tests (requires VS Code)

### CI/CD

The project includes comprehensive GitHub Actions workflows:

- **Build Pipeline**: Tests the extension on Ubuntu, Windows, and macOS with Node.js 18.x and 20.x
- **CI Pipeline**: Includes VS Code extension testing and VSIX package creation
- **Release Pipeline**: Automated release creation when version tags are pushed
- All builds must pass linting, type checking, compilation, and packaging steps

### Automated Releases

The project supports automated VSIX builds and releases through two methods:

#### Method 1: Manual Trigger via GitHub UI (Recommended)

1. Update the version in `package.json`
2. Commit and push your changes to the main branch
3. Go to GitHub Actions → Release workflow
4. Click "Run workflow" and confirm

The workflow will automatically:
- Create a tag based on the version in `package.json`
- Run the full build pipeline (lint, type-check, compile, test)
- Create a VSIX package
- Create a GitHub release with auto-generated release notes
- Attach the VSIX file as a release asset

Then run the `./publish.ps1` script to package the VSIX file locally.

#### Method 2: Tag-Based Release (Traditional)

1. Update the version in `package.json`
2. Commit your changes
3. Create and push a version tag:
   ```bash
   git tag v1.0.0
   git push origin v1.0.0
   ```

The release workflow will:
- Verify the tag version matches `package.json` version
- Run the full build pipeline (lint, type-check, compile, test)
- Create a VSIX package
- Create a GitHub release with auto-generated release notes
- Attach the VSIX file as a release asset

**Note**: The workflow will fail if the tag version doesn't match the version in `package.json`.

### Syncing Release Notes

To keep the local `CHANGELOG.md` file synchronized with GitHub release notes:

**Manual Sync:**
```bash
npm run sync-changelog
```

**Automatic Sync:**
The project includes a GitHub workflow that automatically updates `CHANGELOG.md` whenever:
- A new release is published
- An existing release is edited
- The workflow is manually triggered

**Test the Sync:**
```bash
npm run sync-changelog:test
```

This ensures that the local changelog always reflects the latest release information from GitHub, preventing the documentation from becoming outdated.

