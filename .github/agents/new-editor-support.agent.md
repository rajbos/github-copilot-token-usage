---
description: "Add support for a new CLI-based coding environment (e.g. a new terminal agent) so its sessions appear in all extension views: session list, log viewer, charts, usage analysis, and diagnostics."
name: "New Editor Support"
tools: ["execute/runInTerminal", "execute/getTerminalOutput", "search/codebase", "read/problems"]
---

# New Editor Support

Integrate a new CLI-based coding environment into the extension so its session data appears in the session list, log viewer, charts, usage analysis, and diagnostics panels.

## When to Use This Agent

Trigger this agent when:
- A new terminal-based coding agent (like OpenCode, Crush, Continue, etc.) needs to be added as a tracked editor
- Users want token/interaction stats from a tool that stores data outside VS Code's AppData
- A new session data format (SQLite DB, JSON files, JSONL, etc.) needs to be parsed

## Architecture Overview

The extension uses a **pipeline** from raw session files to all displays:

```
Session Discovery → Cache → Token/Interaction Counting → Stats Aggregation → UI
```

Every new editor must plug into **each stage** of this pipeline. The integration is deliberately layered so each layer has one responsibility.

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

### Step 3 — Register Path Detection in `workspaceHelpers.ts`

Two functions need updating in `src/workspaceHelpers.ts`:

- **`getEditorTypeFromPath()`** — add a check *before* the generic `'/code/'` check (it will false-positive on any path containing the word `code`). Normalise backslashes first with `.replace(/\\/g, '/')`.
- **`detectEditorSource()`** — same guard, same placement rule.

> **Lesson learned:** The generic `'/code/'` check in `getEditorTypeFromPath` / `detectEditorSource` catches paths that contain a folder literally named `code` — e.g. `C:\Users\RobBos\code\repos\...`. Any new editor whose virtual paths run through a user's `code` directory *must* be checked **before** this generic match, or it gets misclassified as VS Code.

Also update **`getEditorNameFromRoot()`** — add a check for the new editor's identifier before the generic `code` match. This function is used when reconstructing editor names from cached data.

### Step 4 — Fix `enrichDetailsWithEditorInfo()` in `extension.ts`

`enrichDetailsWithEditorInfo()` derives `editorRoot` and `editorName` by splitting the file path on the `User` directory component. This **breaks** for editors that:
- Store data outside VS Code's AppData (no `User` directory)
- Use virtual paths that happen to pass through the user's home directory hierarchy

**Add an early-return guard** for each new editor at the *top* of `enrichDetailsWithEditorInfo()`:

```ts
if (this.newEditor.isNewEditorSessionFile(sessionFile)) {
    details.editorRoot = path.dirname(this.newEditor.getDbPath(sessionFile));
    details.editorName = 'NewEditor';
    return;
}
```

This guard is critical — it also fixes the **cache reconstruction path** in `getSessionFileDetailsFromCache()`, which calls `enrichDetailsWithEditorInfo()` when rebuilding from cache. Without it, stale cached sessions get the wrong editor name on every reload.

### Step 5 — Register in `sessionDiscovery.ts`

1. Add `newEditor: NewEditorDataAccess` to the `SessionDiscoveryDeps` interface.
2. In `getDiagnosticCandidatePaths()` — add candidate paths (config file + per-project DB paths). These appear in the Diagnostics panel's "Scanned Paths" table.
3. In `getCopilotSessionFiles()` — add a discovery loop after OpenCode's loop. Call `discoverSessions()` and push virtual paths into the results array.

> **Lesson learned:** If the editor stores one DB per project (like Crush), you need a two-level discovery: first read the global project registry, then enumerate sessions in each project's DB. Calling the data access class's registry reader here keeps discovery and parsing separated.

### Step 6 — Wire Into `extension.ts`

Add the new editor at **eight locations** in `extension.ts`:

1. **Import** — `import { NewEditorDataAccess } from './neweditor';`
2. **Class field** — `private newEditor: NewEditorDataAccess;`
3. **Constructor** — `this.newEditor = new NewEditorDataAccess(extensionUri);` + pass it to `SessionDiscovery({ ..., newEditor: this.newEditor })`
4. **`usageAnalysisDeps` getter** — add `newEditor: this.newEditor`
5. **`statSessionFile()` method** — add the new editor as the first guard in the router method that delegates stat calls (this avoids `fs.promises.stat()` failing on virtual paths)
6. **`estimateTokensFromSession()`** — add a branch returning actual token counts from the DB
7. **`countInteractionsInSession()`** — add a branch
8. **`extractSessionMetadata()`** — add a branch reading title + timestamps; convert epoch seconds to milliseconds here
9. **`getSessionFileDetails()`** — add a branch after the OpenCode block; explicitly set `details.editorRoot`, `details.editorName`
10. **`getSessionLogData()`** — add a branch building `ChatTurn[]` from messages; distribute session-level token totals evenly across turns when per-turn tokens are unavailable

### Step 7 — Wire Into `usageAnalysis.ts`

1. Add `import type { NewEditorDataAccess } from './neweditor';`
2. Add `newEditor?: NewEditorDataAccess` to `UsageAnalysisDeps` (optional to avoid breaking callers)
3. **`getModelUsageFromSession()`** — add a guard routing to the editor's `getModelUsage()` method. Also update the `Pick<>` type signature to include `'newEditor'`
4. **`analyzeSessionUsage()`** — add a branch after the OpenCode block; count tool calls from message parts, set mode, build model switching stats

### Step 8 — Update the Diagnostics Webview (`main.ts`)

1. **`getEditorIcon()`** — add a case *before* all existing checks (the `crush` case must be before any generic word matches). Pick a distinctive emoji matching the tool's brand colour.
2. **`getEditorBadgeClass()`** — add a CSS class name for the editor's brand colours.
3. Add a **`.editor-badge-<name>`** CSS rule in `styles.css` with the brand colours.
4. For editors that produce **many candidate paths** (one per project), consider grouping them into a single row in `buildCandidatePathsElement()` rather than one row per project. See the Crush implementation for the grouping pattern.

> **Lesson learned:** The icon is shown in two places: the editor filter panel (via `getEditorIcon()`) and per-session-row badges. All badge rendering sites (`buildCandidatePathsElement`, the session table row, the folder stats table, the dynamically-built DOM version) must be updated to use `getEditorBadgeClass()` and include the icon prefix. Search for `editor-badge` in `main.ts` to find all four sites.

---

## Common Pitfalls

| Pitfall | Fix |
|---|---|
| Timestamps show as year 1970 | Multiply epoch-seconds values by 1000 before passing to `new Date()` |
| Editor shows as "VS Code" in session list | The path passes through a folder called `code` — add an early-return guard in `enrichDetailsWithEditorInfo()` and check before the generic `/code/` guard in detection helpers |
| Sessions discovered but tokens show 0 | Check `estimateTokensFromSession()` — the branch may be missing or not returning early |
| Cache returns stale editor name | `getSessionFileDetailsFromCache()` calls `enrichDetailsWithEditorInfo()` — ensure the guard there applies too |
| Virtual paths fail `fs.promises.stat()` | Route through `statSessionFile()` which resolves virtual paths to real DB file paths |
| Icon only appears in filter panel, not badge | Update all four `editor-badge` render sites in `main.ts` — there are DOM-creation and template-string-based variants |
| Discovery loop finds 0 sessions even though DB exists | Verify the project registry reader returns the correct `data_dir` (not the project `path`) and that `path.join(data_dir, '<db>.db')` matches the actual file |

---

## Checklist

- [ ] `src/<editor>.ts` created with all required methods
- [ ] `workspaceHelpers.ts` — both detection helpers updated, new check before generic `/code/` match
- [ ] `workspaceHelpers.ts` — `getEditorNameFromRoot()` updated
- [ ] `extension.ts` — `enrichDetailsWithEditorInfo()` has early-return guard
- [ ] `extension.ts` — all 10 integration points wired
- [ ] `sessionDiscovery.ts` — deps interface, candidate paths, discovery loop
- [ ] `usageAnalysis.ts` — deps interface, `getModelUsageFromSession()`, `analyzeSessionUsage()`
- [ ] `webview/diagnostics/main.ts` — icon, badge class, all 4 badge render sites, candidate path grouping if needed
- [ ] `webview/diagnostics/styles.css` — brand colour CSS rule added
- [ ] `npm run compile` passes (TypeScript + ESLint + esbuild)
- [ ] Sessions appear in the session list with the correct editor name and icon
- [ ] Token counts are non-zero and plausible
- [ ] Timestamps are correct (not 1970)
- [ ] Diagnostics "Scanned Paths" table shows the new editor's paths
