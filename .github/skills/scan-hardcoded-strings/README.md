---
title: Scan Hardcoded Strings Skill
description: Inventory hardcoded (non-localized) UI text across the webview sources and extension.ts
lastUpdated: 2026-09-12
---

# Scan Hardcoded Strings Skill

A dependency-free Node script that scans the VS Code extension's webview UI
code for string/template literals that render as UI text but are **not**
wrapped in `localize()`, `localizeFormat()`, `t()`, or `vscode.l10n.t()`. It produces a
human-triageable inventory — it is **informational only** and never fails a
build.

This complements (does not replace) the existing localization checks:

- `scripts/validate-localization.js` (`npm --prefix vscode-extension run lint:l10n`,
  wired into CI) and `vscode-extension/scripts/validate-l10n.mjs`
  (`npm --prefix vscode-extension run validate:l10n`) check
  *consistency* of strings that already go through the localization system
  (e.g. every key used in source has a translation, translations stay in
  sync). They do not detect a plain string literal baked directly into UI
  code that never calls `localize(`/`t(`/`vscode.l10n.t(` at all.
- This skill fills that gap: it finds candidate strings that were never
  routed through localization in the first place.

## Files in This Directory

- **SKILL.md** — Main skill file with YAML frontmatter and instructions for the agent
- **scan-hardcoded-strings.js** — Node.js script that performs the scan
- **scan-hardcoded-strings.test.js** — Unit tests for the detection helpers
- **README.md** — This file

## Running the Tests

```bash
node --test .github/skills/scan-hardcoded-strings/scan-hardcoded-strings.test.js
```

Covers the localization-call stripper, the interpolation stripper (including
ternary-literal recovery), the prose heuristic's exclusion rules, each
detector (including the shared DOM-helper call detector and its argument
parser), the `extension.ts` method-range restriction, block-comment masking,
markdown report generation, the `runMain()` error-handling contract, and two
CLI smoke tests that invoke the script itself (normal and `--json` modes) to
exercise the executable path the pure-helper tests don't reach.

## Quick Usage

```bash
node .github/skills/scan-hardcoded-strings/scan-hardcoded-strings.js

# Machine-readable JSON
node .github/skills/scan-hardcoded-strings/scan-hardcoded-strings.js --json

# Write the report somewhere other than the default (git-ignored) hardcoded-strings-report.md
# (the CLI smoke tests in scan-hardcoded-strings.test.js use this to keep
# scratch output out of the repo root)
node .github/skills/scan-hardcoded-strings/scan-hardcoded-strings.js --out /tmp/scratch-report.md
```

The script scans:
- `vscode-extension/src/webview/**/*.ts` (excluding `*.test.ts`)
- `vscode-extension/src/extension.ts` (the `get*Html` methods that build webview HTML)

and writes a report to the git-ignored `hardcoded-strings-report.md` at the repo root, in
addition to printing a console summary grouped by file.

## What counts as a "UI-rendering position"

- Assignment to `.textContent`, `.innerText`, `.innerHTML`, `.title`, or
  `.placeholder` where the right-hand side is a direct string/template
  literal, **or** a conditional expression whose branches are literals (e.g.
  `otherTr.title = expanded ? 'Collapse other editors' : 'Expand other
  editors';`)
- `aria-label="..."`, `title="..."`, and `placeholder="..."` HTML attributes
  (not to be confused with the `.title =` / `.placeholder =` JS property
  assignments above — those are matched separately so the same occurrence
  isn't reported twice)
- The same three attribute names set via a literal
  `el.setAttribute('title', '...')` call
- A literal argument to `document.createTextNode('...')`
- Text content inside common UI-bearing HTML tags embedded in template
  literals: `<div>`, `<button>`, `<vscode-button>`, `<label>`, `<h1>`–`<h6>`,
  `<p>`, `<span>`, `<td>`, `<th>`, `<option>`, `<summary>`, `<caption>`,
  `<li>`, `<title>`, and SVG's `<text>` (used for chart labels, e.g. the
  efficiency chart's axis titles) — tolerating simple nested inline tags
  (`<a>`, `<strong>`, `<em>`, `<code>`, `<b>`, `<i>`, `<u>`, `<span>`) so
  prose broken up by an inline link, emphasis, or a trailing badge/counter
  (`<span class="hidden-count">(3)</span>`) is still read as one block
  instead of being skipped, and void/structural tags (`<input>`, `<br>`,
  `<hr>`, `<img>`, etc.) that never need a closing tag. Those inline tags are
  also matched as a literal's *root* tag (not only nested), so e.g.
  `el.innerHTML = '<strong>Save changes</strong>'` is still found even though
  `.innerHTML` assignments containing markup otherwise defer entirely to
  this detector
- A string/template literal passed as the UI-text argument to a known shared
  DOM helper (`el(tag, className, text)`, `iconHeading(tag, icon, text,
  className)`, `createButton(id, label, appearance)` from
  `vscode-extension/src/webview/shared/domUtils.ts`) — these helpers set
  `.textContent` internally, so a call site like `el('button', 'my-btn',
  'Take me there')` never appears as a `.textContent = ` assignment and would
  otherwise be invisible to this scan (500+ call sites use these helpers).
  The text argument may also be several literals joined by `+` (e.g. `` el('div',
  'intro', `The last ${n} releases. ` + 'more text.') ``) — each piece is
  recognized and their static text is joined, rather than requiring the whole
  argument to be a single literal — or a top-level ternary or `??`/`||`
  fallback whose branches are (recursively) literals or `+`-concatenations of
  literals, e.g. `serverUrl ? \`Loading data from ${serverUrl}...\` : "Loading
  data..."` or `KIND_LABEL[feature.kind] ?? 'New'`; every resolvable branch's
  static text is combined into one finding

`extension.ts` is scanned only within its `get*Html(...)` method bodies
(`getDetailsHtml`, `getLoadingHtmlCssBase`, etc.) — not the whole 13k-line
file — so unrelated string literals elsewhere (GitHub issue Markdown
templates, VS Code panel titles, log messages) are not misreported as
webview UI text.

A candidate string must also contain a run of 2+ letters and pass a "looks
like prose" filter that excludes:
- Pure numbers/symbols/emoji with no letters (the letter check is
  Unicode-aware, so non-English text such as Chinese or Cyrillic is still
  treated as prose, not silently exempted for being outside A-Z)
- URLs (`http(s)://`, `www.`)
- CSS values: hex colors (`#fff`), units (`12px`, `1.5rem`), and CSS
  functions (`rgba(...)`, `calc(...)`, `var(...)`, etc.)
- A narrow denylist of single lowercase/hyphenated tokens known to be CSS
  keywords or state flags (e.g. `active`, `flex`, `hidden`, `disabled`) —
  **not** a blanket rule against every single lowercase word, since a
  genuine one-word label like `tie` or `open` is exactly the kind of string
  this scan exists to catch

Anything already wrapped in a `localize(...)`, `localizeFormat(...)`, `t(...)`,
or `vscode.l10n.t(...)` call — including inside a template-literal interpolation like
`` `${localize('key')}` `` — is stripped out before the prose check runs, so
already-localized text is not flagged. Conversely, a string literal that is
itself a whole ternary branch inside an interpolation's expression — e.g.
`` `${flag ? 'Enable Overrides' : 'Disable Overrides'}` `` — or the fallback
side of a `||` default — e.g. `` `${escapeHtml(msg) || '<em>No message</em>'}` ``
or `` `${escapeHtml(err || "Unknown error")}` `` — is preserved and checked,
since that is often where the actual hardcoded UI text lives. A *plain*
single/double-quoted literal only counts as a branch this way when it's
immediately preceded by `?`, `:`, or `||` (ignoring whitespace); one that is
merely an argument to some other call inside the same interpolation — e.g.
`` `${buttonHtml('btn-refresh')}` `` — is left alone, since `'btn-refresh'`
there is a button id, not UI text, and follows `(` rather than `?`/`:`/`||`.
The same rule is what keeps a comparison operand like `` `${typeof x ===
'string' ? x : ''}` `` from being misread as a branch. A **template**
(backtick-quoted) literal, however, is recovered regardless of what precedes
it — e.g. `` `${escapeHtml(`${p.kind} · ${p.model} AIU`)}` `` still surfaces
"AIU" even though the nested template is a plain argument to `escapeHtml(`,
not a ternary/`||` branch — because in this codebase a template literal is
used to *build* display text, unlike a plain quoted string which is
routinely a lookup key or id. Each recovered literal is prose-checked on its
own before being combined, so one non-prose branch (e.g. a URL) can't poison
another genuine one — `` `${cond ? 'https://x' : 'Open link'}` `` still
surfaces "Open link".
Similarly, tag delimiters left behind by a stripped interpolation (e.g.
`<strong></strong>` after `<strong>${count}</strong>` loses its dynamic
content) are removed before the prose check, so a tag *name* like "strong" is
never itself mistaken for hardcoded text. HTML character references
(`&middot;`, `&amp;`, `&#8226;`, `&#x2022;`) are stripped the same way — a
separator like `` `${a} &middot; ${b}` `` reduces, once both interpolations
are gone, to just `&middot;`, and without this step the entity *name*
("middot") would itself be misread as a prose word.

A `.title`/`.textContent`/etc. template-literal assignment is matched with
the same nested-template-aware scan (`skipQuotedLiteral`) described below, so
`` el.title = `${format(`Save changes`)}`; `` isn't truncated at the nested
literal's opening backtick. A conditional (ternary) assignment's
statement-terminating `;` is found the same quote-aware way, so a `;`
*inside* a literal branch — e.g. `` el.title = cond ? 'Save; changes' :
'Cancel'; `` — doesn't end the statement early and truncate both branches.

Before any detector runs, `/* ... */` block comments (including JSDoc) are
blanked out — a doc-comment example like `Converts [text](url) to <a
href="url">text</a>` is not real UI markup and would otherwise be
misreported. `//` line comments are deliberately left alone, since stripping
from the first `//` to end-of-line risks truncating a genuine line that
happens to contain a URL. The masking (and every other balanced-bracket or
argument-splitting scan in the script — matching a call's closing paren, a
method's closing brace, splitting a call's arguments on top-level commas,
splitting a `+`-concatenation) shares one quote/template-aware primitive
(`skipQuotedLiteral`), so a UI string that itself contains `(`, `)`, `,`,
`+`, or a literal `/* ... */`-looking sequence doesn't confuse the scan.
That primitive is also regex-literal-aware (`.replace(/"/g, ...)` doesn't
get misread as opening an unterminated string, though this check lives in
the comment-masking tokenizer specifically, not `skipQuotedLiteral` itself)
and correctly handles a *nested* template literal inside a `${...}`
interpolation — `` `...${fn(`${x} y`)}...` ``, or a helper call like
`el('div', '', `outer ${fn(`inner`)}`)`, both common in this
HTML-templating codebase — rather than treating the first inner backtick as
closing the outer one. Left unfixed, that bug silently disabled comment
masking for the rest of a file, or undercounted a call's real closing paren
(truncating its argument list) or an argument split (misreading a comma or
`+` inside the nested literal as top-level), from that point on.

This is a **line/regex-based scan**, not an AST parse — by design, since this
is a triage report rather than a hard CI gate (a stricter, ratcheted AST-based
gate for *new* violations may exist as a separate effort). Expect the
occasional false positive or missed case with unusual formatting; use
judgement when triaging.

## Interpreting Output

Each finding shows:
- **File** — grouped heading in both console and markdown output
- **Line** — 1-based line number where the match starts
- **Kind** — which detector matched (`.textContent assignment`, `aria-label
  attribute`, `<button> content`, etc.)
- **Snippet** — a whitespace-collapsed, truncated excerpt of the offending
  code

The script always exits `0`, even if an unexpected error occurs partway
through (it is caught, logged to stderr, and does not change the exit code).
Nothing is auto-fixed.

## After Reviewing Findings

1. For a genuine hardcoded string:
   - Extension-host code (via `t()`): add the key to
     `vscode-extension/package.nls.json` (+ `package.nls.zh-cn.json` where
     translated).
   - Webview code (via `localize()`): add the key **and its English text** to
     `DEFAULT_LOCALIZATION` in
     `vscode-extension/src/webview/shared/localization.ts` — this is only the
     fallback used when no override arrives — **and** also add the key to
     `getWebviewLocalization()` in `vscode-extension/src/extension.ts` (via
     `l10n.t('key')`) plus `package.nls.json` / `package.nls.zh-cn.json`.
     Skipping the `getWebviewLocalization()` step means the webview always
     falls back to the English `DEFAULT_LOCALIZATION` text, even for
     non-English users.
   Then reference the key from the flagged call site.
2. Follow "Localization changes require test coverage" in the repo's
   `AGENTS.md` — add coverage in `vscode-extension/test/unit/l10n.test.ts` for
   any new key.
3. Re-run this script to confirm the finding is gone, then re-run
   `npm --prefix vscode-extension run lint:l10n` /
   `npm --prefix vscode-extension run validate:l10n` to confirm consistency
   (both scripts are defined in `vscode-extension/package.json`, not the
   repo root).
4. For a false positive, no action is needed — this script has no baseline or
   suppression mechanism; just use judgement on each report.
