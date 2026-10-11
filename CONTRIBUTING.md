# Contributing to AI Engineering Fluency

Thank you for your interest in contributing to the AI Engineering Fluency extension! This guide will help you get started with development, especially when working with AI assistants like GitHub Copilot.

## Table of Contents

- [Development Environment Setup](#development-environment-setup)
- [Using the DevContainer (Recommended)](#using-the-devcontainer-recommended)
- [Why Use a DevContainer for AI-Assisted Development?](#why-use-a-devcontainer-for-ai-assisted-development)
- [Manual Local Setup](#manual-local-setup)
- [Development Workflow](#development-workflow)
- [Available Scripts](#available-scripts)
- [Code Guidelines](#code-guidelines)
- [Testing](#testing)
- [CI/CD](#cicd)
- [Pre-Release Checklist](#pre-release-checklist)
- [Release Process](#release-process)
- [Submitting Changes](#submitting-changes)

## Development Environment Setup

You have two options for setting up your development environment:

1. **Using the DevContainer** (Recommended for AI-assisted development)
2. Manual local setup

### Prerequisites

- [Visual Studio Code](https://code.visualstudio.com/)
- [Docker Desktop](https://www.docker.com/products/docker-desktop)
- [Dev Containers extension](https://marketplace.visualstudio.com/items?itemName=ms-vscode-remote.remote-containers) for VS Code

## Using the DevContainer (Recommended)

### Quick Start

1. **Clone the repository:**

   ```bash
   git clone https://github.com/rajbos/ai-engineering-fluency.git
   cd ai-engineering-fluency
   ```

2. **Open in VS Code:**

   ```bash
   code .
   ```

3. **Reopen in Container:**
   - When prompted, click "Reopen in Container"
   - Or use the Command Palette (`F1`) and select **Dev Containers: Reopen in Container**

4. **Wait for setup:**
   - The container will build and initialize automatically
   - Dependencies will be installed via `pnpm install` (runs automatically)
   - All required VS Code extensions will be pre-installed

5. **Start developing:**
   - Run `pnpm run watch` to start the TypeScript compiler in watch mode
   - Press `F5` to launch the Extension Development Host

### What's Included in the DevContainer?

The devcontainer provides a complete, pre-configured development environment:

- **Base Image:** Node.js 22 on Debian Bookworm
- **Pre-installed Tools:**
  - Git
  - PowerShell (for running build scripts)
  - Node.js and pnpm
- **VS Code Extensions:**
  - ESLint (code linting)
  - Prettier (code formatting)
  - Extension Test Runner
  - TSL Problem Matcher
  - GitHub Copilot & Copilot Chat
- **Optimized Settings:**
  - Format on save enabled
  - ESLint integration
  - TypeScript support

## Why Use a DevContainer for AI-Assisted Development?

The devcontainer is **especially valuable when working with AI coding assistants** like GitHub Copilot or other AI agents. Here's why:

### 🛡️ Isolation and Safety

When you give AI assistants permission to execute commands, install packages, or make system changes, you want protection:

- **Sandboxed Environment:** The container runs in complete isolation from your host machine
- **No Host System Impact:** AI-suggested pnpm installs, file operations, or scripts can't affect your personal system
- **Easy Reset:** If something goes wrong, you can rebuild the container in minutes without affecting your machine
- **Reproducible State:** Every time you rebuild, you get the same clean environment

### 🤖 AI Freedom Without Fear

The devcontainer allows you to confidently let AI assistants:

- **Execute Commands Freely:** Let AI run `pnpm install`, build scripts, or test commands without worrying about side effects
- **Install Packages:** AI can suggest and install experimental packages without polluting your global environment
- **Modify Configuration:** Let AI experiment with settings, configs, or tooling versions safely
- **Run Tests:** Execute test suites that might create temporary files or modify state
- **Try Experimental Changes:** Let AI make bold refactoring suggestions you can test risk-free

### 🔄 Consistency Across Development

- **Identical Environments:** Everyone (including AI) works with the exact same Node version, dependencies, and tools
- **Version Lock:** No "works on my machine" issues caused by different Node or npm versions
- **Extension Parity:** All developers have the same VS Code extensions and settings
- **Reproducible Builds:** AI-assisted changes will behave the same way for all contributors

### 🚀 Faster Onboarding for AI

- **Zero Configuration:** AI can start working immediately without environment setup
- **Pre-installed Tools:** All required dependencies are ready to go
- **Known State:** AI agents can make more accurate suggestions knowing the exact environment
- **Automatic Setup:** The `postCreateCommand` ensures dependencies are always up-to-date

### 💡 Real-World Scenario

Imagine this workflow with AI assistance:

1. **You ask:** "Add support for tracking a new model type"
2. **AI suggests:** Code changes + a new npm package dependency
3. **AI executes:** `pnpm install <new-package>` directly in the container
4. **AI tests:** Runs the extension and verifies it works
5. **Result:** If something breaks, you simply rebuild the container - your host machine is untouched

Without a devcontainer, you'd need to:

- Manually review every command before execution
- Worry about package conflicts with other projects
- Risk system-level changes
- Potentially need to uninstall packages or revert changes

## Manual Local Setup

If you prefer not to use the devcontainer, you can set up the extension locally:

### Prerequisites

- [Node.js](https://nodejs.org/) 18.x or 20.x
- [pnpm](https://pnpm.io/) (install via `npm install -g pnpm` or `corepack enable`)
- [Visual Studio Code](https://code.visualstudio.com/)
- [Git](https://git-scm.com/)

### Setup Steps

1. **Clone the repository:**

   ```bash
   git clone https://github.com/rajbos/ai-engineering-fluency.git
   cd ai-engineering-fluency
   ```

2. **Install dependencies:**

   ```bash
   pnpm install
   ```

   **Note:** The project uses `pnpm-lock.yaml` for reproducible builds. CI/CD workflows use `pnpm install --frozen-lockfile` to ensure exact dependency versions are installed.

3. **Build the extension:**

   ```bash
   pnpm run compile
   ```

4. **Start developing:**
   - Run `pnpm run watch` for auto-rebuild on changes
   - Press `F5` to launch the Extension Development Host

## Development Workflow

### Build and Compile

```bash
# One-time build
pnpm run compile

# Watch mode (auto-rebuild on changes)
pnpm run watch

# Production build
pnpm run package
```

### Running the Extension

To test and debug the extension in a local VS Code environment:

1. **Install dependencies** (if not already done):

   ```bash
   pnpm install
   ```

2. **Start watch mode** (automatically recompiles on file changes):

   ```bash
   pnpm run watch
   ```

3. **Press `F5`** in VS Code to launch the Extension Development Host
   - This opens a new VS Code window with the extension running
   - The original window shows debug output and allows you to set breakpoints
   - The launch profile disables both published extension IDs so the dev build does not fight an installed marketplace copy for the same commands

4. **In the Extension Development Host window:**
   - The extension will be active and you'll see the token tracker in the status bar
   - Any changes you make to the code will be automatically compiled (thanks to watch mode)
   - Reload the Extension Development Host window (Ctrl+R or Cmd+R) to see your changes

5. **To view console logs and debug information:**
   - In the Extension Development Host window, open Developer Tools: `Help > Toggle Developer Tools`
   - Check the Console tab for any `console.log` output from the extension

### Creating a VSIX Package

To create an installable VSIX package:

```bash
pnpm exec vsce package
```

### Debugging

- Set breakpoints in `src/extension.ts` or other TypeScript files
- Press `F5` to start debugging
- Open Developer Tools in the Extension Development Host: `Help > Toggle Developer Tools`
- View console output in the Debug Console

## Available Scripts

- `pnpm run lint` - Run ESLint to check code quality
- `pnpm run lint:css` - Run Stylelint to check CSS code quality
- `pnpm run lint:json` - Validate all JSON files in the repository
- `pnpm run check-types` - Run TypeScript type checking
- `pnpm run compile` - Build development version (includes linting and type checking)
- `pnpm run package` - Build production version (optimized)
- `pnpm run watch` - Watch mode for development (auto-recompile on changes)
- `pnpm run watch:tsc` - TypeScript compiler in watch mode
- `pnpm run watch:esbuild` - esbuild bundler in watch mode
- `pnpm test` - Run tests (requires VS Code)
- `pnpm run watch-tests` - Run tests in watch mode

## pnpm and Dependency Management

The project uses **`pnpm-lock.yaml`** for reproducible builds and dependency consistency across all environments for the pnpm-managed packages (`vscode-extension/`, `cli/`, `sharing-server/`, `desktop/`). Auxiliary tooling (`release-video/`, `.github/scripts/`, `.github/workflows/dependencies/`, and some skill packages) still uses npm and its own `package-lock.json`; follow each folder's README for those.

### Key Files

- **`.npmrc`**: Configures pnpm behavior
- **`pnpm-lock.yaml`**: Lockfile that pins exact dependency versions (committed to the repository)
- **`package.json`**: Defines project dependencies and scripts

### Installation Commands

**RECOMMENDED for day-to-day development:**

- **`pnpm install --frozen-lockfile`**: Clean install from lockfile
  - Requires `pnpm-lock.yaml` to exist
  - Installs exact versions from the lockfile (no modifications)
  - **Use this after pulling changes** to avoid lockfile churn
  - **Used in all CI/CD workflows** for reproducible builds

**Only when adding/updating dependencies:**

- **`pnpm install`**: Install/update dependencies
  - Respects `pnpm-lock.yaml` and may update it
  - Use when adding new dependencies: `pnpm install <package>`
  - Use when updating dependencies: `pnpm install <package>@latest`
  - **After adding dependencies, commit both `package.json` and `pnpm-lock.yaml`**

### Best Practices

1. **Use `pnpm install --frozen-lockfile` for routine development** - This prevents accidental lockfile changes and ensures you have the exact dependency versions
2. **Only use `pnpm install` when intentionally changing dependencies** - This makes dependency updates explicit and trackable
3. **Always commit both files together** - When you modify dependencies, commit both `package.json` and `pnpm-lock.yaml` in the same commit
4. **Don't manually edit `pnpm-lock.yaml`** - Let pnpm manage it automatically

### Why We Use pnpm-lock.yaml

1. **Reproducible Builds**: Ensures all developers and CI/CD get identical dependency versions
2. **Consistency**: Prevents "works on my machine" issues caused by different dependency versions
3. **Security**: Locks down transitive dependencies to prevent supply chain attacks
4. **Performance**: pnpm's content-addressable store makes installs faster with a lockfile

## Code Guidelines

### Project Structure

- **Extension entry point and orchestration** are in `vscode-extension/src/extension.ts` (the `CopilotTokenTracker` class); put new logic in separate modules rather than adding to it (see `AGENTS.md`)
- **Shared code** (session parsing, token estimation, adapters) lives in the repo-root `src/` folder and is consumed by both the VS Code extension and the CLI
- **Data files** are in JSON format in the repo-root `src/` folder: `tokenEstimators.json`, `modelPricing.json`, `toolNames.json`
- **Webview code** is in `vscode-extension/src/webview/` organized by feature
- **See the repo-root `src/README.md`** for detailed guidance on updating JSON data files

### Development Principles

Sharing-server contributions (including tests, docs and downstream overrides)
must follow the [server data separation contract](sharing-server/AGENTS.md).
For server build and test commands, use the
[server validation guidance](docs/VALIDATION.md#sharing-server), not the
extension-specific workflow below.

1. **Minimal Changes:** Only modify files directly needed for your changes
2. **Focused Modifications:** Make surgical, precise changes
3. **Preserve Structure:** Maintain existing code organization
4. **Follow Conventions:** See `.github/copilot-instructions.md` for extension-specific patterns

### Before Submitting

Always run a full build to ensure code quality:

```bash
pnpm run compile
```

### JSON File Validation

The repository includes automatic validation of all JSON files. This ensures that:

- All JSON files contain valid JSON syntax
- JSONC files (JSON with Comments) are properly formatted
- Configuration files (tsconfig, VS Code settings) are valid

**Validated Files:**

- Core JSON data: `src/tokenEstimators.json`, `src/modelPricing.json`, `src/toolNames.json`, `src/customizationPatterns.json`
- Configuration: `package.json`, `tsconfig.json`, `.vscode/*.json`, `.devcontainer/devcontainer.json`
- Schemas: `docs/logFilesSchema/*.json`

**Run JSON validation manually:**

```bash
pnpm run lint:json
```

**Note:** JSON validation is automatically run in CI/CD pipelines to catch syntax errors early.

## Testing

For the sharing server, follow the [required privacy tests](sharing-server/AGENTS.md#required-validation)
and [server validation guidance](docs/VALIDATION.md#sharing-server). Tests use
isolated SQLite fixtures and stubbed GitHub access, never production data.

- Test the extension manually in the Extension Development Host (F5)
- Verify token tracking works correctly
- Check that webviews render properly
- Ensure status bar updates as expected
- Run `pnpm test` to execute automated tests
- Ensure all tests pass before submitting changes

## CI/CD

The project includes comprehensive GitHub Actions workflows:

### Build Pipeline

- **Platforms:** Tests on Ubuntu, Windows, and macOS
- **Node Versions:** 18.x and 20.x
- **Checks:** Linting, type checking, compilation, and packaging
- **Badge:** [![Build](https://github.com/rajbos/ai-engineering-fluency/actions/workflows/build.yml/badge.svg)](https://github.com/rajbos/ai-engineering-fluency/actions/workflows/build.yml)

### What Gets Tested

1. **JSON Validation:** All JSON and JSONC files are validated for correct syntax
2. **Linting:** ESLint checks for code quality issues
3. **Type Checking:** TypeScript validates all types
4. **Compilation:** esbuild creates the production bundle
5. **Packaging:** VSIX package is created and validated
6. **Extension Tests:** VS Code extension tests run in CI

All builds must pass these checks before merging.

## Pre-Release Checklist

Run `pnpm run pre-release` to validate the version and compile.

- [ ] Version bumped in `package.json`
- [ ] `pnpm run compile` completed successfully
- [ ] Commit and push to main branch
- [ ] Trigger Release workflow (GitHub UI → Actions → Release → Run workflow)

The workflow handles everything else: tagging, building, testing, creating the GitHub release, publishing to the marketplace, and updating the changelog.

## Release Process

The project uses a fully automated release pipeline via GitHub Actions.

### One-Step Release (Recommended)

1. **Update the version** in `package.json`
2. **Commit and push** to the main branch
3. **Go to GitHub Actions** → Release workflow → **Run workflow**

The workflow inputs:
- `create_tag` — Creates a git tag from the `package.json` version (default: true)
- `publish_marketplace` — Publishes to the VS Code Marketplace and Open VSX (default: true)

The workflow automatically:

1. Creates a version tag (e.g., `v0.0.19`)
2. Generates release notes from merged PRs (using `.github/release.yml` categories)
3. Updates `CHANGELOG.md` in the VSIX package so the extension ships with current notes
4. Runs the full build pipeline (lint, type-check, compile, test)
5. Creates a GitHub Release with the VSIX attached
6. Publishes to the VS Code Marketplace (using the `VSCE_PAT` secret)
7. Publishes to the Open VSX Registry (using the `OPEN_VSX_TOKEN` secret)
8. Opens a PR to sync `CHANGELOG.md` in the repository

> **Security:** Only users with repository write access can trigger the `workflow_dispatch`. The `VSCE_PAT` secret must be configured in repository settings (Settings → Secrets and variables → Actions). Create a PAT at https://dev.azure.com with the "Marketplace (Publish)" scope. The `OPEN_VSX_TOKEN` secret must also be configured; create a token at https://open-vsx.org/user-settings/tokens.

### Tag-Based Release (Build Only)

Pushing a version tag (e.g., `git push origin v0.0.19`) triggers the build and creates a GitHub release, but does **not** publish to the marketplaces. Use the workflow dispatch for the full pipeline.

### Manual Changelog Sync

To manually sync the changelog with all GitHub release notes:

```bash
pnpm run sync-changelog
```

Or trigger the **Sync Release Notes** workflow from the Actions tab.

### Manual Publish (Fallback)

If you need to re-publish manually (e.g., after a marketplace upload failure):

```powershell
.\publish.ps1 -VsixPath ".\ai-engineering-fluency-0.0.19.vsix"
```

## Submitting Changes

1. **Fork the repository** on GitHub
2. **Create a feature branch** from `main`
3. **Make your changes** in the devcontainer
4. **Test thoroughly** using the Extension Development Host
5. **Run `pnpm run compile`** to ensure everything builds
6. **Commit with clear messages** describing your changes
7. **Push to your fork** and create a Pull Request

### Pull Request Guidelines

- Provide a clear description of what your PR does
- Reference any related issues
- Include screenshots/videos for UI changes
- Ensure all checks pass
- Be responsive to code review feedback

## Questions or Issues?

- **Bug Reports:** Open an issue on [GitHub Issues](https://github.com/rajbos/ai-engineering-fluency/issues)
- **Feature Requests:** Submit as a GitHub issue with the "enhancement" label
- **Questions:** Ask in the issue comments or discussions

## Additional Resources

- [VS Code Extension API](https://code.visualstudio.com/api)
- [Development Containers](https://containers.dev/)
- [TypeScript Documentation](https://www.typescriptlang.org/docs/)
- [Extension Testing Guide](https://code.visualstudio.com/api/working-with-extensions/testing-extension)

---

Thank you for contributing! Your efforts help make token tracking better for the entire GitHub Copilot community. 🚀
