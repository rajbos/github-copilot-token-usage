# Security model: validate-session-schemas

Lightweight model derived from reading `validate-session-schemas.js` and
`schema-baselines.json`. Update it in the same PR as any change that adds or alters a
trigger surface (see "Skill security classification" in the repository `AGENTS.md`).

This skill is classified as modelled (not exempt) because it temporarily copies OpenCode
conversation data into the OS temp directory, outside stdout and outside any declared output
location (trigger 4), and because its opt-in example mode can print session content
(trigger 6).

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

- The user's session logs and the OpenCode SQLite database (`opencode.db`, opened
  read-only through `node:sqlite`). They contain prompts, responses and paths and can contain text from any
  web page or repository a conversation touched. Content is `JSON.parse`d and walked; it is
  never executed.
- Object keys from those logs become the reported "field paths". Keys are therefore
  log-derived text too; identifier-shaped keys are collapsed to `{key}` (see Mitigations).
- OpenCode session ids from the database are joined into temp file names only after
  matching `^[A-Za-z0-9_-]{1,128}$`; other ids are skipped.

## What it writes and where

- `--update-baseline` rewrites `schema-baselines.json` in this skill directory: it merges
  the observed field paths into `knownFields` and sets `lastUpdated`. Contracts are not
  touched. Only field paths are persisted, no values.
- **OpenCode export to temp.** `exportOpenCodeDbSessions` ranks the DB sessions inside the
  `--days` window together with the recent legacy JSON session files and exports only the
  DB sessions that land in the platform's top `--max`. A session present in both stores is
  analyzed once, from the DB. For those, it creates a `mkdtemp` directory `oc-dbses-*` under
  the OS temp dir and writes one JSONL file per session containing the raw `message.data`
  of its messages. All other sessions are counted, not written. `run` removes the
  directory in a `finally` once analysis ends, including on errors, and on SIGINT, SIGTERM
  or SIGHUP (see Mitigations). The report refers to these sessions as
  `<dbPath> [session <id>]`, not by temp path.
- Stdout: the report. Example values appear only with `--include-examples` (strings
  redacted, then cut to 40 characters; numbers and booleans verbatim; 2 per field).

## External programs run

None. SQLite is accessed in-process.

## Mitigations in the code

- Values are not emitted by default (header comment and `--include-examples` gate); only
  paths, types and counts.
- Bounded work: `--max` files per platform, `--days` recency window, 5000 lines per file,
  5 array elements per array (`ARRAY_SAMPLE`).
- The temp directory comes from `mkdtemp`, so another local user cannot pre-create or
  symlink a predictable path. Files inside it are written with `flag: 'wx'` (fail if they
  exist), named from validated session ids only, and the whole directory is removed in
  `run`'s `finally`. Deletion uses `rmSync` with bounded retries (`maxRetries: 3`,
  `retryDelay: 100`); a directory is dropped from the cleanup list only after it is
  actually gone, so the signal handler can retry it. A directory that still cannot be
  removed is reported, never swallowed: a `cleanup failed` warning with the path on
  stderr, `tempCleanupFailed` in the report, and exit code 1. Only DB sessions that will
  actually be analyzed (combined
  `--days`/`--max` window) are exported.
- `run` registers SIGINT/SIGTERM/SIGHUP listeners. Without a listener Node terminates on
  these signals immediately and skips `finally`; with one, the signal is queued until the
  synchronous run returns (after the `finally` cleanup), and the handler then removes any
  remaining temp directory and exits with `128 + n` (130 SIGINT, 143 SIGTERM, 129 SIGHUP),
  with the signal name bound at registration.
- The DB export is all-or-nothing: the file list, counts and report labels are committed
  only after every export succeeded. If reading `opencode.db` or writing an export fails,
  the run falls back to the legacy JSON sessions unchanged, adds an
  `opencode.db could not be read` note to the report (status `INCONCLUSIVE` if no JSON
  sessions exist either), and still removes any temp directory already created.
- DB `time_updated` values are untrusted: only values `new Date()` can represent are used
  for the reported newest date, so a corrupt or unit-shifted timestamp cannot make
  `toISOString` throw and abort the run.
- Recent sessions whose id fails validation are skipped and noted in the report; a
  platform whose recent sessions are all unanalyzable reports `INCONCLUSIVE`, not
  `NO_RECENT_FILES`.
- `opencode.db` is opened with `readOnly: true`; only `SELECT` statements are run.
- `normalizeKey` collapses object keys that do not look like field names (path
  separators, dots, colons, whitespace or other punctuation, UUID/hex/long-id shapes,
  runs of 4+ digits, more than 64 characters) to `{key}` before they become field paths,
  so dictionaries keyed by file path, URL or session id do not put those identifiers into
  the report or `schema-baselines.json`.
- `--include-examples` values pass through `redactExample`: GitHub/OpenAI/Slack/AWS
  token shapes, JWTs, `Bearer`/`Basic` credentials and long base64/hex runs become
  `[redacted]`, e-mail addresses `[email]`, and the home directory `~`.
- Tests in `validate-session-schemas.test.js` cover the combined window selection and
  deduplication, id validation and the unsafe-id `INCONCLUSIVE` path, read-only open,
  temp cleanup (end to end), key collapsing and redaction, using synthetic fixtures only.
  `validate-skills.yml` runs them whenever this skill changes.
- The baseline file path is fixed next to the script; `--update-baseline` never edits
  contracts.

## Known gaps

- Keys shaped like plain identifiers are kept, so dictionaries keyed by tool name or model
  id (for example `copilot_readFile`, `gpt-6-luna`) still appear in field paths. These are
  product identifiers, not user data, but they do reach the report and baseline.
- The temp export still exists on disk while the run is in progress, and a directory whose
  delete keeps failing (for example a file held open by another process) stays on disk
  until the user removes it. It is reported, not retried on a later run. Termination that
  cannot be intercepted — `SIGKILL`, Windows `taskkill /F` or closing the console window,
  a crash of the Node process itself, power loss — skips the cleanup and leaves it behind.
  The handler itself (cleanup + exit code) is unit-tested; delivery of a real signal is not.
- `--include-examples` redaction is pattern-based: prompt text, file paths outside the home
  directory and secrets in unrecognised formats still print (truncated to 40 characters).
  The flag remains opt-in and documented.
