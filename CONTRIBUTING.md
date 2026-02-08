# Contributing to Copilot Token Tracker

Thank you for your interest in contributing to the Copilot Token Tracker extension! This guide will help you get started with development, especially when working with AI assistants like GitHub Copilot.

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
   git clone https://github.com/rajbos/github-copilot-token-usage.git
   cd github-copilot-token-usage
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
   - Dependencies will be installed via `npm install` (runs automatically)
   - All required VS Code extensions will be pre-installed

5. **Start developing:**
   - Run `npm run watch` to start the TypeScript compiler in watch mode
   - Press `F5` to launch the Extension Development Host

### What's Included in the DevContainer?

The devcontainer provides a complete, pre-configured development environment:

- **Base Image:** Node.js 22 on Debian Bookworm
- **Pre-installed Tools:**
  - Git
  - PowerShell (for running build scripts)
  - Node.js and npm
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
- **No Host System Impact:** AI-suggested npm installs, file operations, or scripts can't affect your personal system
- **Easy Reset:** If something goes wrong, you can rebuild the container in minutes without affecting your machine
- **Reproducible State:** Every time you rebuild, you get the same clean environment

### 🤖 AI Freedom Without Fear

The devcontainer allows you to confidently let AI assistants:

- **Execute Commands Freely:** Let AI run `npm install`, build scripts, or test commands without worrying about side effects
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
3. **AI executes:** `npm install <new-package>` directly in the container
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
- [npm](https://www.npmjs.com/) (comes with Node.js)
- [Visual Studio Code](https://code.visualstudio.com/)
- [Git](https://git-scm.com/)

### Setup Steps

1. **Clone the repository:**

   ```bash
   git clone https://github.com/rajbos/github-copilot-token-usage.git
   cd github-copilot-token-usage
   ```

2. **Install dependencies:**

   ```bash
   npm install
   ```

   **Note:** The project uses `package-lock.json` for reproducible builds. The `.npmrc` file ensures consistent behavior across different npm versions and environments. CI/CD workflows use `npm ci` to ensure exact dependency versions are installed.

3. **Build the extension:**

   ```bash
   npm run compile
   ```

4. **Start developing:**
   - Run `npm run watch` for auto-rebuild on changes
   - Press `F5` to launch the Extension Development Host

## Development Workflow

### Build and Compile

```bash
# One-time build
npm run compile

# Watch mode (auto-rebuild on changes)
npm run watch

# Production build
npm run package
```

### Running the Extension

To test and debug the extension in a local VS Code environment:

1. **Install dependencies** (if not already done):

   ```bash
   npm install
   ```

2. **Start watch mode** (automatically recompiles on file changes):

   ```bash
   npm run watch
   ```

3. **Press `F5`** in VS Code to launch the Extension Development Host
   - This opens a new VS Code window with the extension running
   - The original window shows debug output and allows you to set breakpoints

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
npx vsce package
```

### Debugging

- Set breakpoints in `src/extension.ts` or other TypeScript files
- Press `F5` to start debugging
- Open Developer Tools in the Extension Development Host: `Help > Toggle Developer Tools`
- View console output in the Debug Console

## Available Scripts

- `npm run lint` - Run ESLint to check code quality
- `npm run check-types` - Run TypeScript type checking
- `npm run compile` - Build development version (includes linting and type checking)
- `npm run package` - Build production version (optimized)
- `npm run watch` - Watch mode for development (auto-recompile on changes)
- `npm run watch:tsc` - TypeScript compiler in watch mode
- `npm run watch:esbuild` - esbuild bundler in watch mode
- `npm test` - Run tests (requires VS Code)
- `npm run watch-tests` - Run tests in watch mode

## NPM and Dependency Management

The project uses **`package-lock.json`** for reproducible builds and dependency consistency across all environments.

### Key Files

- **`.npmrc`**: Configures npm behavior (use `save-exact=true`, etc.)
- **`package-lock.json`**: Lockfile that pins exact dependency versions (committed to the repository)
- **`package.json`**: Defines project dependencies and scripts

### Installation Commands

**RECOMMENDED for day-to-day development:**

- **`npm ci`**: Clean install from lockfile
  - Requires `package-lock.json` to exist
  - Installs exact versions from the lockfile (no modifications)
  - Deletes `node_modules` before installing
  - **Use this after pulling changes** to avoid lockfile churn
  - **Used in all CI/CD workflows** for reproducible builds
  - Faster and more reliable than `npm install`

**Only when adding/updating dependencies:**

- **`npm install`**: Install/update dependencies
  - Respects `package-lock.json` and may update it
  - Use when adding new dependencies: `npm install <package>`
  - Use when updating dependencies: `npm install <package>@latest`
  - **After adding dependencies, commit both `package.json` and `package-lock.json`**

### Best Practices

1. **Use `npm ci` for routine development** - This prevents accidental lockfile changes and ensures you have the exact dependency versions
2. **Only use `npm install` when intentionally changing dependencies** - This makes dependency updates explicit and trackable
3. **Always commit both files together** - When you modify dependencies, commit both `package.json` and `package-lock.json` in the same commit
4. **Don't manually edit `package-lock.json`** - Let npm manage it automatically

### Why We Use package-lock.json

1. **Reproducible Builds**: Ensures all developers and CI/CD get identical dependency versions
2. **Consistency**: Prevents "works on my machine" issues caused by different dependency versions
3. **Security**: Locks down transitive dependencies to prevent supply chain attacks
4. **Performance**: CI/CD can cache dependencies more effectively with a lockfile

### About Peer Dependencies and "peer": true

Different npm versions (7+) may add or remove `"peer": true` properties in `package-lock.json` when running `npm install`. This is expected behavior for peer dependencies that aren't satisfied.

Some dependencies (like `@vscode/webview-ui-toolkit`) declare peer dependencies (e.g., `react`) that we don't use directly. You may see entries like this in `package-lock.json`:

```json
"node_modules/react": {
  "version": "19.2.3",
  "peer": true,
  ...
}
```

**This is normal and doesn't affect functionality.** To avoid lockfile churn from these changes:

- **Use `npm ci` for routine development** (doesn't modify the lockfile)
- Only use `npm install` when you're intentionally adding or updating dependencies
- If you accidentally modify the lockfile, run `git checkout package-lock.json` to restore it

## Code Guidelines

### Project Structure

- **All extension logic** is in `src/extension.ts` in the `CopilotTokenTracker` class
- **Data files** are in JSON format: `tokenEstimators.json`, `modelPricing.json`, `toolNames.json`
- **Webview code** is in `src/webview/` organized by feature
- **See `src/README.md`** for detailed guidance on updating JSON data files

### Development Principles

1. **Minimal Changes:** Only modify files directly needed for your changes
2. **Focused Modifications:** Make surgical, precise changes
3. **Preserve Structure:** Maintain existing code organization
4. **Follow Conventions:** See `.github/copilot-instructions.md` for extension-specific patterns

### Before Submitting

Always run a full build to ensure code quality:

```bash
npm run compile
```

This will:

- Lint your code with ESLint
- Type-check with TypeScript
- Build the extension with esbuild

## Testing

- Test the extension manually in the Extension Development Host (F5)
- Verify token tracking works correctly
- Check that webviews render properly
- Ensure status bar updates as expected
- Run `npm test` to execute automated tests
- Ensure all tests pass before submitting changes

## CI/CD

The project includes comprehensive GitHub Actions workflows:

### Build Pipeline

- **Platforms:** Tests on Ubuntu, Windows, and macOS
- **Node Versions:** 18.x and 20.x
- **Checks:** Linting, type checking, compilation, and packaging
- **Badge:** [![Build](https://github.com/rajbos/github-copilot-token-usage/actions/workflows/build.yml/badge.svg)](https://github.com/rajbos/github-copilot-token-usage/actions/workflows/build.yml)

### What Gets Tested

1. **Linting:** ESLint checks for code quality issues
2. **Type Checking:** TypeScript validates all types
3. **Compilation:** esbuild creates the production bundle
4. **Packaging:** VSIX package is created and validated
5. **Extension Tests:** VS Code extension tests run in CI

All builds must pass these checks before merging.

## Release Process

The project supports automated VSIX builds and releases through two methods:

### Method 1: Manual Trigger via GitHub UI (Recommended)

1. **Update the version** in `package.json`
2. **Commit and push** your changes to the main branch
3. **Go to GitHub Actions** → Release workflow
4. **Click "Run workflow"** and confirm

The workflow will automatically:

- Create a tag based on the version in `package.json`
- Run the full build pipeline (lint, type-check, compile, test)
- Create a VSIX package
- Create a GitHub release with auto-generated release notes
- Attach the VSIX file as a release asset

Then run the `./publish.ps1` script to publish to the marketplace.

### Method 2: Tag-Based Release (Traditional)

1. **Update the version** in `package.json`
2. **Commit your changes**
3. **Create and push a version tag:**
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

The project automatically keeps `CHANGELOG.md` synchronized with GitHub release notes:

**Manual Sync:**

```bash
npm run sync-changelog
```

**Automatic Sync:**
The GitHub workflow automatically updates `CHANGELOG.md` whenever:

- A new release is published
- An existing release is edited
- The workflow is manually triggered

**Test the Sync:**

```bash
npm run sync-changelog:test
```

This ensures the local changelog always reflects the latest release information from GitHub.

## Submitting Changes

1. **Fork the repository** on GitHub
2. **Create a feature branch** from `main`
3. **Make your changes** in the devcontainer
4. **Test thoroughly** using the Extension Development Host
5. **Run `npm run compile`** to ensure everything builds
6. **Commit with clear messages** describing your changes
7. **Push to your fork** and create a Pull Request

### Pull Request Guidelines

- Provide a clear description of what your PR does
- Reference any related issues
- Include screenshots/videos for UI changes
- Ensure all checks pass
- Be responsive to code review feedback

## Questions or Issues?

- **Bug Reports:** Open an issue on [GitHub Issues](https://github.com/rajbos/github-copilot-token-usage/issues)
- **Feature Requests:** Submit as a GitHub issue with the "enhancement" label
- **Questions:** Ask in the issue comments or discussions

## Additional Resources

- [VS Code Extension API](https://code.visualstudio.com/api)
- [Development Containers](https://containers.dev/)
- [TypeScript Documentation](https://www.typescriptlang.org/docs/)
- [Extension Testing Guide](https://code.visualstudio.com/api/working-with-extensions/testing-extension)

---

Thank you for contributing! Your efforts help make token tracking better for the entire GitHub Copilot community. 🚀
