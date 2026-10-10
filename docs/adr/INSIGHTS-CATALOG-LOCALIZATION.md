# Localizing the personalized Insights catalog

Issue [#2081](https://github.com/rajbos/ai-engineering-fluency/issues/2081).

## The problem

`vscode-extension/src/insightsEngine.ts` had **zero** `t()` / `localize()` calls.
Every title, body sentence and action label across its 53-entry
`INSIGHT_CATALOG` was hardcoded English by construction — not by oversight in
any one PR. Localizing a single new label would have manufactured one
inconsistency to paper over another, so the whole class was fixed at once.

Two things made this harder than the webview strings localized before it:

1. **The module is deliberately pure.** Its own header comment commits it to
   having no `vscode` import, so it can be unit-tested against plain mocked
   data. But `l10n.ts`'s `t()` needs `vscode.env.language` and
   `vscode.l10n.t()`, so importing it would have ended that purity and broken
   the existing test setup.
2. **The strings are sentences, not labels.** Bodies are built from live data
   with English grammar baked into the template logic —
   `${count} workspace${count > 1 ? 's' : ''} ... ${count > 1 ? "don't" : "doesn't"} have`.
   Pluralization, verb agreement and clause order don't carry across locales.

## What the repo already did elsewhere

Worth stating, because it shaped the choice:

- **Extension host.** `extension.ts` is the *only* file that imports `t()`.
  Every other module in `src/` is unlocalized, so `insightsEngine.ts` was the
  norm, not an outlier.
- **Webviews.** Webview code also cannot import `vscode` — the same constraint.
  The repo solved it by *injecting the strings*: `extension.ts` builds a flat
  `Record<string, string>` of locale-resolved templates (placeholders left as
  `{0}`), ships it in the initial payload, and
  `src/webview/shared/localization.ts` resolves it with
  `localize()` / `localizeFormat(key, ...args)`.

So the precedent for "localize a module that can't import `vscode`" existed
already, and it was dictionary injection.

## Decision

Reuse the existing mechanism rather than invent a third one.

1. **Split `l10n.ts`.** The only parts needing `vscode` are the
   `vscode.l10n.t()` precedence check and `vscode.env.language`. Bundle lookup
   and `{0}` substitution need neither. Those moved to a new, `vscode`-free
   **`src/l10nCore.ts`**; `l10n.ts` is now a thin wrapper over it with no
   behaviour change.
2. **Inject a translator.** `InsightContext` gained a required
   `translate: Translate` field. `extension.ts` passes the real `t()`; tests
   pass `createTranslator('en' | 'zh-cn')`. `insightsEngine.ts` still imports no
   `vscode`.
3. **Keys, not prose, in the catalog.** `title` → `titleKey`, `actionLabel` →
   `actionLabelKey` / `buildActionLabel`. The `Key` suffix is what keeps these
   visibly distinct from the adjacent `actionCommand` fields, which hold VS Code
   command ids and must never be translated.
4. **A key per grammatical variant.** No `?  's' : ''` ternaries and no
   sentences assembled from translated fragments glued with literal English.
   `plural()` picks `.one` / `.other`; the two insights whose sentences vary on
   *two* independent counts get a key per combination
   (`.oneSession.otherEvents`). Whole sentences live in the bundle with `{0}`
   placeholders so a translator can reorder clauses — several zh-CN strings do.

### Why not the alternatives

- **Route insight keys through the webview dictionary.** Closest to the existing
  pattern, but that dictionary is a hand-maintained allowlist inside
  `getWebviewLocalization()` in `extension.ts` — a file already carrying the
  `max-lines` exception at ~12k lines. Adding ~180 keys there is the wrong
  place for them.
- **Return `{ key, params }` tuples and resolve at the render boundary.** Fully
  decouples the module, but many `buildBody` functions concatenate several
  conditional sentences, so each would have to return an *array* of segments
  rather than one tuple — a much larger refactor of all 53 entries plus
  `extension.ts` and the webview, for no additional capability.
- **Localize incrementally as entries are touched.** Lowest effort, but leaves
  the "some localized, most not" inconsistency in place indefinitely, which is
  the exact thing the issue was filed to end.

## `plural()` only handles one/other

English and zh-CN are the shipped bundles, and neither needs more. A locale with
richer plural categories (Polish, Arabic, Russian) would need `plural()` to
consult `Intl.PluralRules` and the bundle to carry the extra forms. That is
deliberately not built until a bundle actually needs it, rather than guessed at
now.

## `onboarding.ts` needed nothing

The issue assumed `src/onboarding.ts` had the same gap. It does not: the file is
35 lines and contains no user-facing strings at all — just
`determineOnboardingAction()` returning `'none' | 'welcome' | 'diagnostics'`.
Closed as not-applicable, not deferred.

## Enforcement

`vscode-extension/scripts/check-hardcoded-strings.mjs` gained
`scanInsightCatalog()`, a rule scoped to `INSIGHT_CATALOG`. The file renders no
HTML, so none of that script's DOM/markup sinks could ever see its strings — it
needed a rule of its own, not another path in the existing scan. Run against the
pre-refactor catalog the rule reports **360** violations; after it, zero, so the
file enters the ratchet with a clean slate and no baseline entries.

The `scan-hardcoded-strings` **skill** was deliberately left alone. It is a
separate ~1140-line regex-based inventory tool that produces a human triage
report and never fails the build. Porting this rule into it would mean a second
independent implementation for no added coverage, since the CI ratchet already
blocks regressions harder than an informational report surfaces them. Revisit if
the two tools are ever consolidated.

## Test coverage

Per `AGENTS.md`'s "Localization changes require test coverage" rule, but
table-driven rather than one assertion per key — there are ~180:

- Every catalog `titleKey` / `actionLabelKey` / `secondaryActionLabelKey`
  resolves in English **and** zh-CN.
- Every `insight.*` key has a zh-CN translation that does not fall back to
  English.
- zh-CN templates use exactly the English placeholder *set* — order may differ
  (several deliberately reorder clauses), but a missing index silently drops a
  live number and an extra one renders a literal `{3}`.
- No orphaned keys: every bundle key is referenced by the engine.
- **End-to-end:** insights are evaluated against
  `test/unit/fixtures/insightContexts.ts` in both locales and asserted never to
  emit a raw `insight.` key — the failure mode the per-key tests cannot catch,
  because `t()` falls back to returning the key itself rather than throwing.
- The fixtures are themselves asserted to fire **all 53** insights, so an
  insight added without a fixture fails instead of quietly shrinking the
  end-to-end test's reach.

## Verification

`npm test`, `check-types`, `lint:l10n`, `validate:l10n`, `lint:json`,
`lint:hardcoded-strings`, `check:contract` and `check:interaction` all pass.
`npm run visual:diff` reports **0 changed / 38 unchanged**, including
`usage--insights` — the English text is byte-identical to before, which is the
correct outcome for this refactor.
