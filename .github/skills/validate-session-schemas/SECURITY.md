# Security model: validate-session-schemas

Lightweight model derived from reading `validate-session-schemas.js` and
`schema-baselines.json`. Update it in the same PR as any change that adds or alters a
trigger surface (see "Skill security classification" in the repository `AGENTS.md`).

This skill is classified as modelled (not exempt) because it copies OpenCode conversation
data into the OS temp directory, outside stdout and outside any declared output location
(trigger 4), and because its opt-in example mode can print session content (trigger 6).

## What the scripts do and talk to

- Finds recent session files for Copilot Chat (VS Code variants), Copilot CLI
  (`~/.copilot/session-state`), JetBrains (`~/.copilot/jb`), Claude Code
  (`~/.claude/projects`), Gemini CLI (`~/.gemini/tmp`), Antigravity
  (`~/.gemini/antigravity/brain`) and OpenCode (`~/.local/share/opencode`).
- Reads up to `--max` files per platform (default 5) modified within `--days` (default 30),
  at most 5000 JSONL lines per file, walks each JSON value recording field paths and types,
  and checks the small "contract" of fields our parsers need against `schema-baselines.json`.
- Prints a per-platform report (status, record types, contract results, up to 40 new
  field paths). `--json` prints the same as JSON.
- No network access.

## Credentials used and where they come from

None. Environment variables read: `APPDATA`, `XDG_CONFIG_HOME`, `XDG_DATA_HOME` (paths only).

## Untrusted inputs parsed

- The user's session logs and the OpenCode SQLite database (`opencode.db`, read through
  `node:sqlite`). They contain prompts, responses and paths and can contain text from any
  web page or repository a conversation touched. Content is `JSON.parse`d and walked; it is
  never executed.
- Object keys from those logs become the reported "field paths". Keys are therefore
  log-derived text too.

## What it writes and where

- `--update-baseline` rewrites `schema-baselines.json` in this skill directory: it merges
  the observed field paths into `knownFields` and sets `lastUpdated`. Contracts are not
  touched. Only field paths are persisted, no values.
- **OpenCode export to temp.** When `opencode.db` exists, `discoverOpenCode` creates a
  `mkdtemp` directory `oc-dbses-*` under the OS temp dir and writes one JSONL file per
  session containing the raw `message.data` of every message (lines 256-276). Nothing
  removes these files or the directory afterwards.
- Stdout: the report. Example values appear only with `--include-examples` (strings cut
  to 40 characters, numbers and booleans verbatim, 2 per field).

## External programs run

None. SQLite is accessed in-process.

## Mitigations in the code

- Values are not emitted by default (header comment and `--include-examples` gate); only
  paths, types and counts.
- Bounded work: `--max` files per platform, `--days` recency window, 5000 lines per file,
  5 array elements per array (`ARRAY_SAMPLE`).
- The temp directory comes from `mkdtemp`, so another local user cannot pre-create or
  symlink a predictable path.
- The baseline file path is fixed next to the script; `--update-baseline` never edits
  contracts.

## Known gaps

Recorded, not fixed here.

- **Plain-text copy of OpenCode conversations is left in temp** (lines 263-276). Every
  session in `opencode.db` is exported, not just the ones inside the `--days`/`--max` window,
  and the files stay on disk after the run. Fix: clean the directory in a `finally`, and
  select the recent sessions before exporting.
- The database is opened without `readOnly` (line 257), although only `SELECT` is run.
- `${session.id}.jsonl` is joined into the temp path with the id taken from the database
  unvalidated (line 269).
- Reported and persisted field paths are built from log object keys. Dictionaries keyed by
  file path, session id or tool name would put those identifiers into the printed report
  and, with `--update-baseline`, into the tracked `schema-baselines.json`. The current
  baseline has no such keys, but nothing prevents them.
- `--include-examples` can print prompt text, paths and secrets from logs; the flag is
  documented but there is no redaction.
