# GitHub Copilot Token Tracker

A VS Code extension that shows your daily and monthly GitHub Copilot estimated token usage in the status bar. This uses the information from the log files of the GitHub Copilot Chat extension.

## Features

- **Real-time Token Tracking**: Displays current day and month token usage in the status bar
- **Automatic Updates**: Refreshes every 5 minutes to show the latest usage
- **Click to Refresh**: Click the status bar item to manually refresh the token count
- **Smart Estimation**: Uses character-based analysis with model-specific ratios for token estimation

## Status Bar Display

The extension shows token usage in the format: `# <today> | <this month>` in the status bar:

![Status Bar Display](docs/images/01%20Toolbar%20info.png)  

Hovering on the status bar item shows a detailed breakdown of token usage:
![Hover Details](docs/images/02%20Popup.png)

Clicking the status bar item opens a detailed view with comprehensive statistics:
![Detailed View](docs/images/03%20Detail%20panel.png)


## Known Issues

- The numbers shown are based on the logs that are available on your local machine. If you use multiple machines or the web version of Copilot, the numbers may not be accurate.
- Premium Requests are not tracked and shown in this extension
- The numbers are based on the amount of text in the chat sessions, not the actual tokens used. This is an estimation and may not be 100% accurate. We use an average character-to-token ratio for each model to estimate the token count, which is visible in the detail panel when you click on the status bar item.
- Same for the information on amount of trees that are needed to compensate your usage.

> **⚠️ Warning**
>
> This extension has only been tested on **Windows**. Other operating systems may not be supported or may require adjustments. PR's or test results for that are most welcome!

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

The project supports automated VSIX builds and releases when version tags are pushed:

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

