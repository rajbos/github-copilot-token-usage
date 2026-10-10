# Validating a change before it ships

This is the map of what checks exist, what each one can and cannot catch, and
which command to run when.

## Why this document exists

The type checker and the unit suite cover the logic. They do not cover the two
seams where this codebase actually breaks after a burst of merged PRs:

1. **The webview ↔ extension host seam.** A panel talks to the host over
   `postMessage`, which is untyped by construction. A button can post
   `{ command: 'copyFailed' }` forever while the host has no branch for it —
   nothing fails to compile, no test goes red, and the click silently does
   nothing.
2. **The markup ↔ listener seam.** A `<button>` nobody called
   `addEventListener` on looks exactly like a working one, in the source, in a
   screenshot, and in a code review.

Both classes are invisible to every check that does not either read both sides
of the wire or actually click the thing. That is what the checks below add.

## One command before a release

```bash
cd vscode-extension && npm run preflight
```

Runs everything, in stages, on your machine, against your real editor data. It
does **not** stop at the first failure — a release decision needs the whole
picture, so it runs every check and prints one verdict at the end.

```bash
npm run preflight -- --list          # what it would run, and why each one exists
npm run preflight -- --quick         # skip the slow browser stage (~2 min faster)
npm run preflight -- --stage local   # only the checks that need real editor data
npm run preflight -- --skip visual   # everything except one check
npm run preflight -- --json          # machine-readable
```

Exit codes: `0` release-ready, `1` a required check failed, `2` preflight could
not run.

### Why it must run on your machine

CI has no Copilot history, no `~/.copilot/data.db` and no JetBrains logs, so the
`local` stage can only ever run where you are. That stage is the reason to run
preflight at all rather than trusting a green PR: it is the only place that
validates the extension against session data from the editors you actually use.

A check that reports **“not available on this machine”** is listed separately
rather than counted as a pass. On a release machine those lines are the ones
worth reading — a green run that checked nothing is exactly the failure mode
this is meant to prevent.

## The stages

### `static` — compiles, lints, and the wiring the compiler cannot see

| Check | Command | Catches |
|---|---|---|
| `types` | `npm run check-types` | type errors |
| `lint` | `npm run lint` | lint errors |
| `json` | `npm run lint:json` | malformed data files |
| `l10n` | `npm run lint:l10n` | localization keys out of sync |
| `compile` | `npm run compile` | build failures |
| `contract` | `npm run check:contract` | **a message with no handler on the other side** |

### `test` — the unit suite

| Check | Command |
|---|---|
| `unit` | `npm run test:node` |

### `ui` — what the panels actually do when you click them

| Check | Command | Catches |
|---|---|---|
| `interaction` | `npm run check:interaction` | **a control that does nothing when clicked** |
| `visual` | `npm run visual:diff` | what the change looks like, next to the merge base |

### `local` — your real editor data on this machine

| Check | Command | Catches |
|---|---|---|
| `editor-data` | `npm run check:editor-data` | an editor that stopped producing readable sessions |
| `session-schemas` | `node .github/skills/validate-session-schemas/validate-session-schemas.js` | a log format that drifted |
| `debug-log-schema` | `node .github/skills/discover-debug-log-schema/discover-debug-log-schema.js` | VS Code Chat debug-log drift silently turning exact billing into estimates |
| `editor-names` | `node .github/skills/validate-editor-names/validate-editor-names.js` | CLI and extension disagreeing on an editor's name |
| `app-db` | `node .github/skills/validate-app-db-schema/validate-schema.js` | `data.db` schema drift |
| `model-pricing` | `node .github/skills/validate-model-pricing/validate-model-pricing.js` | a model with no pricing entry (advisory) |

## The two new checks, in detail

### `check:contract` — webview message contract

```bash
npm run check:contract
```

Reads both sides of the `postMessage` wire and reports any message with no
counterpart, in either direction:

- **webview → extension**: a command a bundle can post that no host branch
  handles. The button click goes nowhere.
- **extension → webview**: a command the host posts that no webview branch
  handles. The UI never updates.

Commands are collected with the TypeScript AST, so all three dispatch shapes
this codebase uses count: a `switch (message.command)`, an `=== 'literal'`
comparison, and the keys of a `Record<string, Handler>` map (whether that map is
a typed variable or returned from a method like `_getAnalysisMessageHandlers`).

The *handled* side is additionally widened by a plain-text scan, which reaches
handlers living inside inline `<script>` template literals (`loadingHtml.ts`,
`backend/configPanel.ts`) that the AST sees as one opaque string. Widening the
handled set can only ever hide a finding, never invent one. That asymmetry is
deliberate: a checker that cries wolf gets switched off, so precision on
findings is worth more than exhaustiveness.

Runs in CI on every PR, and as a unit test (`test/unit/webviewContract.test.ts`)
so a regression also fails the normal test suite.

**If it flags something you believe is fine**, add it to `ALLOWED_UNHANDLED` in
`scripts/validate-webview-contract.js` **with the reason**. Keep that list
short — it is the escape hatch, not the norm.

### `check:interaction` — interaction smoke

```bash
npm run check:interaction
npm run check:interaction -- --view chart,usage   # one or more views
npm run check:interaction -- --isolate            # reload between clicks (slow, exhaustive)
npm run check:interaction -- --concurrency 1      # one view at a time (default 4)
```

Renders the **real** webview bundles headlessly (reusing the `visual-view-diff`
harness — never the Extension Development Host, see *Never Launch a Real
Editor/IDE Instance* in `AGENTS.md`), then exercises every interactive control —
clicking buttons, links, checkboxes and radios, and **changing `<select>`
dropdowns to another option** — and records what happened:

| Outcome | Meaning |
|---|---|
| `posted` | posted a message to the host — wired |
| `dom-only` | changed the DOM but posted nothing — wired, client-side only |
| `noop-selected` | already the selected option; doing nothing is correct |
| `skipped` | not clickable in this pass (something else was covering it) |
| `inconclusive` | the DOM never settled, so the result is not trustworthy |
| `dead` | **posted nothing and changed nothing — a finding** |
| `click-threw` / `change-threw` | **threw an error — a finding** |

It also flags a control that posts a command with no host handler, which is the
half the static check cannot see: a command name computed at runtime
(`{ command: someVar }`) resolving to something nobody handles.

Three details matter for trusting the result:

- **`<select>` is driven by `selectOption`, not by a click.** Playwright's click
  only opens the native picker, which the page never sees, so a dropdown clicked
  that way fires no `change` event and looks inert. Every `<select>` is instead
  set to its first other enabled option, firing `input` + `change` the way a user
  picking an option does. A `<select>` with only one usable option is skipped —
  there is nothing to change it to. Without this, every dropdown in the extension
  (chart filters, the Efficiency scope toolbar) would ship silently unvalidated.

- **Focus state is normalized away** before the DOM is fingerprinted. Clicking
  anything moves focus, and focus is visible in the markup (`vscode-button`
  carries a `focused` attribute). Hashing raw `innerHTML` reports a DOM change
  for *every* click, which scores dead buttons as wired — a false negative in
  the direction that matters most.
- **The DOM must go quiet** before each measurement, so a slow re-render from
  the previous click is not credited to the next control.

Controls are clicked in one pass over a single page, so a click that opens a
dialog can hide later controls; those are reported as `skipped`, never as
failures. Use `--isolate` to reload the page between clicks when a view's
results look polluted — it is exhaustive but takes ~10 minutes for all views,
which is why it is not the default.

**Adding a view to the crawl** means adding it to
`.github/skills/visual-view-diff/views.config.json` — the same registry the
visual diff uses, so a view added for one is picked up by both.

**Scenarios** cover what the one-pass crawl cannot reach: a `<select>`, which is
changed rather than clicked, and a control that only appears once another one has
been used. A view declares them in the same registry:

```jsonc
"scenarios": [{
  "name": "Models tab: every mode/window/model combination still compares",
  "expect": ".model-sides",           // must still be on screen after every step
  "steps": [
    { "click": "[data-tab=\"models\"]" },
    { "select": "#model-b", "value": "claude-haiku-4.5" },
    { "select": "#window", "value": "prev30" }
  ]
}]
```

Each scenario replays on its own fresh page. A `select` step without a `value`
takes the next enabled option. A step that cannot run, throws, or leaves `expect`
no longer *showing* is a finding — "showing" means present **and** rendered (not
`display:none`, `visibility:hidden`, or zero-sized), the same test the control
crawl uses. That last check is how the Models tab proves a picker reconciles
instead of dropping to an empty state.

A step can also carry its own `expect` (must be showing after *that* step) and
`expectHidden` (must not be showing after it), for a toggle whose result only
holds once it was clicked — e.g. `{ "click": "button[data-mcp-view=\"tool\"]",
"expect": "#mcp-period-tool", "expectHidden": "#mcp-period-server" }`.

### A note on the visual diff's baseline

`visual:diff` compares against the merge base with `origin/main`. **On a shallow
clone that ref can be dozens of commits behind its real tip**, and the baseline
then lands on a much older tree — so half the views come back "changed" for
reasons unrelated to the change under review. The script warns when it detects
this; run `git fetch --unshallow` (or pass `--base <ref>`) for a comparison you
can trust. The CI job checks out with `fetch-depth: 0` for the same reason.

Baseline and current render side by side, each with `--concurrency` pages at
once (default 4). Almost all of a render is fixed settle waits, so this is where
the run's time goes. The run prints a per-phase timing table at the end and
writes it to `visual-output/timings.md`; CI appends that table to the
`ui-checks` job summary. If a diff looks noisy, rerun with `--concurrency 1` to
rule out machine load.

## What CI runs

| Job | Checks |
|---|---|
| `build` | types, lint, json, l10n, compile, **contract**, unit tests |
| `ui-checks` (PRs only) | **interaction smoke**, **visual view diff vs the merge base** |
| `validate-skills` / `security-classification` | **every skill that ships scripts has a `SECURITY.md` or an exempt/pending entry** (`node scripts/validate-skill-security.js`, over all skills) |

`ui-checks` renders every view in its initial state and in each tab/mode it
declares as a `state` in `views.config.json`, then **posts the before/after/diff
images as a comment on the PR** (one comment, replaced on every push) with
`gh pr comment --attach`, rendered by
`.github/workflows/scripts/visual-diff-comment.js`. A reviewer sees the UI
change where they review, instead of inferring it from a CSS diff. The full set
of screenshots is also uploaded as the `webview-screenshots` artifact and the
report table goes into the job summary. The visual diff reports rather than
gates — a visual change is usually intended — while the interaction smoke does
gate, because a dead control never is.

Two things to know about that comment:

- `gh --attach` only uploads with a **user** token (OAuth or a PAT); the Actions
  installation token is refused. The job uses the repository's `GH_PAT` secret
  for the upload, so the comment is authored by that user. Without the secret
  the comment still posts, minus the inline images, linking to the artifact.
  On a `pull_request` run the workflow file and the publisher script both come
  from the PR head, so any same-repository contributor can already change what
  runs next to that secret — the same trust the risk-review workflow extends.
  Keep `GH_PAT` narrow, but not narrower than the upload: attaching files
  [needs push access](https://docs.github.com/en/github-cli/github-cli/attaching-files-with-github-cli),
  so a fine-grained token limited to this repository needs *Contents: write*
  (that is push access) plus *Pull requests: write* to author the comment.
  gh's pre-flight checks the user's role on the repository, not the token's
  own grants, so a token without *Contents: write* passes that check and then
  fails at upload with `HTTP 403: Resource not accessible by personal access
  token`. A token with *Contents: write* but no *Pull requests: write*
  uploads fine and then fails on the comment with `Resource not accessible by
  personal access token (addComment)`. Whenever images were due but could not
  be attached, the comment itself opens with a warning saying why, and a job
  annotation repeats it: that `GH_PAT` is not configured, that
  it could not be authenticated (with gh's error from `gh api user`, which
  may be a bad token or a transient GitHub/network failure), or, when gh got
  as far as the upload, gh's error from `gh pr comment --attach` with a
  permission hint. A missing permission therefore shows up on the PR rather
  than only on the checks page. That step also **fails the job** when images
  were due and a configured `GH_PAT` could not deliver them (rejected token,
  failed upload): the comment is still posted without images, then the step
  exits non-zero so an expired or under-scoped token is a red check instead of
  a silent gap. Only an unset `GH_PAT` stays a notice. Dependabot runs skip the
  step entirely (no secrets and a read-only `GITHUB_TOKEN`, so not even the
  image-free comment can post); their screenshots stay in the artifact.
- Fork PRs get a read-only token and no secrets, so they only get the artifact.
- Only a comment authored by one of the workflow's own identities (the Actions
  bot, the PAT's user) **and** whose body *starts* with the marker is ever
  replaced; the newest one survives, so two runs that race still converge on a
  single comment. Identity is the ownership proof, never body text: a comment
  someone else writes to look like ours is left alone. After a PAT rotation the
  previous user's comment is no longer recognised and needs deleting by hand.

## What is deliberately not covered

- **The Team Dashboard view** needs a configured backend to render meaningful
  data, so it is disabled in `views.config.json` and skipped by both the
  interaction smoke and the visual diff.
- **Binary/DB session formats** (Crush sqlite, Visual Studio MessagePack,
  Continue, Mistral Vibe, Claude Desktop) are not schema-validated; they need
  the adapters' own binary parsers. `check:editor-data` lists them so their
  absence is visible rather than silent.
- **A dead control that is already the selected option** is reported as
  `noop-selected`, not as a finding. That is the trade for not carrying three
  standing false positives on the chart view's segmented controls.

## VS Code extension release provenance

Every VS Code extension VSIX built by `release.yml` and the nightly pre-release
workflow ships with SPDX JSON SBOMs and Sigstore-backed GitHub attestations
(build provenance and SBOM). The shared logic is the composite action
`.github/actions/vsix-attest`. In both workflows a separate `attest` job attests
the VSIX workflow artifact, and the `publish` job re-verifies the same artifact
before it publishes to the Marketplace or Open VSX. The job that builds the VSIX
can neither sign nor publish it. SBOMs are attached to the
GitHub release (nightlies keep them as the `vsix-sbom` workflow artifact).

To verify a downloaded VSIX (needs the [GitHub CLI](https://cli.github.com/)):

```sh
gh attestation verify <file>.vsix --repo rajbos/ai-engineering-fluency
```

This proves the file was built by this repository's GitHub Actions workflows from
the recorded commit. It does not cover the Visual Studio, JetBrains or CLI releases.

## Sharing server

The extension preflight above does not validate the sharing server. Server coding
and testing follow the [authoritative data separation contract](../sharing-server/AGENTS.md),
including its HTTP/HTML privacy regression checklist. Unlike the extension's
`local` stage, server tests must never read production data or call live GitHub:
use isolated temporary SQLite fixtures, never user databases, and stub authentication.

From `sharing-server`, run:

```sh
npm run check-types
npm run build
npm test
npm run check:interaction
```

The server's `check:interaction` is a reproducible headless browser check,
separate from the extension command of the same name. It requires an existing
Playwright installation and its Chromium browser, resolved through
`.github/skills/visual-view-diff/lib/browser.js`; no new dependencies are added.
Against an isolated temporary-fixture server, it clicks period links, team-total
and daily-average trend modes, raw daily-total expansion, CSV/JSON downloads and
personal-dashboard navigation. It also loads the personal dashboard, Team
Insights and the admin dashboard at phone widths (390px and 320px) and fails if
any of them is wider than the screen; only tables may scroll sideways, inside
their own card. It never launches an editor or IDE and does not use production
data or live GitHub.

The root test entry point is:

```powershell
.\build.ps1 -Project sharing -Target test
```

It runs the server's `npm test`, not the separate type/build/interaction checks.
The deployment workflow gates on `npm test` and `npm run check:interaction`,
using the repository's locked Playwright tooling. The package publishing workflow
also runs `npm test` before the library build.

Exercise `/team` with a session cookie and `/api/team-insights` with a bearer token
through actual HTTP routes, plus both CSV and JSON `/team/export` downloads with
a session cookie. Verify the full-page period links also work without JavaScript,
daily-average denominators use daily active uploaders, and expanded totals match
the safe payload. Inspect complete responses, including hidden markup
and embedded scripts, with exact key allowlists and seeded sentinel-absence
assertions. Cover owner/admin authorization, identity-free admin member views,
private/no-store caching, and the contract's UTC-window, activity, ties, quartiles
and no-peer edge cases. New exports and downstream route overrides need the same
checks. A chart screenshot or a helper-only unit test cannot establish separation.
All automated verification is non-interactive; never launch a GUI editor/IDE.
