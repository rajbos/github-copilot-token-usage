# Change Log

All notable changes to the CLI (@rajbos/ai-engineering-fluency) will be documented in this file.

## [Unreleased]

## [0.7.0] - 2026-10-10

### Features
- **Programmatic use:** the package now works as a Node library. `require('@rajbos/ai-engineering-fluency/session')` (or `import`) gives you `analyzeSessionFile()` and `analyzeSessionFiles()`, which return per-session token usage per model, an estimated USD cost at provider and Copilot rates, and the exact GitHub Copilot billed amount (`copilotNanoAiu`, `copilotCredits`) when the session records it. Results are cached in memory by file path, modification time and size, so polling a running session is cheap. Unknown files resolve to `null` instead of throwing, nothing is written to the console, and the CLI's on-disk cache is left alone. It ships with TypeScript types. See [Programmatic use](https://github.com/rajbos/ai-engineering-fluency/blob/main/docs/cli/README.md#programmatic-use).
- New `skill-suggestions` command: finds tasks you keep prompting for by hand (similar first prompts across sessions) as candidates for a reusable skill or prompt file — the same report as the VS Code extension's Skill Suggestions section, built by the same shared code. `--json` leaves prompt text, prompt-derived keywords and session titles out unless `--include-prompts` is passed. `usage-analysis --json --repeated-tasks` adds the report to the usage-analysis payload (#2288)

### Bug Fixes
- The exact Copilot billed amount for a Copilot CLI session is the latest `session.usage_checkpoint` or `session.shutdown` value. `totalNanoAiu` is a running total for the whole session, so the previous sum over shutdowns counted resumed sessions more than once. Sessions that are still running now get the amount from their latest checkpoint.

## [0.6.2] - 2026-10-02

### Bug Fixes
- Eclipse, Pi, Devin CLI and Hermes sessions are now labelled correctly, and relocated agent homes are honoured (#2238)
- Copilot Chat debug logs are now found on macOS and Linux (#2237)

### Changed
- The npm package page now has user-facing documentation instead of build notes, and the [CLI reference](https://github.com/rajbos/ai-engineering-fluency/blob/main/docs/cli/README.md) covers every command and option, the environment variables that change where sessions are found, the cache files, every supported data source (with which record actual token counts), troubleshooting and privacy. The stated Node.js requirement is corrected to 22.14 or later.
- `--help` now shows the installed command name, `ai-engineering-fluency`, instead of `copilot-token-tracker`.

## [0.6.1] - 2026-09-28

### Changed
- **`environmental` estimates are now based on published research, and for most people they are much lower.** CO₂ and water used to be flat guesses with no source (0.2 g CO₂e and 0.3 L of water per 1,000 tokens). They are now derived from Jegham et al., *How Hungry is AI?* ([arXiv:2505.09598](https://arxiv.org/abs/2505.09598)) via [neuland/tokendashboard-backend](https://github.com/neuland/tokendashboard-backend/blob/main/docs/co2-methodology.md): tokens are weighted by type (output fully, fresh input 1/20, cache reads almost nothing), each model is scaled from Claude Sonnet by its output-token price, and water uses the paper's cooling-plus-generation formula. Expect sharply lower figures for cache-heavy agent use (one real 30-day history: CO₂ about 38× lower, water about 3,000× lower) and smaller changes for sessions without a per-model breakdown. **Some usage can come out higher than before:** output-heavy work on large models counts up to 1,400 g CO₂e per million output tokens for Opus (2,800 g for Fable), against the old flat 200 g per million tokens. The command's methodology header now prints the reference values and weights used.

### Features
- `memory-files --server` also fetches the repository's server-side Copilot memories (the per-repository store GitHub keeps for the coding agent; needs network and the GitHub CLI), with `--repo`, `--limit`, and `--promote` to print promotion candidates as a Markdown block for `AGENTS.md` (#2134)

### Bug Fixes
- Mistral Vibe sessions no longer overstate cost: cached input tokens are priced separately, and `glm-5-2` / `devstral-2` usage is no longer counted as free (#2152)
- Recognise Visual Studio Copilot sessions stored in Visual Studio's AppData folder (chats started without a solution open) (#2139)

## [0.6.0] - 2026-09-18

### Features
- Group models from user-configured custom endpoints (BYOK) under their own provider group (e.g. `Mistral (Custom)`) in the provider cost chart data
- Add `--json` flag to `segment` command, so oh-my-posh/prompt hooks can get structured per-period token data from the fast, cached `segment` path instead of the uncached `usage --json` command
- New `memory-files` command reporting on the GitHub Copilot agent memory files on this machine: counts, staleness and size (`--stale-days`, `--large-kb`, `--json`) (#2094)
- Track Kilo Code sessions
- Apply the Copilot Auto routing discount to eligible cost estimates
- Classify sessions into task categories in the shared stats

### Bug Fixes
- Fix `posh-hook.ps1` reference hook blocking shell startup for 45-80+ seconds by calling `usage --json` synchronously; it now reads from a cache file and refreshes in a detached background process
- Claude Code sessions are no longer misclassified as CLI in interaction modes
- Discover Claude Desktop sessions in the renamed `claude-code-sessions` directory
- Recognise Copilot App's `<repo>.worktrees` worktree layout when attributing sessions to repositories (#1827)
- Recognise MCP tools by family and action, so the same tool no longer shows up as several unknown tools (#1771)

### Security
- Bound untrusted session-file reads and guard JSON merges against prototype pollution across all session parsers (#1767, #1772)

### Performance
- Faster Copilot CLI session discovery

## [0.5.0] - 2026-07-27

### Features
- Track Hermes Agent sessions (#1729)
- Sub-agent and delegation usage now counts in fluency scoring and hints (#1747)

### Bug Fixes
- Input tokens no longer exceed total tokens in period stats (#1743)
- Sessions in a git worktree are attributed to the repository, not the worktree name

## [0.4.0] - 2026-07-21

### Features
- Track OpenAI Codex CLI and Cline (VS Code extension) sessions (#1644)
- Distinguish Copilot desktop app sessions from terminal Copilot CLI sessions
- Report net (active) session duration, keeping wall-clock time available

### Bug Fixes
- Per-model usage now reconciles to the actual token total for event-based sessions without debug logs

## [0.3.0] - 2026-07-17

### Features
- Exact Copilot CLI token counts, read from its OpenTelemetry export and the authoritative `session-store.db` billing data instead of estimates (#1637)
- Track Devin and Devin CLI sessions
- Stats APIs include per-editor model usage and today's sessions
- Long-context pricing for models that charge more above a context threshold

### Bug Fixes
- Attribute Claude Code CLI sessions separately from the Claude Code VS Code extension, and Claude Desktop separately from Claude Code (#1593)
- Claude Code: attribute multi-day sessions by day, include sub-agent transcripts, and de-duplicate their messages
- Price Claude 1-hour cache-write tokens at their own rate (#1589)
- Per-model token breakdowns reconcile to debug-log totals (#1636)
- Non-Copilot sessions no longer inflate estimated GitHub Copilot spend

### Performance
- Bulk-load Copilot CLI session metadata instead of querying per session

## [0.2.13] - 2026-07-08

### Features
- Track Kiro IDE and Kiro CLI as separate editors

### Maintenance
- Session parsing and cost logic shared with the VS Code extension moved into the repository's top-level `src/` folder, with a contract test guarding the CLI's use of it

## [0.2.12] - 2026-07-06

### Features
- `curation` uses active session duration, excluding idle gaps between turns

## [0.2.11] - 2026-06-25

### Features
- New `curation` command comparing the MCP servers and skills you have available against the ones you actually use (`--window`, `--json`) (#1410)

### Bug Fixes
- Fix update sync-host-views skill paths after CopilotTokenTracker rename (#1398)

### Maintenance
- Added unit tests for error handling and CLI utilities (#1375)
- Bumped `@types/node` to 26.0.0
- Bumped `esbuild` to 0.28.1

## [0.2.10] - 2026-06-09

### Bug Fixes
- Fix modelSwitching cost model array initialization

## [0.2.9] - 2026-06-07

### Features
- Add this-month token count to segment output and statusline (#1350)

## [0.2.3] - 2026-05-22

### Features & Improvements
- Added oh-my-posh segment command and Copilot CLI statusline support (#876)
- Removed cost estimate row and renamed TBB to UBB for clearer billing terminology (#847)
- Added billion (B) tier to token display formatters for very large token counts (#899)

### Bug Fixes
- Reduced OMP segment cache TTL from 15 min to 5 min for fresher status-bar data (#936)

### Maintenance
- Extracted CLI helpers into focused modules: progress.ts (ProgressTracker), formatting.ts, commandUtils.ts, and analysis.ts (#1016, #1026, #1027, #1028)
- Replaced synchronous fs calls with async alternatives in CLI helpers
- Extracted CachePolicy strategy from cacheManager and cliCache
- Extracted WorkspacePathResolver for safe file:// URI handling (#965)
- Extracted buildAdapterRegistry factory to eliminate adapter duplication (#959)
- Extracted withErrorRecovery helper to replace silent catch blocks
- Replaced any type casts with proper types throughout CLI helpers
- Centralised ecosystem adapter data-access instantiation
- Added null checks and input validation to output formatting functions
- Bumped @types/node dependencies

## [0.2.2] - 2026-05-13

### Maintenance
- Internal refactoring: extract cache invalidation policy and error-handling wrapper

## [0.2.0] - 2026-05-11

### Maintenance
- Internal refactoring and dependency updates

## [0.1.3] - 2026-05-10

### Features & Improvements
- Added oh-my-posh segment command and Copilot CLI statusline support (#876)

## [0.1.2] - 2026-05-09

### Features & Improvements
- Removed cost estimate row and renamed TBB to UBB (#847)

## [0.1.1] - 2026-05-09

### Features & Improvements
- Added --json output option to the stats command (#818)

### Maintenance
- Bumped @types/node from 25.6.0 to 25.6.2

## [0.1.0] - 2026-05-04

### Features & Improvements
- Added Gemini CLI support as a trackable ecosystem
- Added JetBrains adapter to CLI ecosystem registry
- Added Mistral Vibe session support
- Added weekly/monthly chart periods and fixed usage analysis routing
- Added GitHub Copilot AI-Credit pricing alongside provider pricing
- Added dedicated CLI interaction mode in Usage Analysis (#659)
- Added macOS path support for Claude Desktop Cowork sessions (#714)
- Improved fluency spiderweb chart for Claude-only users
- Renamed cost labels: (API) to (est.) and (Copilot) to (TBB) with explainer tooltips
- Display CO2 in kg when >= 1000g for readability

### Bug Fixes
- Fixed: align token counting with VS Code extension
- Fixed: use actual tokens for all periods; increased session timeout to 120s
- Fixed: prefer actualTokens from session.shutdown over estimates
- Fixed: use UTC date boundaries for period attribution
- Fixed: extract per-model usage from session.shutdown events
- Fixed: populate estimated cost data in chart view for all periods

### Maintenance
- Migrated to IEcosystemAdapter registry pattern for improved extensibility
- Bumped cache version to 3 to reflect SessionData shape changes
