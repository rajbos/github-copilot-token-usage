# GitHub Copilot Token Tracker

A VS Code extension that shows your daily and monthly GitHub Copilot estimated token usage in the status bar. This uses the information from the log files of the GitHub Copilot Chat extension.

## Features

- **Real-time Token Tracking**: Displays current day and month token usage in the status bar
- **Usage Analysis Dashboard**: Comprehensive analytics on how you use Copilot (modes, tool calls, context references, MCP tools)
- **Automatic Updates**: Refreshes every 5 minutes to show the latest usage
- **Click to Refresh**: Click the status bar item to manually refresh the token count
- **Smart Estimation**: Uses character-based analysis with model-specific ratios for token estimation
- **Intelligent Caching**: Caches processed session files to speed up subsequent updates when files haven't changed
- **Diagnostic Reporting**: Generate comprehensive diagnostic reports to help troubleshoot issues

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

- The numbers shown are based on the logs that are available on your local machine. If you use multiple machines or the web version of Copilot, the numbers may not be accurate.
- Premium Requests are not tracked and shown in this extension
- The numbers are based on the amount of text in the chat sessions, not the actual tokens used. This is an estimation and may not be 100% accurate. We use an average character-to-token ratio for each model to estimate the token count, which is visible in the detail panel when you click on the status bar item.
- Same for the information on amount of trees that are needed to compensate your usage.

> **⚠️ Warning**
>
> This extension has only been tested on **Windows**. Other operating systems may not be supported or may require adjustments. PR's or test results for that are most welcome!

## Contributing

[![Build](https://github.com/rajbos/github-copilot-token-usage/actions/workflows/build.yml/badge.svg)](https://github.com/rajbos/github-copilot-token-usage/actions/workflows/build.yml)

Interested in contributing? Check out our [Contributing Guide](CONTRIBUTING.md) for:

- 🐳 **DevContainer Setup** - Isolated development environment (perfect for AI-assisted development)
- 🔧 **Build & Debug Instructions** - How to run and test the extension locally
- 📋 **Code Guidelines** - Project structure and development principles
- 🚀 **Release Process** - CI/CD pipelines and automated releases

We welcome contributions of all kinds - bug fixes, new features, documentation improvements, and more!
