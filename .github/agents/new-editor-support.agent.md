---
description: "Add support for a new coding environment (CLI-based terminal agent or GUI/IDE plugin) so its sessions appear in all extension views: session list, log viewer, charts, usage analysis, and diagnostics."
name: "New Editor Support"
tools: ["execute/runInTerminal", "execute/getTerminalOutput", "search/codebase", "read/problems"]
---

# New Editor Support

Integrate a new coding environment — a terminal-based CLI agent (OpenCode, Crush) **or** a GUI/IDE plugin (JetBrains, Eclipse) — into the extension so its session data appears in the session list, log viewer, charts, usage analysis, and diagnostics panels.

**Primary integration mechanism: the shared ecosystem adapter registry** (`src/adapters/adapterRegistry.ts`). Implementing and registering one adapter class wires the editor into *both* the VS Code extension and the CLI simultaneously — they consume the exact same registry. Manually editing `extension.ts` / `usageAnalysis.ts` / `sessionDiscovery.ts` with per-editor branches is no longer how this works (that model is deprecated — see Architecture Overview) and is a sign you've skipped Step 5 below.

## When to Use This Agent

Trigger this agent when:
- A new terminal-based coding agent (like OpenCode, Crush, Continue, etc.) needs to be added as a tracked editor
- A new GUI/IDE plugin (like JetBrains, Eclipse) needs to be added as a tracked editor
- Users want token/interaction stats from a tool that stores data outside VS Code's AppData
- A new session data format (SQLite DB, JSON files, JSONL, etc.) needs to be parsed
- The editor's workspace/install location is user-configurable rather than fixed (e.g. Eclipse workspaces, per-project directories) — discovery must enumerate a registry/recent-list file instead of assuming one path

## Architecture Overview

The extension uses a **pipeline** from raw session files to all displays:

```
Session Discovery → Cache → Token/Interaction Counting → Stats Aggregation → UI
```

Every new editor must plug into **each stage** of this pipeline. The integration used to require manually wiring ~8-10 locations across `extension.ts`, `sessionDiscovery.ts`, and `usageAnalysis.ts` (if you find old documentation or code describing that, it is stale). Today, all of those stages are driven generically by a **registry of ecosystem adapters** (`src/ecosystemAdapter.ts`, `src/adapters/`):

- **`IEcosystemAdapter`** (required) — `handles()`, `getBackingPath()`, `stat()`, `getTokens()`, `countInteractions()`, `getModelUsage()`, `getMeta()`, `getEditorRoot()`, optional `buildTurns()`. This alone gets the editor into the session list, cache, and log viewer.
- **`IDiscoverableEcosystem`** (opt-in) — `discover()`, `getCandidatePaths()`. Without this, `SessionDiscovery` never finds the editor's files and it won't appear anywhere, no matter how complete the data-access class is.
- **`IAnalyzableEcosystem`** (opt-in) — `analyzeUsage()`. Without this, the usage-analysis view has no data for the editor (tool calls, mode usage, model switching).

`src/adapters/adapterRegistry.ts` is the **single place** both `extension.ts` (VS Code) and `cli/src/helpers.ts` (CLI) pull the adapter list from via `createDataAccessInstances()` + `buildAdapterRegistry()`. Registering an adapter there is what actually makes it "go live" everywhere — see the critical lesson-learned note in Step 4.

A few legacy integrations (e.g. Windsurf) still live outside this registry as hand-rolled special cases in `extension.ts`/`sessionDiscovery.ts`. Do not copy that pattern for new editors — always use the adapter registry.

---

## Step-by-Step Integration

### Step 1 — Explore the Data Source

Before writing any code, understand the new editor's storage layout:

1. **Find the config/data directories** — check OS-specific locations (Windows: `%APPDATA%`, `%LOCALAPPDATA%`; Linux/macOS: `~/.config`, `~/.local/share`, `XDG_*` env vars).
2. **Identify session files** — are sessions stored as individual JSON files, a single SQLite DB, per-project DBs, or JSONL?
3. **Inspect the schema** — for SQLite, dump `.tables` and `PRAGMA table_info(table)`. For JSON, read a real session file.
4. **Locate token counts** — does the schema have per-message tokens, per-session totals, or none? Note whether thinking/reasoning tokens are separately tracked.
5. **Locate model info** — which field holds the model name/ID? Is it per-session or per-message?
6. **Understand timestamps** — are they Unix epoch seconds, milliseconds, or ISO 8601 strings? (This is a common source of bugs — epoch seconds must be multiplied by 1000 for JS Date.)
7. **Locate a projects registry** — if the editor stores one DB per project, there is usually a global index file (e.g. `projects.json`) that lists all known projects with their data directories.

> **Lesson learned:** Always verify whether timestamps are in seconds or milliseconds before writing any date conversion code. Crush's SQLite stores epoch *seconds*; JS Date needs *milliseconds*. Getting this wrong silently corrupts all timestamps.

### Step 2 — Create a Dedicated Data Access Class

Create `src/<editorname>.ts` modelled on `src/opencode.ts` and `src/crush.ts`. **Do not modify `opencode.ts`** — each editor gets its own file.

The class must expose:

| Method | Purpose |
|---|---|
| `getConfigDir(): string` | OS-aware path to the editor's config/data root |
| `isSessionFile(filePath: string): boolean` | Returns true for any path belonging to this editor (normalise backslashes before checking) |
| `statSessionFile(virtualPath: string): Promise<fs.Stats>` | Stats the underlying DB/file (needed for virtual paths that point into a DB) |
| `discoverSessions(): Promise<string[]>` | Returns all virtual session paths |
| `readSession(virtualPath): Promise<any \| null>` | Reads session metadata (title, timestamps, token totals) |
| `getMessages(virtualPath): Promise<any[]>` | Returns all messages/turns ordered by time |
| `getTokens(virtualPath): Promise<{ tokens: number; thinkingTokens: number }>` | Returns total tokens for the session |
| `countInteractions(virtualPath): Promise<number>` | Count of user-role messages (= turns) |
| `getModelUsage(virtualPath): Promise<ModelUsage>` | Per-model `{ inputTokens, outputTokens }` breakdown |

**Virtual path scheme** (for DB-backed editors): use `<db_file_path>#<session_id>` so the file path remains a string throughout the pipeline. Example: `C:\repo\.crush\crush.db#<uuid>`. This mirrors OpenCode's `opencode.db#ses_<id>` convention.

**Always normalise backslashes** in `isSessionFile()`:
```ts
isCrushSessionFile(filePath: string): boolean {
    return filePath.replace(/\\/g, '/').includes('/.crush/crush.db#');
}
```

For **GUI/IDE plugins whose workspace or install location is user-configurable** (Eclipse workspaces, per-project directories), don't hardcode a single path. Discover candidate roots from:
1. A sensible default (e.g. `~/eclipse-workspace`).
2. Any registry/recent-list file the tool itself maintains (e.g. Eclipse's `RECENT_WORKSPACES` entry in `org.eclipse.ui.ide.prefs`, unescaping Java `.properties` syntax). This generalises the "projects registry" idea below to non-CLI tools too.

This data-access class is a plain building block — it is wrapped by an adapter class in Step 4 and is **not** sufficient on its own for anything to appear in the UI (see the lesson learned there).

### Step 3 — Register Path Detection in `workspaceHelpers.ts`

Two functions need updating in `src/workspaceHelpers.ts`:

- **`getEditorTypeFromPath()`** — add a check *before* the generic `'/code/'` check (it will false-positive on any path containing the word `code`). Normalise backslashes first with `.replace(/\\/g, '/')`.
- **`detectEditorSource()`** — same guard, same placement rule.

> **Lesson learned:** The generic `'/code/'` check in `getEditorTypeFromPath` / `detectEditorSource` catches paths that contain a folder literally named `code` — e.g. `C:\Users\RobBos\code\repos\...`. Any new editor whose virtual paths run through a user's `code` directory *must* be checked **before** this generic match, or it gets misclassified as VS Code.

Also update **`getEditorNameFromRoot()`** — add a check for the new editor's identifier before the generic `code` match. This function is used when reconstructing editor names from cached data.

Detection helpers check several substrings (`copilot`, `code`, `cursor`, ...) in a fixed order — first match wins, including in `getEditorNameFromRoot()`'s early `isCopilotCliRoot()` check (which matches any path containing `copilot`, e.g. a plugin id like `com.microsoft.copilot.eclipse.core`). Search for every substring your new editor's path could accidentally contain and place your guard before all of them, not just the one you expect — apply the same ordering rule to the `/.copilot/` checks in `getEditorTypeFromPath()` / `detectEditorSource()`.

### Step 4 — Implement the Ecosystem Adapter

Create `src/adapters/<editor>Adapter.ts`, modelled on an existing file-based adapter — `src/adapters/continueAdapter.ts` (single JSON file per session, estimated tokens) is the closest template for JSON-based editors; `src/adapters/crushAdapter.ts` shows the virtual-path/SQLite pattern. The adapter wraps the Step 2 data-access class and implements:

- **`IEcosystemAdapter`** (required) — `id`, `displayName`, `handles()`, `getBackingPath()`, `stat()`, `getTokens()`, `countInteractions()`, `getModelUsage()`, `getMeta()`, `getEditorRoot()`, optional `buildTurns()` for the log viewer.
- **`IDiscoverableEcosystem`** (opt-in) — `discover(log)`, `getCandidatePaths()`. This replaces the old manual `sessionDiscovery.ts` wiring entirely.
- **`IAnalyzableEcosystem`** (opt-in) — `analyzeUsage()`. This replaces the old manual `usageAnalysis.ts` wiring entirely.

See `src/ecosystemAdapter.ts` for the full interface contracts and doc comments.

`enrichDetailsWithEditorInfo()` and `getSessionFileDetailsFromCache()` in `extension.ts` already call `eco.getEditorRoot(sessionFile)` and `getEcosystemDisplayName(eco, sessionFile)` generically for every adapter found via `handles()` — **no manual per-editor guard is needed there anymore** as long as the adapter is registered (Step 5).

Creating the data-access class (Step 2) and the path-detection guards (Step 3) is not sufficient for anything to appear in the UI — the adapter must also be registered in the shared registry (Step 5) before `SessionDiscovery` runs for that editor; until then the session list, log viewer, charts, usage analysis, and diagnostics panel all stay empty even though `handles()`/`isSessionFile()` would correctly recognise the files. Don't report the integration done, or hand off to the user, until Step 5 is verified end-to-end (e.g. via `cli diagnostics`).

### Step 5 — Register the Adapter in the Shared Registry

All per-editor wiring for **both** the VS Code extension and the CLI happens in exactly one file: `src/adapters/adapterRegistry.ts`. There is no separate CLI wiring step — `cli/src/helpers.ts` imports `buildAdapterRegistry` and `createDataAccessInstances` directly from the extension's `src/adapters` module, so registering here wires both consumers at once.

1. Import the data-access class and the adapter class at the top of `adapterRegistry.ts`.
2. Add the data-access class as a field on `AdapterRegistryDeps`.
3. Instantiate it in `createDataAccessInstances()`.
4. Push `new <Editor>Adapter(deps.<editor>)` into the array returned by `buildAdapterRegistry()`. **Order matters** — first match wins in `handles()`. Place adapters whose paths could collide with broader/generic checks (anything living under a path containing `copilot`, `code`, `cursor`, etc.) early enough to win, and add a one-line comment explaining why if the ordering isn't obvious.

Once registered, session discovery, caching, token/interaction counting, stats aggregation, the log viewer, and usage analysis all pick up the new editor automatically. Verify with `node cli/dist/cli.js diagnostics` (after `npm run build` in `cli/`) — a working integration shows the editor's candidate path as `yes` (exists) and a non-zero file/session/token count.

### Step 6 — Add the Editor Icon

Icons are defined in exactly **one** place: `EDITOR_ICON_MAP` in `src/editorIcons.ts`. Add `'<DisplayName>': '<emoji>'` there — it is consumed by both the extension host and every webview (via `src/webview/shared/formatUtils.ts`), so this single entry covers the session list, log viewer, and diagnostics filter panel simultaneously.

A dedicated CSS badge class (`.editor-badge-<name>` in `webview/diagnostics/styles.css` plus a case in `getEditorBadgeClass()` in `webview/diagnostics/main.ts`) is **optional**. Editors without one already fall back to the generic `.editor-badge` style with the correct icon prefix (Continue, Claude Code, and OpenCode all do this today). Only add a dedicated class when you want distinct brand colours.

For editors that produce **many candidate paths** (one per project/workspace), consider grouping them into a single row in `buildCandidatePathsElement()` rather than one row per project — see the Crush implementation for the grouping pattern.

### Step 7 — Update Tests

`test/unit/ecosystemAdapters.test.ts` asserts a **hardcoded adapter count** (`assert.equal(allAdapters.length, N)`). Adding a new adapter without updating this test fails CI:

1. Import the new data-access class and adapter class.
2. Instantiate both and add the adapter to the `allAdapters` array.
3. Bump the count in `assert.equal(allAdapters.length, N)`.
4. Add an `assert.equal(<editor>Adapter.id, '<expected-id>')` assertion alongside the other editors.

Run `npm run compile-tests` then the specific test file (see the devcontainer terminal guidance in the repo-wide instructions) rather than the whole suite.

### Step 8 — (Optional) Add an Editor-Specific Data-Availability Note

When the new editor doesn't persist actual API token counts (common for JSON/JSONL formats — JetBrains, Antigravity, Cursor, Eclipse), add an entry to `ESTIMATED_TOKENS_NOTES` in `src/webview/logviewer/main.ts`. This renders a `ⓘ` hover tooltip next to the Estimated Tokens card explaining why the number is an estimate and what data the tool doesn't record locally.

For broader session-level caveats (multiple bullet points), use the `editorNote: { items: string[] }` field on `SessionLogData` instead (see the Cursor branch in `buildBaseLogData()` in `extension.ts`) — it renders a persistent info panel at the top of the log viewer rather than a single hover tooltip.

---

## Common Pitfalls

| Pitfall | Fix |
|---|---|
| Timestamps show as year 1970 | Multiply epoch-seconds values by 1000 before passing to `new Date()` |
| Editor shows as "VS Code" in session list | The path passes through a folder called `code` — add a guard in the detection helpers (`getEditorTypeFromPath`, `detectEditorSource`, `getEditorNameFromRoot`) before the generic `/code/` match |
| Editor shows as "Copilot CLI" in session list | The path contains the substring `copilot` (e.g. a plugin id like `com.microsoft.copilot.eclipse`) — add a guard **before** `isCopilotCliRoot()` / the `/.copilot/` checks, not just before the generic `/code/` check |
| **Adapter class exists, path detection works, but nothing shows up anywhere** | You skipped Step 5. Creating `src/<editor>.ts` alone does nothing — an adapter must be created (Step 4) *and* registered in `src/adapters/adapterRegistry.ts` (Step 5) before `SessionDiscovery` will ever call it |
| Sessions discovered but tokens show 0 | Check the adapter's `getTokens()` — it may be missing or not returning early; confirm the underlying data-access method actually extracts text from the right fields |
| Virtual paths fail `fs.promises.stat()` | Implement `stat()` on the adapter to resolve virtual paths to the real backing DB/file path (see `getBackingPath()` in `CrushAdapter`) |
| Discovery loop finds 0 sessions even though the file/DB exists | Verify the project/workspace registry reader returns the correct data directory (not just the project's working-directory path) and that the joined path matches the actual file on disk |
| ESLint/complexity warnings appear after `npm --prefix vscode-extension run validate` even though there are 0 errors | `npm --prefix vscode-extension run validate` runs type-checking, ESLint, and esbuild — ESLint enforces a max complexity of 15 (`sonarjs/cognitive-complexity`, `complexity`). Extract small helper methods proactively instead of chaining ternaries or nesting loops; don't treat 0 *errors* as "done" — re-run validation and check for warnings too |
| `test/unit/ecosystemAdapters.test.ts` fails after adding an adapter | The adapter count assertion (`assert.equal(allAdapters.length, N)`) is hardcoded — bump it and add the new adapter's `id` assertion (Step 7) |

---

## Checklist

- [ ] `src/<editor>.ts` created with all required data-access methods (Step 2)
- [ ] `workspaceHelpers.ts` — both detection helpers updated, new check before the generic `/code/` match **and** before `/.copilot/`/`isCopilotCliRoot()` if the path could contain `copilot`
- [ ] `workspaceHelpers.ts` — `getEditorNameFromRoot()` updated with the same ordering care
- [ ] `src/adapters/<editor>Adapter.ts` created, implementing `IEcosystemAdapter` (+ `IDiscoverableEcosystem` + `IAnalyzableEcosystem` as applicable)
- [ ] `src/adapters/adapterRegistry.ts` — data-access class registered in `AdapterRegistryDeps`/`createDataAccessInstances()`, adapter instance pushed into `buildAdapterRegistry()` in the correct order
- [ ] `src/editorIcons.ts` — `EDITOR_ICON_MAP` entry added
- [ ] `test/unit/ecosystemAdapters.test.ts` — adapter added to `allAdapters`, count bumped, `id` assertion added
- [ ] (Optional) `webview/diagnostics/main.ts` + `styles.css` — dedicated badge class/colour, only if the generic fallback isn't distinctive enough
- [ ] (Optional) `webview/logviewer/main.ts` — `ESTIMATED_TOKENS_NOTES` entry if the editor doesn't persist actual token counts
- [ ] `pnpm --prefix vscode-extension run validate` passes with **0 errors and 0 warnings** (not just 0 errors — check for complexity/lint warnings on new code)
- [ ] CLI build (`cd cli && pnpm run build`) succeeds, since it shares the same adapter registry
- [ ] `node cli/dist/cli.js diagnostics` shows the new editor's candidate path as `yes` (exists) with non-zero file/session/token counts — this is the fastest end-to-end confidence check
- [ ] Sessions appear in the session list with the correct editor name and icon
- [ ] Token counts are non-zero and plausible
- [ ] Timestamps are correct (not 1970)
- [ ] Diagnostics "Scanned Paths" table shows the new editor's paths
