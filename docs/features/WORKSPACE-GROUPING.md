# Workspace grouping

One repository is often worked on from many folders: the main checkout, Claude Code and
Copilot app worktrees, sibling `-wt` folders, scratch clones, a WSL path, a differently-cased
spelling. Session data records each of those folders separately. Workspace grouping folds them
back into one workspace per repository, so Workspace Health shows one row per repository and
the CLI's Customization evidence counts repositories, not folders.

- Code: [`src/workspaceGrouping.ts`](../../src/workspaceGrouping.ts) (pure rules) and
  [`src/workspaceGroupingProbes.ts`](../../src/workspaceGroupingProbes.ts) (the Node
  filesystem probes it is given: `prefetchWorkspaceGroupingProbes()` checks every path the
  grouping can ask about asynchronously up front, so the extension host never blocks on disk).
- Used by: the VS Code extension's customization matrix
  (`deduplicateWorkspacePaths()` in `vscode-extension/src/extension.ts`, which only applies
  the result) and the CLI's `buildCustomizationMatrix()` in `cli/src/helpers.ts`, which takes
  each session's folder and remote from the owning adapter's metadata first (Copilot CLI,
  OpenCode, Crush, …) and falls back to Claude Code JSONL and VS Code `chatSessions` paths.
  For VS Code sessions, which no adapter covers, the remote is the workspace folder's own
  repository (`findRepositoryRemoteForFolder()`, the same rule the extension uses). Like the
  extension, it only counts sessions
  with at least one interaction in the last 30 days (the shared `getTimeWindowStartDate('last30')`
  window: 30 calendar dates including today), judged by a database-backed session's own last
  activity rather than its shared database file's mtime.
- Session remotes: the extension resolves each session's remote during the normal (worker)
  analysis — the owning adapter's recorded remote, else the remote of the session's workspace
  folder's own repository (`findRepositoryRemoteForFolder()` in `src/workspaceHelpers.ts`,
  walking up so a sub-folder workspace or an in-repo worktree resolves to its repository), and
  only when the workspace is unknown the remote of the files it referenced. Referenced files are
  not trusted when the workspace is known: they can belong to another repository or to a nested
  clone. `''` records "none found" — so every session carries its own remote and a reused
  folder reaches the grouping as conflicting.
- Tests: [`vscode-extension/test/unit/workspaceGrouping.test.ts`](../../vscode-extension/test/unit/workspaceGrouping.test.ts)
  and the parity tests in `cli/src/test/customizationMatrix.test.ts`.

## Rules, strongest evidence first

1. **Same git remote** — folders whose sessions recorded the same `repository` remote, or whose
   `.git/config` (read while the folder still exists) names the same `origin`, are one
   repository. The remote is normalised to `host/namespace/name`, so https, ssh and `ssh://`
   forms of one repository match while the same `owner/name` on another host (GitHub vs GitLab,
   GitHub Enterprise) or Azure DevOps organisation stays apart; a bare `owner/name` is GitHub,
   and Azure DevOps https, ssh and `visualstudio.com` remotes all read as
   `dev.azure.com/<org>/<project>/<repo>`. Local filesystem remotes (`/srv/repo.git`,
   `../repo.git`, `~/…`, `C:\…`, `file://…`) name no hosted repository and give no identity. A
   folder seen with two different remotes (reused for another repository, or a session remote
   that disagrees with the folder's current `.git`) is *conflicting*: it is kept out of every
   weaker rule, and a worktree whose remote differs from its main checkout stays apart from it.
   The group is displayed as the repository name.
2. **Worktree pointer** — an existing linked worktree's `.git` file
   (`gitdir: <main>/.git/worktrees/<name>`) leads to its main checkout, which becomes the group's
   canonical folder even when it had no sessions of its own.
3. **Path conventions, case and remote spellings**
   - `<home>/.claude/worktrees/<repo>/<name>` (Claude desktop app),
     `<repo>/.claude/worktrees/<name>` (Claude Code CLI) and
     `<root>/copilot-worktrees/<repo>/<name>` (Copilot app; anchored on `<root>/repos/<repo>`
     when that checkout exists). These need no disk access, so they work for folders that are
     already deleted and for WSL / remote paths. The two Claude layouts look alike when the
     session cwd is a sub-folder of a worktree; the folder above `.claude` decides: it is the
     repository when it is itself in the workspace list or has a `.git`, the desktop layout when
     it is the user's real home directory (passed in by the probes, so a redirected home such as
     `D:\Profiles\<user>` works) or has a home-directory shape (`/home/<user>`, `/Users/<user>`,
     `C:\Users\<user>`, `/root`, `/mnt/<drive>/Users/<user>`), and the repository otherwise.
   - Case-only differences on Windows and macOS.
   - A WSL / SSH path seen on Windows (`/home/…`, or `\home\…` after normalisation) that has the
     same folder name as a local checkout. UNC network shares (`\\server\share\…`) are local.
4. **Sibling artefact folders** — `<repo>-wt`, `<repo>-<word>-wt` and `<repo>-<hex>` join the
   workspace named `<repo>` when one is in the list.
5. **Same folder name** — the weakest signal, applied last.

No rule merges two groups whose remotes say they are different repositories. A name pattern on
its own never invents a group: `groups-dashboard-layout-85ed99` with nothing named
`groups-dashboard-layout` and no remote stays its own row. Name-based rules (3–5) decide per name
component, before merging anything: when the folders sharing a name belong to two different
repositories, the component is ambiguous and a folder without a remote joins neither (several
such same-named folders still fold together). The result depends only on
the set of folders, never on their order.

The canonical folder of a group (the row's path) is, in order: an existing main checkout found by
rule 2 or 3; a local folder whose name is not an artefact; any local folder; a remote one. Ties go
to most interactions, then most sessions, then the smallest path. Counts are the sum of the
members. The group's customization files are the union of every member's scan and the canonical
folder's own (`mergeGroupCustomizationFiles()`), so instructions in the main checkout and a skill
only in a worktree both count; a file found in several folders is kept once, the fresh copy over
a stale one. `<unresolved:…>` workspaces pass through untouched.

## Seeing what was merged

A Workspace Health row that merged several folders shows "N folders merged"; expand it to see
the folders (they are also in the tooltip). A wrong merge is therefore visible, not silent.

## Detecting names the rules do not know yet

`detectArtefactWorkspaceNames()` flags display names that still look like worktree or clone
artefacts after grouping: a 6+ character hex suffix containing a digit (`-85ed99`, but not
`-facade`), generated `adjective-name-<hex>` names, a `-wt` suffix, or a name that is still its own
folder name although that folder sits anywhere below a `worktrees` / `copilot-worktrees` folder
(an unknown layout such as `/tmp/worktrees/repo/feature`).

- **At runtime** the Workspace Health summary line says how many workspace names look like
  ungrouped worktrees or clones, with a few examples, and the extension log lists them with the
  reason. On a real machine this is how a new naming pattern shows up.
- **In tests** the corpus asserts the detector flags nothing after grouping.

### Adding a new pattern

1. Add a row to `CORPUS` in `vscode-extension/test/unit/workspaceGrouping.test.ts` with
   anonymised paths (never real user paths), the platform, any probe facts it needs, and the
   expected groups.
2. Run the test; it fails on the expected groups and usually on the hygiene invariant too.
3. Teach `src/workspaceGrouping.ts` the pattern, keeping the rule order above: a new path
   convention belongs in `matchWorktreeConvention()`, a new folder-name shape in
   `artefactStems()` / `classifyArtefactName()`.

## Not covered yet

Other consumers of workspace names still derive names on their own and are follow-ups: the
Recent Sessions *Workspace* column (`resolveSessionWorkspaceName()`), the AI Readiness per-repo
overview, the Worktrees tab and the Diagnostics view (which does not show the ungrouped-name
count yet).
