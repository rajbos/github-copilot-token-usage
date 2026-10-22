# Repository Heatmap

**Command:** `AI Engineering Fluency: Show Repository Heatmap` (`aiEngineeringFluency.showRepoHeatmap`)

A heatmap of every file an agent touched in a repository. Each cell is one file, grouped under the
folder it lives in; colour says what happened to it and intensity says how often. The standard
period selector (Today, Last 7 / 30 / 90 days, Current month, All time) filters it.

| Kind | Source in the session logs |
|---|---|
| Read | `Read` (Claude Code), `view` (Copilot CLI), `copilot_readFile` (VS Code Copilot Chat) |
| Edited | `Edit` / `MultiEdit` / `NotebookEdit` and `Write` over an existing file, `edit`, `copilot_replaceString` and friends |
| Created | `Write` of a new file, `create`, `copilot_createFile` |
| Deleted | **Inferred** from shell commands: `rm`, `git rm`, `del`, `Remove-Item` |

## Data and privacy

File paths are local-only. They are derived on this machine from your session logs, cached in the
extension's global storage (`repo-heatmap-cache.json`, keyed by session file with its mtime and
size so an unchanged session is not re-read) and are never uploaded: the sharing server receives
numeric rollups, not paths.

## How it is built

- `src/fileActivity.ts` — pure extractor: one session log in, a list of `{path, kind, ts}` out.
  Failed tool calls are dropped; a re-logged streaming fragment counts once.
- `src/repoHeatmapCollector.ts` — Node-side gathering shared by every host: reads session files,
  resolves the repository (remote URL) and the workspace root, caches per file.
- `src/repoHeatmapViewBuilder.ts` — pure: anchors paths to the repository, folds sessions into
  per-repository / per-file / per-day counters (`buildRepoHeatmapViewData`) and filters by period
  and kind, grouped by folder (`summarizeRepoHeatmap`).
- `vscode-extension/src/repoHeatmapPanel.ts` and `src/webview/repoHeatmap/` — the VS Code panel and
  its webview.

### Which repository a file belongs to

1. The session's repository remote, when one resolves.
2. Otherwise the repository name in an agent worktree path (`.claude/worktrees/<repo>/<name>`,
   `.copilot/copilot-worktrees/<repo>/<name>`, `<repo>.worktrees/<name>`), merged into the one
   remote-keyed repository with that name when it is unambiguous.
3. Otherwise the workspace folder.

A file inside a different agent worktree than the session's own folder is attributed to that
worktree's repository. Files outside every workspace (home-directory notes, other tools' files)
are counted but not shown.

## Known limits

- **Deletes are best effort.** No agent logs a structured "delete file" call, so only plain
  `rm`/`del`/`Remove-Item` of named files are found. Recursive deletes (directories), globs and
  variables are skipped, and a deleted file is flagged as inferred in its tooltip.
- **Which editors:** Claude Code (CLI, Desktop and the VS Code extension), Copilot CLI and VS Code
  Copilot Chat. Sessions stored in a database (for example OpenCode) and other editors are not
  scanned yet.
- Periods count back from the time of the last scan; use Refresh to move "Today" forward.
- Per repository the 3000 most-touched files are kept.
- The first scan reads every session log and can take a minute on a large history; later opens only
  re-read changed sessions.
