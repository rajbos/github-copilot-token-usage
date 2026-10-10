# Security model: load-cache-data

Lightweight model derived from reading `load-cache-data.js` and the cache entry type
`SessionFileCache` in `src/types.ts`. Update it in the same PR as any change that adds or
alters a trigger surface (see "Skill security classification" in the repository `AGENTS.md`).

This skill is classified as modelled (not exempt) because its purpose is to print raw cache
entries, which include session-derived free text and local paths, straight into a chat
transcript (trigger 6).

## What the scripts do and talk to

- `load-cache-data.js` looks for the extension's session cache export on disk, parses it
  and prints the most recent `--last N` entries (default 10) as one JSON document to
  stdout. If no file is found it prints `{ cacheFound: false, searchedPaths }` and exits 1.
- No network access.

## Credentials used and where they come from

None. It reads `APPDATA`, `TEMP`/`TMP` and `XDG_CONFIG_HOME` only to build candidate paths.

## Untrusted inputs parsed

- The first readable file among, in order: the extension's `globalStorage/<id>/session-cache.json`
  under each VS Code variant's user directory, `copilot-token-tracker-cache.json` and
  `session-cache.json` in the OS temp directory, and `cache-export.json` and
  `session-cache.json` in the current working directory (lines 108-170, 280-300).
- The temp directory and the working directory are locations other local users or
  repositories can write to. The content is `JSON.parse`d and printed; nothing in it is
  executed. Whatever text the file holds reaches the reader of stdout (for an agent, its
  context).

## What it writes and where

Nothing on disk. Stdout is one JSON line with `cacheFile` (full path), `requestedCount`,
`totalCacheEntries` and `entries`, where each entry is the whole cached object: token and
interaction counts, per-model usage, usage analysis, and also `title` (the session title),
`repository` (git remote URL) and `workspaceFolderPath` (a local path) when the cache has
them.

## External programs run

None.

## Mitigations in the code

- Read-only and offline; no code path writes a file or opens a socket.
- Output is limited to the `--last N` most recent entries (default 10, sorted by `mtime`).
- A file that fails to parse is skipped (the loop `continue`s) and the search moves on.

## Known gaps

Recorded, not fixed here.

- **Session-derived text is printed raw.** Entries are emitted without filtering, so
  session titles (`customTitle` from the session file, which is user-facing text and can echo a prompt), local workspace paths and
  repository remote URLs go into the chat transcript, and from there into whatever the
  transcript is shared with. The script does not strip URL userinfo or paths.
  `--last 99999` prints the entire cache.
- `--last` is not validated as a positive limit. It is read with `parseInt(value, 10) || 10`
  (line 30), so any positive integer is accepted, a partially numeric value such as `5abc`
  is read as `5`, and a negative value is passed to `slice(0, lastCount)` (line 294):
  `--last -1` emits every entry except the oldest one.
- The temp-directory and working-directory candidates mean a file planted there is
  trusted as "the cache" (see "Untrusted inputs").
