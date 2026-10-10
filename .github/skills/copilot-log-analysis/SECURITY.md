# Security model: copilot-log-analysis

Lightweight model derived from reading `session-file-discovery.js`, `get-session-files.js`,
`diagnose-session-files.js` and `analyze-session-schema.ps1`. Update it in the same PR as
any change that adds or alters a trigger surface (see "Skill security classification" in
the repository `AGENTS.md`).

This skill is classified as modelled (not exempt) because `analyze-session-schema.ps1`
reads the user's private AI session logs and writes what it derives into a file inside
the repository's tracked `docs/` tree by default (triggers 4 and 6). Since #2308 that
default output holds structure only; copying values out of the logs needs the explicit
`-IncludeExamples` opt-in.

## What the scripts do and talk to

- `session-file-discovery.js` (library), `get-session-files.js` and
  `diagnose-session-files.js` locate session files of VS Code variants, Copilot CLI
  and OpenCode under the user's home/AppData and print counts,
  paths, sizes and modification times. They only call `readdirSync`/`statSync`; they never
  open a session file's content.
- `analyze-session-schema.ps1` opens up to `-MaxFiles` (default 10) session files per
  location, parses them as JSON/JSONL, and builds a field-path schema with types and
  counts, plus example values only with `-IncludeExamples`.
- No script makes network requests.

## Credentials used and where they come from

None. Environment variables read: `APPDATA`, `USERPROFILE`, `XDG_*`, `CODESPACES`,
`VSCODE_*` (to find paths and report the environment).

## Untrusted inputs parsed

- The user's own session logs (`ConvertFrom-Json` on whole files and lines in the
  `.ps1`). They hold prompts, responses and file paths and can contain arbitrary
  attacker-supplied text if a conversation pulled in web or repository content. The
  `.ps1` only walks the object tree and records field names, types, counts and (opt-in)
  example values; it does not execute or interpret content.
- `docs\logFilesSchema\session-file-schema.json` (compared against, repo content).

## What it writes and where

- `analyze-session-schema.ps1` writes `$OutputFile`, default
  `docs\logFilesSchema\session-file-schema-analysis.json` (relative to the current
  directory), creating parent directories. This is a tracked repository file.
- By default the output holds field paths, types and counts, plus JSONL top-level event
  `type` values that match `^[A-Za-z0-9_.\-]{1,64}$` (at most 50). Field paths are
  object keys from the logs, so they can include tool-call ids and numeric indices.
- With `-IncludeExamples` it also stores up to 3 distinct example values per field
  path: strings truncated to 100 characters, other scalars verbatim. Free-text fields
  such as chat input, titles, file paths and tool arguments are then copied into the
  output.
- The other scripts write nothing.
- Stdout of the Node scripts contains session file paths (workspace hashes, session ids)
  with the home directory shown as `~`; with `--json` the same plus sizes and timestamps.
  `--show-paths` prints the home directory in full.

## External programs run

- `analyze-session-schema.ps1` runs `git rev-parse --show-toplevel` (fixed arguments,
  only with `-IncludeExamples`) to tell whether the output file is inside a repository.

## Mitigations in the code

- The Node scripts never read session content, so their output is limited to paths and
  file metadata, and they replace the home directory prefix with `~` (`redactHomePath`
  in `session-file-discovery.js`) unless `--show-paths` is given.
- `analyze-session-schema.ps1` records no field values unless `-IncludeExamples` is
  passed. Event type names are kept only when they look like identifiers, so a free-text
  `type` cannot slip through.
- With `-IncludeExamples` it prints a warning that session values were written, and a
  second warning when the output file resolves inside the current git repository.
- It limits the sample (`-MaxFiles`, 3 examples per field, 100 characters per string,
  first 3 array items).
- A file or line that fails to parse is skipped; the per-file warning prints only the
  exception type, not the parser message (which can quote file content).
- New-field detection uses `String.Contains`, a literal match, so log-derived field
  names are not interpreted as wildcard patterns.
- The committed `docs/logFilesSchema/session-file-schema-analysis.json` had all
  `examples` arrays stripped in #2308.

## Known gaps

- **Git history.** Earlier commits of
  `docs/logFilesSchema/session-file-schema-analysis.json` still contain example values
  (prompt text, session titles, local file paths, an account label). Removing them
  needs a history rewrite, which is left to the maintainer.
- Nothing stops a contributor from running `-IncludeExamples` with the default output
  path and committing the result; the script only warns.
- Node script paths still contain workspace hashes and session ids, which identify
  local workspaces; the scripts ask the user to review output before sharing it.
- `redactHomePath` only redacts the home directory prefix. A session path outside the
  home directory (for example `/tmp/.vscode-server`) is printed unchanged.
