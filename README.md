# GitHub Copilot Token Tracker

A VS Code extension that shows your daily and monthly GitHub Copilot estimated token usage in the status bar. It reads GitHub Copilot Chat session logs and computes local aggregates.

Optionally, you can enable an **opt-in Azure Storage backend** to sync aggregates from all your VS Code instances (across machines, profiles, and windows) into **your own Azure Storage account** for cross-device reporting.

You can also use a **shared Azure Storage account** (a “shared storage server” for the team) so that multiple developers sync into the same dataset and a team lead can view aggregated usage across the team (with explicit per-user consent).

## Features

- **Real-time Token Tracking**: Displays current day and month token usage in the status bar
- **Usage Analysis Dashboard**: Comprehensive analytics on how you use Copilot (modes, tool calls, context references, MCP tools)
- **Copilot Fluency Score**: Evaluate your proficiency across 6 categories with actionable tips for improvement
- **Fluency Level Viewer**: Debug-only tool to explore all scoring rules and thresholds (requires active debugger)
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

### Session Log Upload (Optional)

The extension can also upload your local session log files to Azure Blob Storage. This enables:
- **Team collaboration**: Share logs with your team for analysis
- **Persistent storage**: Keep logs beyond local VS Code limits
- **Coding agent access**: Make logs available to GitHub Copilot Coding Agent as reference material

To enable log file uploads:
```json
{
  "copilotTokenTracker.backend.blobUploadEnabled": true,
  "copilotTokenTracker.backend.blobContainerName": "copilot-session-logs",
  "copilotTokenTracker.backend.blobUploadFrequencyHours": 24
}
```

See [Blob Upload Guide](docs/BLOB-UPLOAD.md) for detailed setup instructions and security considerations.

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

### Backend settings configurator

Use **Copilot Token Tracker: Configure Backend** to open the settings panel with five sections: Overview, Sharing, Azure, Advanced, and Review & Apply.

**Privacy profiles** (Sharing section):
- **Off** – All data stays local; nothing syncs to Azure
- **Solo** – Private cloud storage; only you can access your data
- **Team Anonymized** – Hashed workspace/machine IDs; no names stored; suitable for privacy-first team analytics
- **Team Pseudonymous** – Stable alias (e.g., "dev-001") with hashed IDs; no real names
- **Team Identified** – Team alias or Entra object ID included; full workspace names available

**Guided setup workflow**:
1. Run **Copilot Token Tracker: Configure Backend** command
2. Navigate to Sharing section to choose your privacy profile
3. Go to Azure section, enable backend, and use **Open configure walkthrough** to provision Azure resources
4. Advanced section sets dataset ID (default examples: "my-team-copilot") and lookback days (7/30/90)
5. Review & Apply confirms your changes with explicit consent for privacy upgrades
6. Click **Save & Apply** to enable backend sync

**Privacy gates**: Upgrading to a more permissive profile or enabling workspace/machine names triggers an explicit consent dialog. All settings are validated before saving (dataset/table names use alphanumeric rules, lookback days must be 1–90).

**Authentication**: Supports **Entra ID** (role-based access, no secrets stored) or **Storage Shared Key** (stored securely in VS Code SecretStorage, never synced). Test Connection verifies credentials (disabled when offline).

**Offline support**: You can edit and save settings locally when offline. Shared Key storage is per-machine only and never leaves the device.

**Accessibility**: The configurator includes ARIA labels on all interactive elements, proper heading hierarchy, keyboard navigation support, and screen-reader-friendly status updates. All form fields have clear labels and error messages are programmatically associated with inputs.

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

## Copilot Fluency Score & Level Viewer

The extension includes a **Copilot Fluency Score** dashboard that evaluates your GitHub Copilot proficiency across 6 categories with 4 stages each (Skeptic → Explorer → Collaborator → Strategist).

**Categories Evaluated:**
- 💬 **Prompt Engineering**: How you structure prompts and use modes
- 📎 **Context Engineering**: Your use of context references
- 🤖 **Agentic**: Agent mode and autonomous feature usage
- 🔧 **Tool Usage**: Built-in tools and MCP server integration
- ⚙️ **Customization**: Repository customization and model selection
- 🔄 **Workflow Integration**: Regular usage and mode diversity

**Fluency Level Viewer (Debug Mode)**

A debug-only tool that displays all fluency score rules, thresholds, and tips for each category and stage. This feature helps developers understand the scoring system and what actions trigger different fluency levels.

- **Access**: Only available when a VS Code debugger is active
- **Features**: View all stage requirements and advancement tips for each category
- **Use Cases**: Test scoring logic, debug scoring issues, plan improvements

For detailed information, see [Fluency Level Viewer Documentation](docs/FLUENCY-LEVEL-VIEWER.md).

## Known Issues

- The numbers shown are **estimates**, computed from Copilot Chat session logs.
- If you use multiple machines (or multiple VS Code profiles/windows), local-only mode will only reflect what’s on the current machine.
- The cloud backend improves cross-device coverage, but it still depends on what Copilot logs exist on each machine.
- Premium Requests are not tracked and shown in this extension
- The numbers are based on the amount of text in the chat sessions, not the actual tokens used. This is an estimation and may not be 100% accurate. We use an average character-to-token ratio for each model to estimate the token count, which is visible in the detail panel when you click on the status bar item.
- Same for the information on amount of trees that are needed to compensate your usage.
- Dev Containers: Copilot Chat session logs are written to the host machine's user profile (outside the container). On Linux, this is typically under `~/.config/Code/` (or the editor variant) within the host, not the container. The extension currently does not read from host paths, so token tracking will not work inside a Dev Container. If needed, run VS Code locally (outside the container) or mount the host user data directories into the container at the expected locations. PRs to add native host-path support are welcome.

> **⚠️ Warning**
>
> Some discovery paths for session logs can vary by OS and editor variant. If you run into missing session files on your platform, please open an issue with a diagnostic report.

## Contributing

[![Build](https://github.com/rajbos/github-copilot-token-usage/actions/workflows/build.yml/badge.svg)](https://github.com/rajbos/github-copilot-token-usage/actions/workflows/build.yml)

Interested in contributing? Check out our [Contributing Guide](CONTRIBUTING.md) for:

- 🐳 **DevContainer Setup** - Isolated development environment (perfect for AI-assisted development)
- 🔧 **Build & Debug Instructions** - How to run and test the extension locally
- 📋 **Code Guidelines** - Project structure and development principles
- 🚀 **Release Process** - CI/CD pipelines and automated releases

We welcome contributions of all kinds - bug fixes, new features, documentation improvements, and more!
