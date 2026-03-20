# Copilot Token Tracker CLI

Command-line interface for analyzing GitHub Copilot token usage from local session files. Works anywhere Copilot Chat stores its session data.

## Quick Start

```bash
# Run directly with npx (no install required)
npx copilot-token-tracker-cli stats

# Or install globally
npm install -g copilot-token-tracker-cli
copilot-token-tracker stats
```

## Commands

### `stats` - Session Overview

Show discovered session files, sessions, chat turns, and token counts.

```bash
copilot-token-tracker stats
copilot-token-tracker stats --verbose  # Show per-folder breakdown
```

![Terminal Statistics](../docs/images/Terminal%20Statistics.png)

### `usage` - Token Usage Report

Show token usage broken down by time period.

```bash
copilot-token-tracker usage
copilot-token-tracker usage --models  # Show per-model breakdown
copilot-token-tracker usage --cost    # Show estimated cost
```

![Terminal Usage](../docs/images/Terminal%20Usage.png)

### `environmental` - Environmental Impact

Show environmental impact of your Copilot usage (CO₂ emissions, water usage, tree equivalents).

```bash
copilot-token-tracker environmental
copilot-token-tracker env  # Short alias
```

### `fluency` - Fluency Score

Show your Copilot Fluency Score across multiple categories (Prompt Engineering, Context Engineering, Agentic, Tool Usage, Customization, Team Collaboration).

```bash
copilot-token-tracker fluency
copilot-token-tracker fluency --tips  # Show improvement tips, if there are any
```

### `diagnostics` - Search Locations & Stats

Show all locations searched for session files, whether each path exists, and per-location stats (files, sessions, chat turns, tokens).

```bash
copilot-token-tracker diagnostics
```

![Terminal Diagnostics](../docs/images/Terminal%20Diagnostitcs.png)

## Data Sources

The CLI scans the same session files that the [Copilot Token Tracker VS Code extension](https://marketplace.visualstudio.com/items?itemName=RobBos.copilot-token-tracker) uses:

- **VS Code** (Stable, Insiders, Exploration) workspace and global storage
- **VSCodium** and **Cursor** editor sessions
- **VS Code Remote** / Codespaces sessions
- **Copilot CLI** agent mode sessions
- **OpenCode** sessions (JSON and SQLite)

## Development

```bash
# From the repository root
npm run cli:build        # Build the CLI
npm run cli:stats        # Run stats command
npm run cli:usage        # Run usage command
npm run cli:environmental # Run environmental command
npm run cli:fluency      # Run fluency command
npm run cli:diagnostics  # Run diagnostics command
npm run cli -- --help    # Run any CLI command
```

## Requirements

- Node.js 18 or later
- GitHub Copilot Chat session files on the local machine

## License

MIT - See [LICENSE](../LICENSE) for details.
