# GitHub Copilot Token Tracker — Repository Instructions

This document provides top-level guidance for AI agents contributing to this repository. Detailed, folder-specific instructions live in `.github/instructions/` and are applied automatically by Copilot when you work inside those folders.

## Repository Structure

```
/
├── build.ps1                    ← Root build orchestrator (all projects)
├── vscode-extension/            ← VS Code extension (TypeScript / Node.js)
├── cli/                         ← Command-line tool  (TypeScript / Node.js)
├── visualstudio-extension/      ← Visual Studio extension (C# / .NET, planned)
├── docs/                        ← Shared documentation
└── .github/
    ├── copilot-instructions.md  ← This file
    └── instructions/
        ├── vscode-extension.instructions.md   ← VS Code extension guide
        ├── cli.instructions.md                ← CLI guide
        ├── visualstudio-extension.instructions.md ← Visual Studio extension guide
        └── workflows.instructions.md           ← CI/CD workflow security guide
```

## Sub-project Instructions

| Folder | Instructions file |
|---|---|
| `vscode-extension/` | `.github/instructions/vscode-extension.instructions.md` |
| `cli/` | `.github/instructions/cli.instructions.md` |
| `visualstudio-extension/` | `.github/instructions/visualstudio-extension.instructions.md` |
| `.github/workflows/` | `.github/instructions/workflows.instructions.md` |

## Building Everything

Use the root orchestrator from the repo root:

```powershell
./build.ps1                          # build all projects
./build.ps1 -Project vscode          # build VS Code extension only
./build.ps1 -Project cli             # build CLI only
./build.ps1 -Project vscode -Target test   # run tests
```

Individual project builds:
```bash
cd vscode-extension && npm run compile   # VS Code extension
cd cli && npm run build                   # CLI
```

## Development Guidelines

- **Minimal Changes**: Only modify files directly needed for the task. Avoid touching unrelated files.
- **Focused Modifications**: Make surgical, precise changes without affecting other functionality.
- **Preserve Existing Structure**: Don't refactor or reorganize unless essential for the task.

## Coding Agent Data Sources

When running as the GitHub Copilot Coding Agent (bootstrapped via `.github/workflows/copilot-setup-steps.yml`), additional data files may be available in the workspace root. These are downloaded from Azure Storage during the agent's setup phase and are **not** present in local development.

- **`./session-logs/`**: Raw Copilot Chat session log files (last 7 days) from Azure Blob Storage.
- **`./usage-data/usage-agg-daily.json`**: Aggregated daily token usage data (last 30 days) from Azure Table Storage.

These files are only available when the repository's `copilot` GitHub environment has `COPILOT_STORAGE_ACCOUNT` configured. See the `session-log-data` skill in `.github/skills/session-log-data/SKILL.md` for data schemas, analysis examples, and cost estimation.

To check if data is available:
```bash
[ -d ./session-logs ] && echo "Session logs available"
[ -f ./usage-data/usage-agg-daily.json ] && echo "Aggregated data available"
```

## DevContainer Terminal Behavior

This repository uses a devcontainer (`.devcontainer/devcontainer.json`). When working inside the devcontainer, **terminal output capture is unreliable** — commands execute successfully but the `run_in_terminal` tool often returns empty or truncated output. This is a known limitation of the remote filesystem layer.

### What NOT to do

Do not enter retry loops trying to capture terminal output. These patterns waste turns and never converge:
- Running commands repeatedly hoping output will appear
- Redirecting output to `/tmp/` files and using `read_file` to read them (the remote FS often fails on newly-written temp files)
- Spawning background terminals with `sleep && tail` to poll for results
- Delegating to subagents to "run tests in a clean way"

### What to do instead

1. **Use `npm` scripts for standard operations** (from inside `vscode-extension/`):
   - `npm run compile` — lint + build
   - `npm run compile-tests` — compile test files to `out/`
   - `npm run test:node` — compile + run unit tests
   - `npm run test:coverage` — compile + run tests with coverage thresholds

2. **Use `get_errors` to validate compilation.** After edits, call `get_errors` on the changed files instead of running `tsc` in the terminal.

3. **Run tests in small batches.** Instead of running all test files in one command, run one file at a time:
   ```bash
   cd vscode-extension
   node --require ./out/test/unit/vscode-shim-register.js --test out/test/unit/sessionParser.test.js
   ```

4. **Accept a single run.** If a test command runs without returning output, do **not** re-run it.

5. **Write output to the workspace (not `/tmp/`).** If you must capture output to a file, write it inside the workspace where `read_file` can reliably access it.
