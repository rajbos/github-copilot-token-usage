# Security model: load-cache-data

Lightweight model derived from reading `load-cache-data.js` and the cache entry type
`SessionFileCache` in `src/types.ts`. Update it in the same PR as any change that adds or
alters a trigger surface (see "Skill security classification" in the repository `AGENTS.md`).

This skill is classified as modelled (not exempt) because its purpose is to print cache
entries derived from the user's AI sessions into a chat transcript (trigger 6). The default
output is limited to counts and metadata; session-derived free text and local paths are only
printed behind the explicit `--include-sensitive` opt-in.

## What the scripts do and talk to

- `load-cache-data.js` looks for the extension's session cache export on disk, parses it
  and prints the most recent `--last N` entries (default 10, at most 100) as one JSON
  document to stdout. If no file is found it prints `{ cacheFound: false, error }` (no
  searched paths) and exits 1. An invalid `--last` value exits 2. If the first cache file it
  finds is malformed it prints `{ cacheFound: true, malformed: true, error }` (naming only the
  file's basename) and exits 3.
- No network access.

## Credentials used and where they come from

None. It reads `APPDATA` and `XDG_CONFIG_HOME` only to build candidate paths.

## Untrusted inputs parsed

- The first regular file found at `<VS Code user data>/User/globalStorage/<extension id>/` named
  `cache_prod.snapshot.json`, `cache_dev.snapshot.json` (the extension's shared cache snapshot,
  whose `entries` are unwrapped from its envelope by `unwrapCacheEntries`) or a legacy
  `session-cache.json` export, for the variants Code, Code - Insiders, Code - Exploration, VSCodium and Cursor, and the
  extension ids `robbos.ai-engineering-fluency` and `robbos.copilot-token-tracker`
  (`getCacheFilePaths`, line 139). These are in the user's own profile directory.
- The OS temp directory and the current working directory are no longer candidates, so a
  file planted there is not read.
- The content is `JSON.parse`d (`parseCacheEntries`, line 327) and filtered before printing;
  nothing in it is executed. A snapshot must be an envelope with a numeric `schemaVersion` and
  an `entries` object, and a legacy export must be an object.

## What it writes and where

Nothing on disk. Stdout is one JSON line.

- **Default:** `requestedCount`, `totalCacheEntries` and `entries`, keyed `session-1`,
  `session-2`, ... instead of session file paths. Each entry keeps only allowlisted fields
  (`SAFE_CACHE_ENTRY_FIELDS`, line 186): token and interaction counts, per-model usage,
  timestamps, task categories, daily rollups and `usageAnalysis`. Inside `usageAnalysis`,
  `firstUserPrompt`, `contextReferences.byPath` and `editScope.languageUsage` are removed
  (`sanitizeCacheEntry`, line 226). `contextReferences.byKind`, whose keys are copied verbatim
  from the session's reference and variable `kind`, keeps only kinds in a fixed list of VS
  Code Chat kinds (`KNOWN_REFERENCE_KINDS`, line 207). Counts for every other kind are summed
  under `other`. Each correction moment keeps only allowlisted fields
  (`SAFE_CORRECTION_MOMENT_FIELDS`, line 202: type, turn number, timestamp, flags and this
  repo's own pattern labels), so its `snippet`, `tool` (the failing tool's session name) and
  `file` are dropped. `toolCalls`,
  `mcpTools` and `skillCalls` keep only their scalar totals; their maps keyed by tool, MCP
  server or skill name (`byTool`, `byServer`, `byName`, `latencyBy*`, ...) are dropped
  (`NAME_KEYED_USAGE_FIELDS`, line 199), because those names come from the session and can
  carry a private project or customer name. `agentUsage` keeps only `agents` (how many custom
  agents were used) and `requests`; its `byAgent` map, keyed by the agent's name, is dropped for
  the same reason (`sanitizeCacheEntry`). `modelSwitching.selectedModelExtensions` (the ids
  of the extensions that supplied the selected models, which can name a private or internal
  provider extension) is dropped; the model ids themselves are kept. `title`, `repository`,
  `workspaceFolderPath`, top-level `languageUsage` (keyed by file extension, or by the whole
  basename for extensionless files), any unrecognized top-level field and the cache file path
  are omitted.
- **`--include-sensitive`:** the cache file path (`cacheFile`), session file paths as entry
  keys, and full entries including `title`, `workspaceFolderPath` and `repository`. URL
  userinfo (`user:token@`) is stripped from `repository` even in this mode
  (`stripUrlUserinfo`, line 295).

## External programs run

None.

## Mitigations in the code

- Read-only and offline; no code path writes a file or opens a socket.
- Session-identifying fields are omitted by default via a top-level allowlist; opting in
  requires `--include-sensitive`.
- `--last` must be all digits and at least 1, otherwise the script exits 2; it is capped at
  100 entries (`parseLastCount`, line 34).
- Only the user's VS Code globalStorage directories are searched (`readCacheFile`, line 351).
  Every decision is made about the open descriptor, never about a path checked beforehand.
  The candidate is opened first. On POSIX the open uses `O_NOFOLLOW`, which refuses a
  symlink, and `O_NONBLOCK`, so opening a FIFO returns at once instead of waiting for a writer
  (it has no effect on reading a regular file). Then `fstat` on the descriptor must report a
  regular file. The path is then `lstat`ed, which
  does not follow links, and must be a regular file with the same `dev` and `ino` as the
  descriptor (compared as bigints). That refuses a symlink on Windows, where `open` follows
  it but `lstat` reports the link itself, and anything else Node reports as a link (such as
  a reparse point). It also refuses a path swapped after the open. The content is read
  through that same descriptor.
- The first candidate file that exists decides the result. If it is malformed (invalid JSON,
  or a snapshot without a usable envelope) the script stops with exit 3. It does not fall back
  to an older legacy export, and it does not print an envelope's metadata fields as cache
  entries.
- `load-cache-data.test.js` pins these rules and runs in CI (`validate-skills.yml`, which
  also triggers on `src/types.ts` changes). It parses `SessionFileCache` and
  `SessionUsageAnalysis` from `src/types.ts` and fails when a field has not been classified
  as printed, filtered or omitted. It also checks that a fully populated entry prints exactly
  the printed fields and none of the omitted sentinels, including sentinel keys inside the
  tool, MCP and skill name-keyed maps. `CorrectionMoment` fields are classified the same
  way. A sweep test seeds every session-derived string in a realistic entry (keys and values,
  at every depth) and fails if any of them appears anywhere in the default output. Separate
  tests cover the cache-source
  rules: which files are read and in what order, envelope unwrapping, temp/cwd files ignored,
  directories skipped, and symlinks refused and skipped in favour of the next real
  candidate. The symlink tests run on Windows too, and skip only when the account cannot
  create symlinks (`EPERM`). A FIFO test (POSIX only) checks that a FIFO at a candidate path
  is skipped without blocking; every spawned run has a 15 s timeout, so a hang fails the test.

## Known gaps

- The classification test reads field names, not their contents. A field that is already
  classified as printed and later starts carrying free text or paths (for example a new
  map added to `modelEfficiency`) is not caught; the sweep test only covers the strings it
  seeds. The remaining strings in the default output are model ids (including custom or
  local model names, which the repository rules allow), effort levels, the CLI context tier,
  task categories and labels from this repo's own fixed lists (reference kinds, pattern
  labels). They are printed as-is. A new VS Code reference kind shows up as `other` until it
  is added to `KNOWN_REFERENCE_KINDS`.
- With `--include-sensitive`, session titles (which can echo a prompt), first user prompts,
  correction snippets and local paths are printed unfiltered by design.
- Only the last path component is checked for links. If a parent directory (for example
  `globalStorage/<extension id>`, or a junction on Windows) is itself a link, it is followed.
  This is the same on every platform.
- A hard link at a candidate path is a regular file to `lstat`, so it is read. On Windows,
  creating a hard link needs no special privilege, only write access to the user's profile
  directory and a target on the same volume. Placing a link or file there already requires
  the user's own write access, so this skill does not defend against it.
