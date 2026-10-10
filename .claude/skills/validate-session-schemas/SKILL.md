---
name: validate-session-schemas
description: Loop over recent local AI-coding session log files for every supported file-based platform (Copilot Chat, Copilot CLI, JetBrains, Claude Code, Gemini CLI, Antigravity, OpenCode) and validate they still match the documented schema, while surfacing newly-discovered fields we could start using. Use after an editor/CLI update, when adding a parser, or on a schedule to catch schema drift early.
---

# Validate Session Schemas Skill

Validates that **recent** session log files on the current machine still match
the schema our parsers expect, **per supported platform**, and surfaces
**new fields** that appeared on disk but aren't documented/used yet.

It answers two questions in one pass:

1. **Did anything break?** — Drift detection against a small set of fields our
   parsers actually depend on ("contracts"). A missing required field on an
   observed record type is a `DRIFT` failure.
2. **Is there new information to use?** — Any field observed on disk that is not
   in the known baseline ("knownFields") is reported as a new field. These are
   candidates for new features or better token attribution (e.g. real token
   counts, new model metadata, new event types).

## Why this skill exists

The pre-existing `copilot-log-analysis` skill (`analyze-session-schema.ps1`)
only covered VS Code Copilot Chat JSON + Copilot CLI JSONL + OpenCode, with
crude substring-based "new field" detection. It did **not** loop per supported
platform, had no recency window, and didn't cover JetBrains, Claude Code,
Gemini CLI, or Antigravity. This skill closes that gap.

## Platforms covered

The source of truth for supported platforms is
`src/adapters/adapterRegistry.ts`. This skill validates the
**file-based JSON/JSONL** ecosystems that have schema docs under
`docs/logFilesSchema/`:

| Platform id    | Editor / tool        | Format | Discovery root |
|----------------|----------------------|--------|----------------|
| `copilot-chat` | VS Code Copilot Chat | json / jsonl | VS Code variants `workspaceStorage/*/chatSessions`, `globalStorage` |
| `copilot-cli`  | Copilot CLI          | jsonl  | `~/.copilot/session-state/` |
| `jetbrains`    | JetBrains Copilot    | jsonl  | `~/.copilot/jb/{uuid}/partition-*.jsonl` |
| `claude-code`  | Claude Code          | jsonl  | `~/.claude/projects/{hash}/*.jsonl` |
| `gemini-cli`   | Gemini CLI           | jsonl  | `~/.gemini/tmp/*/chats/session-*.jsonl` |
| `antigravity`  | Antigravity          | jsonl  | `~/.gemini/antigravity/brain/*/.system_generated/logs/transcript.jsonl` |
| `opencode`     | OpenCode             | json / jsonl | `<xdg-data>/opencode/storage/session/**/ses_*.json`; also `opencode.db` (SQLite, via `node:sqlite`) |

**Not validated by this skill** (DB / binary formats that need the adapters'
own parsers, so a generic JSON walker can't read them): `crush` (SQLite),
`visual-studio` (MessagePack), `continue`, `mistral-vibe`, `claude-desktop`.

OpenCode's `opencode.db` is opened read-only. Only the DB sessions that land in
the platform's `--days` / `--max` window (ranked together with legacy JSON
sessions; a session in both stores is analyzed once, from the DB) are exported,
as temporary JSONL files in a fresh `oc-dbses-*` directory under the OS temp dir.
That directory is removed when the run ends — in a `finally`, so also on errors,
and before exiting on Ctrl-C / SIGTERM / SIGHUP. Other sessions are counted, not
copied. The report labels exported entries `…/opencode.db [session <id>]`. Recent
sessions whose id fails validation are skipped and noted; if nothing recent is
left to analyze, the platform reports `INCONCLUSIVE`.
They are listed in the report under "Not validated" so coverage is never
silently overstated. If you add a new file-based adapter, add a discovery
function + a `schema-baselines.json` entry here too.

## Usage

```bash
# Validate every platform's recent sessions (last 30 days, 5 files each)
node .github/skills/validate-session-schemas/validate-session-schemas.js

# Widen the window and look at more files
node .github/skills/validate-session-schemas/validate-session-schemas.js --days 60 --max 10

# One platform only
node .github/skills/validate-session-schemas/validate-session-schemas.js --platform claude-code

# Machine-readable output (for CI / further processing)
node .github/skills/validate-session-schemas/validate-session-schemas.js --json

# Refresh the "known fields" snapshot from what's on disk (does NOT touch contracts)
node .github/skills/validate-session-schemas/validate-session-schemas.js --update-baseline

# Include truncated example values (may contain user content — off by default)
node .github/skills/validate-session-schemas/validate-session-schemas.js --include-examples
```

### Options

| Flag | Meaning |
|------|---------|
| `--days N` | Only consider files modified within the last N days (default 30; `0` = no limit) |
| `--max N` | Analyze at most N most-recent files per platform (default 5) |
| `--platform <id>` | Validate a single platform |
| `--update-baseline` | Rewrite `knownFields` from observed fields; never modifies `contracts` |
| `--include-examples` | Capture truncated example values per field (best-effort redaction of tokens, e-mail addresses and the home directory; prompt text still passes through) |
| `--fail-on-new-fields` | Exit non-zero when new fields are discovered |
| `--json` | Emit JSON only |
| `--help` | Usage |

### Exit codes

- `0` — all observed contracts pass (new fields alone do not fail unless `--fail-on-new-fields`)
- `1` — contract drift, an unparseable file, or a temp export (OpenCode) that could not be deleted — the path is printed on stderr and in the report (`tempCleanupFailed`)
- `2` — configuration / environment error (bad args, missing baseline)

### Per-platform statuses

`PASS`, `DRIFT`, `NO_FILES` (editor not installed / no sessions),
`NO_RECENT_FILES` (sessions exist but none in the window), `INCONCLUSIVE`
(recent files existed but no parseable records).

## How drift and new-field detection work

`schema-baselines.json` holds two independent things per platform:

- **`contracts`** — hand-maintained list of the fields our parsers depend on,
  optionally scoped by `format` (`json`/`jsonl`) and a `discriminator`
  (the JSONL event `type` / `kind`). A contract is only evaluated when matching
  records are actually observed, so a union format never produces false drift
  for an event type that simply wasn't present. `--update-baseline` never
  changes contracts — edit them by hand when the parser's real dependencies
  change.
- **`knownFields`** — the last-known set of observed field paths. New = observed
  − known. Refresh with `--update-baseline` once you've reviewed and accepted
  the new fields.

Field-path notation: `a.b` nested, `arr[]` array items, `arr[].c` a field inside
array items, `a.{key}` any key of a dictionary-like object. Object keys that are
not shaped like a field name (paths, URLs, UUIDs, hex/numeric ids, keys with
dots, colons or spaces) collapse to `{key}`, so those identifiers stay out of the
report and `schema-baselines.json`. This is a heuristic, not a guarantee: keys
that look like plain names — such as tool names or model ids used as dictionary
keys — are kept and do appear in field paths. Review new fields before running
`--update-baseline`.

## Acting on results

- **DRIFT** → a required field disappeared. Open the platform's doc under
  `docs/logFilesSchema/` and the matching adapter under
  `src/adapters/`, confirm the change, and update both the
  parser and the contract.
- **New fields** → review them. If useful (e.g. real token counts, new model
  metadata, a new event type), document them in `docs/logFilesSchema/`, consider
  wiring them into the adapter/parser, then run `--update-baseline` to clear them
  from future reports.

## Periodic run (optional)

This script is dependency-free Node and CI-friendly via its exit codes:

```yaml
- name: Validate recent session schemas
  run: node .github/skills/validate-session-schemas/validate-session-schemas.js --json
```

(On CI the runner usually has no local session files, so most platforms report
`NO_FILES` and the job passes — it's most useful run on a developer machine or a
self-hosted runner that has real session data.)

## Related

- `docs/logFilesSchema/` — per-platform schema documentation (the human source of truth)
- `.github/skills/copilot-log-analysis/` — deeper Copilot-only schema field dump (`analyze-session-schema.ps1`)
- `.github/skills/validate-app-db-schema/` — validates the unrelated `~/.copilot/data.db` hierarchy schema
- `src/adapters/adapterRegistry.ts` — canonical list of supported ecosystems
