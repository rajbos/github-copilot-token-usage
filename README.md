# GitHub Copilot Token Tracker

A VS Code extension that shows your daily and monthly GitHub Copilot estimated token usage in the status bar. This uses the information from the log files of the GitHub Copilot Chat extension.

## Features

- **Real-time Token Tracking**: Displays current day and month token usage in the status bar
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

