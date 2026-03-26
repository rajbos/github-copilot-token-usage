# Copilot Token Tracker — VS Code Extension

Tracks your GitHub Copilot token usage directly inside VS Code. Reads local session logs and displays today's and monthly usage in the status bar, with rich detail views and optional cloud sync.

## Install

[![VS Code Marketplace](https://img.shields.io/visual-studio-marketplace/v/RobBos.copilot-token-tracker)](https://marketplace.visualstudio.com/items?itemName=RobBos.copilot-token-tracker)

Search for **"Copilot Token Tracker"** in the VS Code Extensions panel, or install via the Marketplace link above.

---

## Features

- **Real-time Token Tracking**: Displays current day and month token usage in the status bar
- **Copilot Fluency Score**: Maturity model dashboard with 4 stages across 6 categories to track your Copilot mastery
- **Export Fluency Score**: Export your Fluency Score as a PNG image or comprehensive multi-page PDF report
- **Social Media Sharing**: Share your Fluency Score achievements on LinkedIn, Bluesky, and Mastodon with #CopilotFluencyScore
- **Usage Analysis Dashboard**: Comprehensive analytics on how you use Copilot (modes, tool calls, context references, MCP tools)
- **Fluency Level Viewer**: Debug-only tool to explore all scoring rules and thresholds (requires active debugger)
- **Automatic Updates**: Refreshes every 5 minutes to show the latest usage
- **Click to Refresh**: Click the status bar item to manually refresh the token count
- **Smart Estimation**: Uses character-based analysis with model-specific ratios for token estimation
- **Intelligent Caching**: Caches processed session files to speed up subsequent updates
- **Diagnostic Reporting**: Generate comprehensive diagnostic reports to help troubleshoot issues

### Cloud Backend (Opt-in)

- **Cross-device analytics**: Syncs daily aggregates from all machines into a user-owned Azure Storage account
- **Azure Storage Tables backend**: Stores/queries pre-aggregated rollups (not raw prompts)
- **Secure by default**: Uses **Microsoft Entra ID (Azure RBAC)** via `DefaultAzureCredential` (no secrets in settings)
- **Advanced auth option**: Optional Storage **Shared Key** mode stored in VS Code SecretStorage (never in Settings Sync)
- **Graceful fallback**: If Azure is unavailable or permissions are missing, local-only mode keeps working

### Reporting & Filtering

- **Details view filters**: Lookback window + Model + Workspace + Machine + (optional) User filters
- **Export**: Export the current filtered view as JSON (for spreadsheets / dashboards / scripts)

### Team / Multi-user (Optional)

- **Shared storage for teams**: Multiple developers can write to the same Azure Storage account/dataset for centralized reporting
- **Explicit consent gating**: No per-user identifier is written unless you explicitly enable team sharing
- **Governed identity modes**: Pseudonymous hashing, validated team aliases, or Entra object IDs
- **User filtering**: When enabled, aggregates can be filtered by user in the details view

---

## Status Bar Display

The extension shows token usage in the format: `# <today> | <last 30 days>` in the status bar:

![Status Bar Display](../../docs/images/01%20Toolbar%20info.png)

Hovering on the status bar item shows a detailed breakdown of token usage:

![Hover Details](../../docs/images/02%20Popup.png)

Clicking the status bar item opens a detailed view with comprehensive statistics:

![Detailed View](../../docs/images/03%20Detail%20panel.png)

Chart overview per day, with option to view per model as well:

![Chart View](../../docs/images/04%20Chart.png)

Or per supported editor:

![Chart View per Editor](../../docs/images/04%20Chart_02.png)

Supported editors shown in the chart:

- `Code` — Stable VS Code release
- `Code - Insiders` — VS Code Insiders (preview) builds
- `Code - Exploration` — Exploration/pre-release builds
- `VSCodium` — Community-built VS Code distribution
- `Cursor` — Cursor editor
- `OpenCode` — Terminal-based coding agent
- `Crush` — Terminal-based coding agent
- `Visual Studio` — Visual Studio IDE (2022+); token counts are **estimated** from prompt and response text length

---

## Copilot Fluency Score

The extension includes a **Copilot Fluency Score** dashboard that evaluates your GitHub Copilot proficiency across 6 categories with 4 stages each (Skeptic → Explorer → Collaborator → Strategist).

**Categories Evaluated:**
- 💬 **Prompt Engineering**: How you structure prompts and use modes
- 📎 **Context Engineering**: Your use of context references
- 🤖 **Agentic**: Agent mode and autonomous feature usage
- 🔧 **Tool Usage**: Built-in tools and MCP server integration
- ⚙️ **Customization**: Repository customization and model selection
- 🔄 **Workflow Integration**: Regular usage and mode diversity

![Fluency Score](../../docs/images/05%20Fluency%20Score.png)

**Fluency Level Viewer (Debug Mode)**

A debug-only tool that displays all fluency score rules, thresholds, and tips for each category and stage.

- **Access**: Only available when a VS Code debugger is active
- **Features**: View all stage requirements and advancement tips for each category
- **Use Cases**: Test scoring logic, debug scoring issues, plan improvements

For detailed scoring rules, see [Fluency Levels Documentation](../FLUENCY-LEVELS.md).

---

## Usage Analysis Dashboard

The extension includes a comprehensive usage analysis dashboard that helps you understand how you interact with GitHub Copilot.

**Tracked Metrics:**

- **Interaction Modes**: Ask (chat), Edit (code modifications), Agent (autonomous tasks)
- **Context References**: `#file`, `#selection`, `#symbol`, `#codebase`, `@workspace`, `@terminal`, `@vscode`
- **Tool Calls**: Functions and tools invoked by Copilot
- **MCP Tools**: Model Context Protocol server and tool usage

**To access the dashboard:**

1. Click the status bar item to open the details panel
2. Click the **"📊 Usage Analysis"** button
3. Or use the Command Palette: `Copilot Token Tracker: Show Usage Analysis Dashboard`

For detailed information about the metrics, see [Usage Analysis Documentation](../USAGE-ANALYSIS.md).

---

## Diagnostic Reporting

Generate a diagnostic report to help troubleshoot issues. The report includes:

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

Alternatively, use the Command Palette:
- Press `Ctrl+Shift+P` / `Cmd+Shift+P`
- Type `Copilot Token Tracker: Generate Diagnostic Report`

> **Note**: The diagnostic report does not include any of your code or conversation content. It only includes file locations, sizes, and aggregated statistics.

---

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

See [Blob Upload Guide](../BLOB-UPLOAD.md) for detailed setup instructions and security considerations.

### Authentication

- **Recommended**: Entra ID (Azure RBAC) using `DefaultAzureCredential` (Azure CLI / VS Code Azure Account / Managed Identity)
- **Advanced**: Storage Shared Key (stored in VS Code SecretStorage, per-machine, does not sync)

### Required Azure Roles

Data-plane (tables):
- **Storage Table Data Contributor** (sync/write)
- **Storage Table Data Reader** (read-only reporting)

Management-plane (wizard/provisioning):
- **Contributor** (or a more scoped role) at subscription or resource group scope

> Important: management roles do not automatically grant data-plane access.

### Team Sharing

To share usage with team members, configure all participants to point at the same Azure Storage account and `datasetId`.

- **Team lead / admins**: provision the storage account and tables, and grant data-plane roles
- **Contributors (writers)**: need **Storage Table Data Contributor** to upload aggregates
- **Readers (reporting)**: can be granted **Storage Table Data Reader** for read-only reporting
- **Privacy guardrail**: per-user identity is only included when the developer has explicitly enabled team sharing

### Commands

- `Copilot Token Tracker: Configure Backend` — guided setup wizard for Azure resources and settings
- `Copilot Token Tracker: Copy Backend Config` — copies shareable config without secrets
- `Copilot Token Tracker: Export Current View` — exports filtered backend/local view as JSON

Shared Key management (only if using shared-key auth):
- `Copilot Token Tracker: Set Backend Shared Key`
- `Copilot Token Tracker: Rotate Backend Shared Key`
- `Copilot Token Tracker: Clear Backend Shared Key`

Other:
- `Copilot Token Tracker: Ask About Usage`

### Backend Settings Configurator

Use **Copilot Token Tracker: Configure Backend** to open the settings panel with five sections: Overview, Sharing, Azure, Advanced, and Review & Apply.

**Privacy profiles** (Sharing section):
- **Off** – All data stays local; nothing syncs to Azure
- **Solo** – Private cloud storage; only you can access your data
- **Team Anonymized** – Hashed workspace/machine IDs; no names stored
- **Team Pseudonymous** – Stable alias (e.g., "dev-001") with hashed IDs; no real names
- **Team Identified** – Team alias or Entra object ID included; full workspace names available

**Guided setup workflow:**
1. Run **Copilot Token Tracker: Configure Backend** command
2. Navigate to Sharing section to choose your privacy profile
3. Go to Azure section, enable backend, and use **Open configure walkthrough** to provision Azure resources
4. Advanced section sets dataset ID and lookback days (7/30/90)
5. Review & Apply confirms your changes with explicit consent for privacy upgrades
6. Click **Save & Apply** to enable backend sync

---

## Performance Optimization

The extension uses intelligent caching to improve performance:

- **File Modification Tracking**: Only re-processes session files when they have been modified since the last read
- **Efficient Cache Management**: Stores calculated token counts, interaction counts, and model usage data for each file
- **Memory Management**: Automatically limits cache size to prevent memory issues (maximum 1000 cached files)

---

## Known Issues

- Numbers shown use **actual token counts** from the LLM API when available (e.g. Copilot Chat JSONL sessions and OpenCode sessions). When actual token data is not available, the extension falls back to **estimates** computed from text in the session logs.
- If you use multiple machines (or multiple VS Code profiles/windows), local-only mode will only reflect what's on the current machine. The cloud backend improves cross-device coverage.
- Premium Requests are not tracked.
- Dev Containers: Copilot Chat session logs are written to the host machine's user profile (outside the container). The extension currently does not read from host paths, so token tracking will not work inside a Dev Container. Run VS Code locally (outside the container) or mount the host user data directories into the container at the expected locations.
- Windows with WSL: The extension can only show information when VS Code, Copilot CLI, and OpenCode run in the same environment as the VS Code host. To track usage properly, either run VS Code from within WSL using the [Remote - WSL extension](https://marketplace.visualstudio.com/items?itemName=ms-vscode-remote.remote-wsl) (recommended), or run all tools natively on Windows. See the [VS Code WSL documentation](https://code.visualstudio.com/docs/remote/wsl) for setup instructions.

> **⚠️ Warning**
>
> Some discovery paths for session logs can vary by OS and editor variant. If you run into missing session files on your platform, please open an issue with a diagnostic report.
