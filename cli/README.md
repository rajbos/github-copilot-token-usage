# Copilot Token Tracker CLI

![AI Engineering Fluency](../assets/AI%20Engineering%20Fluency%20-%20Transparent.png)

> For user-facing documentation and command examples, see [docs/cli/README.md](../docs/cli/README.md).

📦 **npm**: [@rajbos/ai-engineering-fluency](https://www.npmjs.com/package/@rajbos/ai-engineering-fluency)

## Development

```bash
# From the repository root
npm run cli:build           # Build the CLI
npm run cli:stats           # Run stats command
npm run cli:usage           # Run usage command
npm run cli:environmental   # Run environmental command
npm run cli:fluency         # Run fluency command
npm run cli:diagnostics     # Run diagnostics command
npm run cli -- --help       # Run any CLI command
```

## Requirements

- Node.js 18 or later
- GitHub Copilot Chat session files on the local machine

## Data Sources

The CLI reads the same local session sources as the extension, including:

- GitHub Copilot Chat / Copilot CLI sessions
- OpenCode, Claude Code, and Gemini CLI sessions
- Other supported editor integrations wired through the shared adapter pipeline

## License

MIT — see [LICENSE](../LICENSE) for details.
