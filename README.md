# GitHub Copilot Token Tracker

![AI Engineering Fluency](assets/AI%20Engineering%20Fluency%20-%20Transparent.png)

Track your GitHub Copilot token usage and AI Fluency across VS Code, Visual Studio, and the command line. All data is read from local session logs — nothing leaves your machine unless you opt in to cloud sync.

[![Build](https://github.com/rajbos/github-copilot-token-usage/actions/workflows/build.yml/badge.svg)](https://github.com/rajbos/github-copilot-token-usage/actions/workflows/build.yml)
[![Visual Studio Marketplace Downloads](https://img.shields.io/visual-studio-marketplace/d/RobBos.AIEngineeringFluency)](https://marketplace.visualstudio.com/items?itemName=RobBos.AIEngineeringFluency)

## Supported AI engineering tools

- VS Code + GitHub Copilot (Stable, Insiders, Exploration)
- VSCodium / Cursor
- GitHub Copilot CLI
- OpenCode + GitHub Copilot
- Crush + GitHub Copilot
- Claude Code (Anthropic)
- Claude Desktop Cowork (Anthropic)
- Visual Studio + GitHub Copilot

---

## Pick your tool

### 🖥️ VS Code Extension

Real-time token usage in the status bar, fluency score dashboard, usage analysis, cloud sync, and more.

[![Visual Studio Marketplace Downloads](https://img.shields.io/visual-studio-marketplace/d/RobBos.copilot-token-tracker)](https://marketplace.visualstudio.com/items?itemName=RobBos.copilot-token-tracker)

```bash
# Install from the VS Code Marketplace
ext install RobBos.copilot-token-tracker
```

📖 [Full VS Code extension documentation](docs/vscode-extension/README.md)

---

### 🏗️ Visual Studio Extension

Token usage tracking inside Visual Studio 2022+, reading Copilot Chat session files directly.

> Counts are **estimated** — VS session files do not store raw LLM token counts.

📖 [Full Visual Studio extension documentation](docs/visual-studio/README.md)

---

### ⌨️ CLI

Run anywhere with Node.js — no editor required. Get usage stats, fluency scores, and environmental impact from the terminal.

```bash
npx @rajbos/ai-engineering-fluency stats
```

📖 [Full CLI documentation](docs/cli/README.md)

---

## Contributing

Interested in contributing? Check out our [Contributing Guide](CONTRIBUTING.md) for:

- 🐳 **DevContainer Setup** — Isolated development environment
- 🔧 **Build & Debug Instructions** — How to run and test locally
- 📋 **Code Guidelines** — Project structure and development principles
- 🚀 **Release Process** — CI/CD pipelines and automated releases

We welcome contributions of all kinds — bug fixes, new features, documentation improvements, and more!
