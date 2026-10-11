# AI Engineering Fluency CLI

![AI Engineering Fluency](https://raw.githubusercontent.com/rajbos/ai-engineering-fluency/main/assets/AI%20Engineering%20Fluency%20-%20Transparent.png)

See how you use AI coding tools, straight from the session files they leave on your machine: token usage, estimated cost, fluency scores and environmental impact across GitHub Copilot (VS Code, Copilot CLI, JetBrains, Visual Studio), Claude Code, Gemini CLI, Codex CLI, OpenCode, Cursor and more. No editor required, and nothing is uploaded.

📖 **[Full documentation](https://github.com/rajbos/ai-engineering-fluency/blob/main/docs/cli/README.md)** — every command and option, configuration, data sources and troubleshooting.

## Quick start

```bash
# Run without installing
npx @rajbos/ai-engineering-fluency stats

# Or install globally
npm install -g @rajbos/ai-engineering-fluency
ai-engineering-fluency usage --cost
```

Requires **Node.js 22.14 or later**.

## Commands

| Command | What it shows |
|---|---|
| `stats` | Session files, chat turns and tokens found, per editor |
| `usage` | Tokens for today, this month, last month and the last 30 days; `--models`, `--cost` |
| `fluency` | Your fluency stage per category; `--tips` to level up |
| `environmental` / `env` | Estimated CO₂, water and tree equivalents |
| `diagnostics` | Every location searched and what was found — start here if something is missing |
| `curation` | MCP servers and skills you load but never use, with their prompt overhead |
| `memory-files` | Copilot agent memory-file hygiene; `--server` for the repository's server-side memories |
| `skill-suggestions` | Tasks you keep prompting for by hand — candidates for a reusable skill or prompt file |
| `segment` | Cached one-line summary for shell prompts (oh-my-posh) |
| `chart`, `usage-analysis`, `all` | JSON payloads for integrations |

Most commands accept `--json`. The global `--no-cache` option ignores the parsed-session cache and re-parses every file (`segment` keeps its own output cache; use `segment --refresh` to bypass it). Run `ai-engineering-fluency <command> --help` for all options, or see the [command reference](https://github.com/rajbos/ai-engineering-fluency/blob/main/docs/cli/README.md#commands).

## Programmatic use

The package also works as a Node library (CommonJS and ESM, with types). Pass it one session file and get back its token usage and cost:

```js
const { analyzeSessionFile } = require('@rajbos/ai-engineering-fluency/session');

const usage = await analyzeSessionFile('/home/me/.claude/projects/<project>/<session>.jsonl');
// usage?.modelUsage, usage?.totalTokens, usage?.estimatedCostUsd.provider,
// usage?.copilotCredits (exact Copilot billing, or null when not available)
```

It resolves to `null` for files it cannot parse, never writes to the console, and caches results in memory per file, so polling an unchanged file is cheap. Details: [Programmatic use](https://github.com/rajbos/ai-engineering-fluency/blob/main/docs/cli/README.md#programmatic-use).

## Configuration

There is no config file. The CLI finds sessions in each tool's default location and honours the same environment variables the tools do — `CODEX_HOME`, `HERMES_HOME`, `VIBE_HOME`, `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `APPDATA` / `LOCALAPPDATA` — and, inside WSL, also searches the Windows-side VS Code folders. Parsed results are cached in `~/.copilot-token-tracker/`.

Details: [Configuration](https://github.com/rajbos/ai-engineering-fluency/blob/main/docs/cli/README.md#configuration) · [Supported data sources](https://github.com/rajbos/ai-engineering-fluency/blob/main/docs/cli/README.md#data-sources) (with which ones record actual token counts and which are estimated) · [Troubleshooting](https://github.com/rajbos/ai-engineering-fluency/blob/main/docs/cli/README.md#troubleshooting)

## Privacy

Everything runs locally. The CLI reads session files and writes only its cache. The one network call is the opt-in `memory-files --server`, which uses your GitHub CLI sign-in to read the repository's Copilot memories from GitHub's Copilot API (read-only).

## Also available as

The same analysis runs inside [VS Code, Visual Studio and JetBrains IDEs](https://github.com/rajbos/ai-engineering-fluency#pick-your-tool), and as an [oh-my-posh prompt segment](https://github.com/rajbos/ai-engineering-fluency/blob/main/omp-segment/README.md).

## Contributing

Build and development notes are in the [CLI documentation](https://github.com/rajbos/ai-engineering-fluency/blob/main/docs/cli/README.md#development); release notes are in [CHANGELOG.md](https://github.com/rajbos/ai-engineering-fluency/blob/main/cli/CHANGELOG.md).

## License

MIT — see [LICENSE](https://github.com/rajbos/ai-engineering-fluency/blob/main/LICENSE).
