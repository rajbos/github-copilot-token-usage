# GitHub Copilot Token Tracker

![AI Engineering Fluency](assets/AI%20Engineering%20Fluency%20-%20Transparent.png)

Track your GitHub Copilot token usage and AI Fluency across VS Code, Visual Studio, and the command line. All data is read from local session logs — nothing leaves your machine unless you opt in to cloud sync.

[![Build](https://github.com/rajbos/github-copilot-token-usage/actions/workflows/build.yml/badge.svg)](https://github.com/rajbos/github-copilot-token-usage/actions/workflows/build.yml)

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

[![Install - VS Code](https://img.shields.io/badge/Install-VS%20Code-007ACC?logo=visualstudiocode)](https://marketplace.visualstudio.com/items?itemName=RobBos.copilot-token-tracker) [![Install - Windsurf (Open VSX)](https://img.shields.io/badge/Install-Windsurf-00B4D8?logo=open-vsx)](https://open-vsx.org/extension/RobBos/copilot-token-tracker) [![Open VSX installs](https://img.shields.io/open-vsx/dt/RobBos/copilot-token-tracker?label=Open%20VSX%20installs)](https://open-vsx.org/extension/RobBos/copilot-token-tracker)

```bash
# Install from the VS Code Marketplace
ext install RobBos.copilot-token-tracker

# Install from Open VSX (VSCodium)
codium --install-extension RobBos.copilot-token-tracker

# Install from Open VSX (Code OSS)
code --install-extension RobBos.copilot-token-tracker

# Install in Windsurf (Open VSX)
windsurf --install-extension RobBos.copilot-token-tracker
```

<details>
<summary><img src="assets/open-vsx-logo.svg" width="16"> <b>Windsurf (Open VSX)</b></summary>

```bash
# Install in Windsurf (Open VSX)
windsurf --install-extension RobBos.copilot-token-tracker
```

</details>

📖 [Full VS Code extension documentation](docs/vscode-extension/README.md)

---

### 🏗️ Visual Studio Extension

Token usage tracking inside Visual Studio 2022+, reading Copilot Chat session files directly.

[![Visual Studio Marketplace Installs](https://vsmarketplacebadges.dev/installs-short/RobBos.AIEngineeringFluency.svg)](https://marketplace.visualstudio.com/items?itemName=RobBos.AIEngineeringFluency)

📖 [Full Visual Studio extension documentation](docs/visual-studio/README.md)

---

### ⌨️ CLI

Run anywhere with Node.js — no editor required. Get usage stats, fluency scores, and environmental impact from the terminal.

[![npm downloads](https://img.shields.io/npm/dm/@rajbos/ai-engineering-fluency)](https://www.npmjs.com/package/@rajbos/ai-engineering-fluency)

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
