# Localization architecture

The repo-wide standard for user-facing text. Supersedes nothing — before this
there was no stated standard, which is the problem it exists to fix.

Written after a full audit of every product in the repo (VS Code extension,
CLI, desktop Electron app, sharing-server, JetBrains plugin, Visual Studio
extension, omp-segment). Numbers below were measured, not estimated.

## The finding that drives everything

**The localization work reaches one of the four hosts that ship it.**

Four products render the *same* webview bundles. Those bundles call `localize()`
against a string dictionary that the host must supply in the panel's initial
payload. Only one host supplies it:

| Host | Files supplying the webview localization dictionary |
|---|---|
| VS Code extension | **12** |
| Desktop (Electron) | **0** |
| Visual Studio | **0** |
| JetBrains | **0** |

It fails silently. Every bundle guards with `if (initialData?.localization)`, so
the three hosts that omit it don't crash — they skip initialization and render
`DEFAULT_LOCALIZATION` English forever, with `<html lang="en">` hardcoded. A
zh-CN user gets English from three of our four products and no setting can
change it.

Confirmed from the build output, not just the source: `DEFAULT_LOCALIZATION` is
compiled *into* each of the 11 `dist/webview/*.js` bundles, and those are
precisely the artifacts JetBrains and Visual Studio copy and redistribute. The
English fallback table physically ships inside both IDE hosts, and with no
`localization` key in either host's payload it is the only string table those
bundles ever consult.

That, not the count of untranslated strings, is the headline. Roughly eleven
views already have complete zh-CN translations that three hosts cannot show.

## There is no single mechanism, and there should not be

The repo has four **runtime contexts**, distinguished by what they can import.
Any "one mechanism" proposal founders on this, so the standard names them:

| Tier | Context | Can import | Mechanism |
|---|---|---|---|
| 1 | Extension host | `vscode` | `t()` from `l10n.ts` |
| 2 | Pure / shared modules | neither `vscode` nor a bundle at call time | **injected `Translate`** |
| 3 | Webview bundles | browser only — no fs, no `vscode` | dictionary in the initial payload, read via `localize()` |
| 4 | Native IDE chrome | platform APIs only | platform-native (`.properties`, `.resx`, `.vsct`) |

Unification means **one source of truth (`package.nls*.json`) with three
adapters**, not one function. Tier 4 is genuinely out of reach: VS loads
`.vsct` command-table strings before any managed code runs, and JetBrains
resolves `DynamicBundle` against the IDE's own language pack. Fighting those is
a losing battle; the correct scope for the shared bundle is *everything
rendered inside a webview*, which is where the overwhelming majority of our
text lives anyway.

Tier 2 is the one this repo kept getting wrong, because it is invisible: a
module with no `vscode` import looks like a pure data module right up until you
notice it is emitting English sentences. `insightsEngine.ts` was the worst case
(53 insights, ~180 strings) and is now the reference implementation — see
[INSIGHTS-CATALOG-LOCALIZATION.md](INSIGHTS-CATALOG-LOCALIZATION.md).

## Standard

### S1 — `package.nls.json` is the only place English text is authored

One source of truth. Any other copy is **generated**, never hand-written.

Today `DEFAULT_LOCALIZATION` (`webview/shared/localization.ts`) is a second
hand-maintained copy of 147 English strings, and the key list exists a third and
fourth time (the `WebviewLocalization` interface, and `getWebviewLocalization()`
in `extension.ts`). They currently agree — verified, 147/147 keys, **zero value
divergences** — but nothing checks that, so they agree by luck. The interface
declares 147 keys above an `[key: string]: string` index signature that
neutralizes all of them, and `getWebviewLocalization()` returns
`Record<string, string>` rather than the interface, so there is no compile-time
link between producer and consumer either.

Adding one webview string today takes **five hand-synchronized edits** across
three files, two of which nothing enforces. The six spill-over helper methods in
`extension.ts` exist purely to keep `getWebviewLocalization()` under
`max-lines-per-function` — a smell pointing straight at this.

### S2 — every host injects the dictionary through one shared helper

The payload-building logic is extracted once and called by all four hosts, so a
host cannot forget it and no host maintains a mirror of the key list. A mirror
would drift exactly like the agents/skills mirror `AGENTS.md` already warns
about.

### S3 — pure modules take an injected `Translate`

Never import `vscode` into a pure module to reach `t()`; that trades a real
property (unit-testability without a shim) for a convenience. Inject
`translate: Translate` instead, supplied as the real `t()` in production and
`createTranslator('en' | 'zh-cn')` in tests — so tests assert against the
actually-shipped bundles rather than a stub.

### S4 — one locale decision per render

Today a single document answers "what locale is this?" **three** different ways:
`resolvedLocale()` for `<html lang>`, raw `vscode.env.language` smuggled through
the string dictionary as `__language__`, and `LC_ALL`/`LANG`/`Intl` for number
formatting. On top of that, ~82 bare `toLocale*()` calls bypass all three, and
`setFormatLocale()` reaches only 2 of 12 bundles — verified in the shipped
artifacts, not just the source: it is called in `dist/webview/usage.js` and
`dist/webview/efficiency.js` only, so the other ten panels ship with
`currentLocale` left `undefined` and fall back to the runtime locale.

**Corrected during implementation.** The original rule said one resolved locale
should feed `<html lang>`, `setFormatLocale()` and all number/date formatting
alike. That is wrong, and collapsing them would have been a regression. There
are **two** legitimately different questions:

| Field | Question | Source | Drives |
|---|---|---|---|
| `language` | *Which strings?* | `resolvedLocale(vscode.env.language)` | `<html lang>`, `localize()` |
| `locale` | *How are numbers and dates written?* | `stats.locale` → `LC_ALL`/`LC_NUMERIC`/`LANG` → `Intl` default | `setFormatLocale()` |

A German developer running an English VS Code legitimately wants `1.234,56`
*and* English UI. `_detectUsageAnalysisLocale` in `extension.ts` already made
this distinction; the mistake was in this document, not in that code.

So: **both** travel as first-class payload fields, and neither is smuggled
through the string dictionary as `__language__`. What was genuinely broken is
that `setFormatLocale()` reached only 2 of 12 bundles, leaving the other ten on
the runtime default. Bare `toLocale*()` with no explicit locale is banned in
webview and CLI code, ratcheted like the hardcoded-string check.

### S5 — proper nouns are not translated, and that is written down

The audit's raw total (~2,850 hardcoded strings) badly overstates the real
surface. `src/toolNames.json` alone is 1,291 entries, and they are product and
API names — `Windsurf: File Edit`, `GitHub: Create Issue`; 696 follow the
`Server: Tool` shape. Translating those would make the UI *worse* and break
recognition against the tools' own documentation.

Excluded by rule: `toolNames.json`, adapter `displayName`/`source` values,
editor names in `workspaceHelpers.ts`, model ids and `modelPricing.json`
display names. Realistic translatable surface is therefore **~1,500**, not
~2,850.

### S6 — contractual strings stay canonical English at the data layer

`UsageCohort` (`'Light' | 'Medium' | 'Heavy' | 'Very heavy'`) is a string-literal
union whose values flow unmodified into `/api/team-insights` JSON, the
`/team/export` CSV, and the projection types published in the npm package —
all named in [sharing-server/AGENTS.md](../../sharing-server/AGENTS.md).
`teamPage.ts` also compares against the label by identity to render the "You"
pill.

Translate these at the **render boundary only**. Never at the data layer: doing
so breaks the published contract, every downstream importer, and that pill.
The same rule applies to any future value that is simultaneously a display label
and a data key — `taskClassification.ts`'s 12 category labels double as object
keys in `usageAnalysis.ts` and need a key→label split before they can move.

### S7 — validators recognize every call shape and every root

`scripts/validate-localization.js` extracts used keys with the regex
`\bl10n\.t\(` and scans only `vscode-extension/src`. It therefore cannot see
`ctx.translate('insight.x.title')`, `localize()`/`localizeFormat()` call sites,
or anything in `cli/`, `desktop/` or `sharing-server/`. It is currently blind to
all 179 keys added for the insights catalog — those are covered by
`l10n.test.ts` instead, but the blind spot widens with every tier-2 module
adopted.

It also only validates one direction (referenced ⇒ defined), never the reverse,
so an orphaned key is invisible.

## Sequencing

Ordered by value ÷ effort, not by tier.

| # | Change | Effort | Why first |
|---|---|---|---|
| 1 | Test asserting `DEFAULT_LOCALIZATION` ≡ `package.nls.json` | ~10 lines | Locks an invariant that currently holds by luck. Shipped with this ADR. |
| 2 | Extract the payload helper; call it from desktop, JetBrains, VS | ~3 lines/host | **Biggest win in the audit.** Gives ~11 views the zh-CN they already have. |
| 3 | Teach `validate-localization.js` the new call shapes + roots | small | Everything after this is unguarded without it. |
| 4 | Generate `DEFAULT_LOCALIZATION` + interface + dictionary from the bundle | medium | Collapses the 5-edit ritual to 2 and makes #1 unnecessary. |
| 5 | Adopt injected `Translate` in tier-2 modules, ranked below | large | The bulk of the remaining text. |
| 6 | Single `locale` payload field; ban bare `toLocale*()` | medium | Fixes visible mixed-locale output. |

### Tier-2 adoption order

Ranked by prose volume × visibility, with the blocker noted:

1. `src/maturityScoring.ts` — ~110 strings plus its 166-string
   `fluencyLevelData.json`. Largest prose surface in the repo, CLI-shared, so
   `vscode` is impossible.
2. `vscode-extension/src/backend/ui/messages.ts` — ~58, and it has **no imports
   at all**; it is the shared funnel for four other backend modules, so one
   injection covers all of them.
3. `src/efficiencyAnalysis.ts` — ~60; the 22 metric label+explanation pairs are
   the Efficiency view's entire vocabulary.
4. `vscode-extension/src/whatsNew/catalog.ts` — 27, and the only module whose
   prose reaches both a toast and a webview. Smallest high-visibility win.
5. `src/correctionDetection.ts` — 24 display chips sitting next to regexes,
   easy to mistake for machine values.
6. `vscode-extension/src/backend/configurationFlow.ts` — ~22 privacy badges and
   consent-modal copy. Wrong-language consent text is the worst failure mode in
   this list.
7. `vscode-extension/src/loadingHtml.ts` — 19, shared with the desktop app so it
   can never import `vscode`. Must be done together with `generateLoadingSvg`
   in `extension.ts`, which duplicates the same strings.
8. `src/darkFactorySignals.ts` + `src/darkFactoryReadiness.ts` — ~32 plus 93 in
   JSON, including a legal-ish disclaimer banner.
9. `src/chartDataBuilder.ts` — ~14, plus `toLocaleDateString('en-US')` sites
   that pin axis month labels to English regardless of locale.
10. `src/taskClassification.ts` — 12, blocked on the key→label split in S6.

### Known blockers

- **~250 strings inside inline `<script>` blocks** in `backend/configPanel.ts`
  and `backend/teamServerConfigPanel.ts` execute in the browser context, where
  `t()` does not exist. They need build-time interpolation or a message-passed
  bundle — neither tier-1 nor tier-3 as currently built.
- **`omp-segment/`** is PowerShell + JSON with no Node build and cannot reach any
  JS mechanism. It has exactly two translatable strings; leave them English.
- **`cli/src/commands/segment.ts`** caches a pre-rendered string with no locale
  field, so a locale change would serve stale-language output for up to the TTL.
  Adding `locale` to the cache shape is a prerequisite for localizing it.
- **Bundle size**: the two nls files inline to ~126 KB. Acceptable for the
  extension; the CLI ships as an npm package and a single-file SEA executable,
  so a per-locale split becomes attractive beyond zh-CN.

## Non-goals

- Translating beyond English + Simplified Chinese. `plural()` handles only
  one/other; a locale with richer plural categories needs `Intl.PluralRules`
  and extra bundle forms, deliberately not built until a bundle needs it.
- Localizing tier-4 IDE chrome through the shared bundle. Use the platform's
  own mechanism there.
- Localizing `--json` CLI output. It is machine-readable; every CLI command
  already branches on `shouldOutputJson`, which makes the localizable set
  exactly the non-JSON branches.

## Current state, measured

| Area | Hardcoded user-facing strings | Localized |
|---|---:|---:|
| `package.nls.json` / `.zh-cn.json` | — | 528 keys each |
| Webview bundles | ~1,486 occurrences (baseline) | 147 keys |
| `extension.ts` | 160 | ~246 `t()` call sites |
| `vscode-extension/src/backend/**` | ~591 | 0 |
| Repo-root `src/**/*.ts` | ~363 | 0 (except `insightsEngine.ts`) |
| Repo-root `src/*.json` data | 1,666 (1,291 excluded by S5) | 0 |
| `cli/` | ~200–250 | 0 |
| `desktop/` shell | ~25–30 | 0 |
| `sharing-server/` | ~180–220 | 0 |
| JetBrains / Visual Studio chrome | present, uncounted | 0 |

`t()` is imported by **exactly one file** in the entire host layer
(`extension.ts`). Webview hardcoded-to-localized runs about **9:1**, and two
files — `webview/usage/main.ts` and `webview/diagnostics/main.ts` — carry 53%
of it, so any mechanism that does not make those two cheap to convert will not
move the number.
