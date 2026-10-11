#!/usr/bin/env node

/**
 * Hardcoded UI String Inventory Scan
 *
 * Walks vscode-extension/src/webview/**\/*.ts and the get*Html()-named methods
 * in vscode-extension/src/extension.ts (the webview-HTML-producing code) looking
 * for string/template literals that are rendered directly as UI text but are NOT
 * wrapped in localize(), t(), localizeFormat(), or vscode.l10n.t(). This is a
 * triage/inventory report, not a CI gate: it never exits non-zero and does not
 * modify any source file.
 *
 * UI-rendering positions checked:
 *   - Assignment to .textContent / .innerText / .innerHTML / .title / .placeholder
 *   - aria-label="..." / title="..." / placeholder="..." HTML attributes
 *   - Text content inside common HTML tags embedded in template literals
 *     (<div>, <button>, <label>, <h1>-<h6>, <p>, <span>, <td>, <th>, <option>,
 *     <summary>, <caption>), tolerating simple nested inline tags
 *     (<a>, <strong>, <em>, <code>, <b>, <i>, <u>)
 *
 * Usage:
 *   node .github/skills/scan-hardcoded-strings/scan-hardcoded-strings.js
 *   node .github/skills/scan-hardcoded-strings/scan-hardcoded-strings.js --json
 *
 * Output:
 *   - Console report grouped by file, with line numbers and snippets
 *   - Markdown report written to <repoRoot>/hardcoded-strings-report.md
 *
 * Exit codes:
 *   0 — always (informational script; never fails the build)
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ── Configuration ──────────────────────────────────────────────────────────

const REPO_ROOT = path.join(__dirname, '../../..');
const WEBVIEW_DIR = path.join(REPO_ROOT, 'vscode-extension/src/webview');
const EXTENSION_FILE = path.join(REPO_ROOT, 'vscode-extension/src/extension.ts');
const REPORT_PATH = path.join(REPO_ROOT, 'hardcoded-strings-report.md');

const TAG_NAMES = ['div', 'button', 'vscode-button', 'label', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'span', 'td', 'th', 'option', 'summary', 'caption', 'li', 'title', 'text'];
const TEXT_PROPS = ['textContent', 'innerText', 'innerHTML', 'title', 'placeholder'];

// ── File collection ────────────────────────────────────────────────────────

/** Recursively collect *.ts files under a directory, excluding *.test.ts. */
function collectTsFiles(dir) {
    const results = [];
    if (!fs.existsSync(dir)) { return results; }
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            results.push(...collectTsFiles(full));
        } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
            results.push(full);
        }
    }
    return results;
}

// ── Shared quote/bracket matching ───────────────────────────────────────────

/**
 * Given `content[start]` is the opening `"`, `'`, or `` ` `` of a string or
 * template literal, return the index just past its matching closer. For a
 * plain quote this is just the next unescaped occurrence of the same quote
 * character. For a template literal, a `${...}` interpolation is real code —
 * it can contain its own nested string/template literals (e.g. `` `outer
 * ${fn(`inner`)}` ``, common in this HTML-templating codebase) — so this
 * recurses into any quote found inside an interpolation and tracks the
 * interpolation's own `{`/`}` nesting (an object literal like `${ {a:1} }`)
 * to find *its* closing `}` correctly, rather than treating the literal's
 * first backtick or brace as the end. Returns `content.length` if the
 * literal is unterminated.
 */
function skipQuotedLiteral(content, start) {
    const quote = content[start];
    let i = start + 1;
    if (quote !== '`') {
        for (; i < content.length; i++) {
            if (content[i] === '\\') { i++; continue; }
            if (content[i] === quote) { return i + 1; }
        }
        return i;
    }
    for (; i < content.length; i++) {
        const c = content[i];
        if (c === '\\') { i++; continue; }
        if (c === '`') { return i + 1; }
        if (c === '$' && content[i + 1] === '{') {
            i += 2;
            let depth = 0;
            for (; i < content.length; i++) {
                const cc = content[i];
                if (cc === '"' || cc === "'" || cc === '`') { i = skipQuotedLiteral(content, i) - 1; continue; }
                if (cc === '{') { depth++; continue; }
                if (cc === '}') {
                    if (depth === 0) { break; }
                    depth--;
                    continue;
                }
            }
            continue;
        }
    }
    return i;
}

/**
 * Scan forward from `start` (which must point at `openChar`) and return the
 * index of its matching `closeChar`, treating quoted strings/template
 * literals (via `skipQuotedLiteral`, so a nested template's own bracket
 * characters are skipped too) as opaque so a stray bracket inside a UI
 * string's text (e.g. `el('span', 'label', 'What does this (mean?')`)
 * doesn't confuse the depth count. Returns -1 if no match is found before
 * the end of input.
 */
function findMatchingBracket(content, start, openChar, closeChar) {
    let depth = 0;
    for (let i = start; i < content.length; i++) {
        const c = content[i];
        if (c === '"' || c === "'" || c === '`') { i = skipQuotedLiteral(content, i) - 1; continue; }
        if (c === openChar) { depth++; }
        else if (c === closeChar) {
            depth--;
            if (depth === 0) { return i; }
        }
    }
    return -1;
}

// ── extension.ts scope restriction ──────────────────────────────────────────

/**
 * Find the [start, end] character ranges of every `get*Html*(...) { ... }`
 * method body in `content` — the webview-HTML-producing methods (getDetailsHtml,
 * getLoadingHtmlCssBase, etc.), mirroring the canonical list in this repo's
 * AGENTS.md. Scanning is restricted to these ranges for extension.ts so that
 * unrelated string literals elsewhere in the 13k-line file (e.g. GitHub issue
 * Markdown templates) are not misreported as webview UI text.
 *
 * A declaration is recognized by requiring the method name to start the
 * statement (only whitespace and an optional access modifier before it) —
 * this excludes call sites like `this.getLoadingHtmlCssBase()` embedded
 * mid-line inside another method's template literal.
 */
function extractHtmlMethodRanges(content) {
    const ranges = [];
    const declRe = /^[ \t]*(?:private|public|protected)?\s*(?:async\s+)?(get[A-Za-z]*Html[A-Za-z]*)\s*\(/gm;
    let m;
    while ((m = declRe.exec(content)) !== null) {
        const parenStart = m.index + m[0].length - 1;
        const parenEnd = findMatchingBracket(content, parenStart, '(', ')');
        if (parenEnd === -1) { continue; }

        const braceStart = content.indexOf('{', parenEnd);
        if (braceStart === -1) { continue; }
        // A `;` between the parameter list and the brace means this is a type
        // signature (e.g. an interface member), not a method implementation.
        if (content.slice(parenEnd + 1, braceStart).includes(';')) { continue; }

        const braceEnd = findMatchingBracket(content, braceStart, '{', '}');
        if (braceEnd === -1) { continue; }

        ranges.push([braceStart, braceEnd]);
        declRe.lastIndex = braceEnd;
    }
    return ranges;
}

/** Does `index` fall inside any [start, end] range? */
function isWithinRanges(index, ranges) {
    return ranges.some(([start, end]) => index >= start && index <= end);
}

// ── Localization-call stripping ────────────────────────────────────────────

// Matches the opening of a localize(/localizeFormat(/t(/l10n.t(/vscode.l10n.t(
// call. `\b` before the bare `t(` alternative keeps it from matching inside
// identifiers like `getText(` or `format(` (no word boundary exists between
// "x" and "t" there). `localizeFormat` must come before `localize` in the
// alternation only for readability — regex alternation already requires the
// full alternative (including the trailing literal `(`) to match, so
// `localize(` alone can never partially match `localizeFormat(`.
const CALL_OPEN = /\b(?:vscode\.l10n\.t|l10n\.t|localizeFormat|localize|t)\(/;

/** Remove already-localized call expressions (with balanced parens) from text. */
function stripLocalizedCalls(text) {
    let result = text;
    for (let iter = 0; iter < 50; iter++) {
        const m = CALL_OPEN.exec(result);
        if (!m) { break; }
        const openIdx = m.index + m[0].length - 1;
        const end = findMatchingBracket(result, openIdx, '(', ')');
        if (end === -1) { break; }
        result = result.slice(0, m.index) + result.slice(end + 1);
    }
    return result;
}

// A literal is only treated as a conditional's UI text when it is itself the
// whole consequent/alternate of a ternary (immediately preceded by `?` or
// `:`) or the fallback side of a `||` default (`expr || 'Unknown error'`),
// ignoring whitespace. This is a positive allowlist rather than a denylist of
// specific "not a branch" contexts, so it excludes a comparison operand
// (`typeof x === 'string'` — `'string'` follows `===`, not `?`/`:`/`||`)
// *and* a literal argument buried inside some other call within the
// interpolation (`` `${buttonHtml('btn-refresh')}` `` — `'btn-refresh'`
// follows `(`) without needing a separate rule for each shape of "not
// actually a UI-text branch" expression.
const BRANCH_OR_FALLBACK_BEFORE_RE = /(?:[?:]|\|\|)\s*$/;

/**
 * Extract quoted string/template literal bodies (non-nested at the regex
 * level — a *nested* template literal, e.g. `` escapeHtml(`${a} · ${b} AIU`) ``,
 * has already had its own inner `${...}` interpolations reduced to plain
 * text by the time this runs, courtesy of `stripInterpolations`'s
 * inside-out iteration) that are either:
 * - themselves a conditional branch — both branches of a ternary like
 *   `` isExcluded ? `${provider} is hidden...` : `Click to hide ${provider}...` ``
 *   (a template-literal ternary, not just single/double-quoted branches), or
 *   the fallback side of a `||` default like `` escapeHtml(turn.userMessage) ||
 *   '<em>No message</em>' ``, or
 * - a template literal (backtick-quoted) anywhere in the expression, e.g. the
 *   sole argument to a pass-through display helper like `` escapeHtml(`${p.kind}
 *   · ${p.model} AIU`) ``. Unlike a single/double-quoted string — routinely
 *   used in this codebase as a lookup key or id (`buttonHtml('btn-refresh')`)
 *   — a backtick template literal is used here to *build* display text, so
 *   it's treated as UI-rendering regardless of what precedes it.
 * A single/double-quoted literal elsewhere in the expression (a function-call
 * argument, a comparison operand) is not a UI-rendering position on its own
 * and is left alone.
 */
function extractInterpolationLiterals(expr) {
    const stripped = stripLocalizedCalls(expr);
    const literals = [];
    const re = /(["'`])((?:(?!\1)[^\\]|\\.)*)\1/g;
    let m;
    while ((m = re.exec(stripped)) !== null) {
        const isTemplateLiteral = m[1] === '`';
        if (!isTemplateLiteral && !BRANCH_OR_FALLBACK_BEFORE_RE.test(stripped.slice(0, m.index))) { continue; }
        literals.push(m[2]);
    }
    return literals;
}

/**
 * Strip ${...} interpolations (non-nested assumption), keeping any string
 * literals found inside them (e.g. the branches of a ternary like
 * `${flag ? 'Enable Overrides' : 'Disable Overrides'}`) so that hardcoded
 * prose hidden inside an interpolation is not silently discarded.
 *
 * Each recovered literal is prose-checked *individually* before being kept:
 * joining every literal from an interpolation first and running one prose
 * check over the combined string would let a non-prose branch (e.g. a URL)
 * poison the whole result — `${cond ? 'https://x' : 'Open link'}` must not
 * lose "Open link" just because "https://x" fails the URL check when the two
 * are concatenated together.
 */
function stripInterpolations(text) {
    let result = text;
    for (let iter = 0; iter < 10; iter++) {
        const next = result.replace(/\$\{([^{}]*)\}/g, (_, expr) => {
            const literals = extractInterpolationLiterals(expr).filter((lit) => looksLikeProse(lit));
            return literals.length > 0 ? ` ${literals.join(' ')} ` : ' ';
        });
        if (next === result) { break; }
        result = next;
    }
    return result;
}

/**
 * Remove HTML tag delimiters (`<strong>`, `</a>`, etc.) while keeping any
 * text between them, so a tag whose only content was an interpolation —
 * e.g. `<strong>${count}</strong>` — doesn't leave its own tag *name*
 * ("strong") behind to be misread as hardcoded prose once the interpolation
 * itself has been blanked out.
 */
function stripHtmlTags(text) {
    return text.replace(/<\/?[a-zA-Z][^>]*>/g, ' ');
}

/**
 * Remove HTML character references (`&middot;`, `&amp;`, `&#8226;`,
 * `&#x2022;`) so an entity name isn't itself mistaken for a prose word —
 * e.g. a separator like `${a} &middot; ${b}` reducing, once both
 * interpolations are stripped, to just `&middot;` would otherwise pass the
 * "looks like prose" letter-run check on the word "middot".
 */
function stripHtmlEntities(text) {
    return text.replace(/&(#\d+|#x[0-9a-fA-F]+|[a-zA-Z]+);/g, ' ');
}

/** Reduce a raw literal body to its static (non-localized, non-interpolated) text. */
function extractStaticText(rawBody) {
    return stripHtmlEntities(stripHtmlTags(stripInterpolations(stripLocalizedCalls(rawBody))));
}

// ── Prose heuristic ─────────────────────────────────────────────────────────

const CSS_UNIT_RE = /^-?[\d.]+(px|em|rem|%|vh|vw|ms|s|deg|fr|ch|q)$/;
const HEX_COLOR_RE = /^#[0-9a-fA-F]{3,8}$/;
const CSS_FUNC_RE = /^(rgba?|hsla?|url|var|calc|linear-gradient|repeating-linear-gradient|translate[XYZ]?|rotate|scale)\(/;
const SINGLE_TOKEN_RE = /^[a-z][a-z0-9-]*$/;
// Single lowercase/hyphenated tokens that are near-certainly a CSS keyword or
// state flag rather than visible prose. Deliberately a narrow denylist, not a
// blanket "reject every single lowercase word" rule — this detector only ever
// sees rendered text/attribute values (class/id/style attributes are never
// scanned), so a genuine one-word label like "tie", "open", or "manage" must
// still be flagged as a candidate for localization.
const CSS_KEYWORD_TOKENS = new Set([
    'active', 'hidden', 'visible', 'collapsed', 'expanded', 'disabled', 'enabled', 'selected', 'checked',
    'flex', 'block', 'inline', 'inline-block', 'grid', 'table', 'none', 'contents',
    'absolute', 'relative', 'fixed', 'sticky', 'static',
    'left', 'right', 'center', 'top', 'bottom', 'auto', 'inherit', 'initial', 'unset',
    'bold', 'italic', 'underline', 'uppercase', 'lowercase', 'capitalize',
    'pointer', 'default', 'wrap', 'nowrap', 'row', 'column',
    'solid', 'dashed', 'dotted', 'transparent',
]);
const URL_RE = /^(https?:\/\/|www\.)/i;
// Unicode-aware: a run of 2+ letters in any script (not just ASCII), so
// hardcoded non-English UI text (Chinese, Japanese, Cyrillic, etc.) is not
// silently exempted just for being outside A-Z.
const LETTER_RUN_RE = /\p{L}{2,}/u;

/** Heuristic: does this static text look like UI prose that should be localized? */
function looksLikeProse(text) {
    const trimmed = text.trim();
    if (!trimmed) { return false; }
    if (!LETTER_RUN_RE.test(trimmed)) { return false; } // pure numbers/symbols/emoji
    if (URL_RE.test(trimmed)) { return false; }
    if (HEX_COLOR_RE.test(trimmed)) { return false; }
    if (CSS_UNIT_RE.test(trimmed)) { return false; }
    if (CSS_FUNC_RE.test(trimmed)) { return false; }
    if (SINGLE_TOKEN_RE.test(trimmed) && CSS_KEYWORD_TOKENS.has(trimmed.toLowerCase())) { return false; }
    return true;
}

/** 1-based line number of `index` within `content`. */
function lineAt(content, index) {
    return content.slice(0, index).split('\n').length;
}

/** Trim a snippet for display, collapsing whitespace/newlines. */
function toSnippet(text, max = 160) {
    const collapsed = text.replace(/\s+/g, ' ').trim();
    return collapsed.length > max ? collapsed.slice(0, max) + '…' : collapsed;
}

/**
 * Escape a value for safe embedding inside a markdown table cell wrapped in a
 * backtick code span. Backslashes are escaped first — escaping `|` alone
 * would let a snippet's own trailing backslash combine with the inserted
 * one and change its meaning. Backticks are neutralized too since a literal
 * one would otherwise close the surrounding code span early.
 */
function escapeTableCell(text) {
    return text
        .replace(/\\/g, '\\\\')
        .replace(/\|/g, '\\|')
        .replace(/`/g, "'");
}

// ── Detectors ───────────────────────────────────────────────────────────────
//
// Each detector returns findings with an `index` (character offset of the
// match) alongside `line`/`kind`/`snippet`, so callers can restrict results to
// a set of allowed ranges (see `extractHtmlMethodRanges`). `scanFile` strips
// `index` back out before returning.

/**
 * Detect assignments like `el.textContent = "..."` / `el.title = \`...\`` where
 * the right-hand side is a direct string/template literal (not a variable,
 * function call, or already-localized call).
 */
function findPropertyAssignments(content) {
    const findings = [];
    const propAlt = TEXT_PROPS.join('|');

    // Template-literal RHS (can span multiple lines). Uses skipQuotedLiteral
    // (rather than a `` `([^`]*)` `` regex) so a *nested* template literal
    // inside an interpolation — e.g. `` .title = `${format(`Save
    // changes`)}`; `` — doesn't truncate the match at the inner backtick.
    const templateStartRe = new RegExp('\\.(' + propAlt + ')\\s*=\\s*`', 'g');
    let m;
    while ((m = templateStartRe.exec(content)) !== null) {
        const prop = m[1];
        const backtickIdx = m.index + m[0].length - 1;
        const end = skipQuotedLiteral(content, backtickIdx);
        if (content[end - 1] !== '`') { continue; } // unterminated
        const body = content.slice(backtickIdx + 1, end - 1);
        if (prop === 'innerHTML' && body.includes('<')) { continue; } // deferred to tag-content scan
        const staticText = extractStaticText(body);
        if (looksLikeProse(staticText)) {
            findings.push({
                index: m.index,
                line: lineAt(content, m.index),
                kind: `.${prop} assignment`,
                snippet: toSnippet(content.slice(m.index, end)),
            });
        }
    }

    // Quoted-string RHS (single line only).
    const quotedRe = new RegExp('\\.(' + propAlt + ')\\s*=\\s*(["\'])((?:(?!\\2)[^\\\\\\n]|\\\\.)*)\\2', 'g');
    while ((m = quotedRe.exec(content)) !== null) {
        const [full, prop, , body] = m;
        if (prop === 'innerHTML' && body.includes('<')) { continue; }
        const staticText = extractStaticText(body);
        if (looksLikeProse(staticText)) {
            findings.push({
                index: m.index,
                line: lineAt(content, m.index),
                kind: `.${prop} assignment`,
                snippet: toSnippet(full),
            });
        }
    }

    // Conditional RHS (e.g. a ternary) whose branches are literals, such as
    // `otherTr.title = expanded ? 'Collapse other editors' : 'Expand other
    // editors';` — the negative lookahead excludes an RHS that starts with a
    // quote/backtick directly, since that's already covered by the two
    // detectors above; this only matches when the RHS is a real expression.
    // Spans up to the statement's terminating top-level `;` (found via a
    // quote/bracket-aware scan, not a `[^;]*?` regex, so a `;` inside a UI
    // string branch — e.g. `cond ? 'Save; changes' : 'Cancel';` — doesn't
    // end the statement early), which may be on a later line — a ternary is
    // often wrapped like
    //   card.title = isExcluded
    //       ? `${provider} is hidden...`
    //       : `Click to hide ${provider}...`;
    // The "does this start with a quote" check is done in plain JS rather
    // than a regex lookahead: a lookahead right after `\s*` can be defeated
    // by backtracking (`\s*` giving back the whitespace it matched so the
    // lookahead re-checks one position earlier, where the next character is
    // the whitespace itself, not the quote) — so a plain literal RHS
    // containing "?" was still matching here as a false "conditional"
    // duplicate of the literal detector above.
    const conditionalStartRe = new RegExp('\\.(' + propAlt + ')\\s*=(?!=)\\s*', 'g');
    while ((m = conditionalStartRe.exec(content)) !== null) {
        const prop = m[1];
        const exprStart = m.index + m[0].length;
        if (/^["'`]/.test(content.slice(exprStart))) { continue; } // RHS is a direct literal — already covered above

        let i = exprStart;
        let depth = 0;
        let end = -1;
        while (i < content.length) {
            const c = content[i];
            if (c === '"' || c === "'" || c === '`') { i = skipQuotedLiteral(content, i); continue; }
            if (c === '(' || c === '[' || c === '{') { depth++; i++; continue; }
            if (c === ')' || c === ']' || c === '}') { depth--; i++; continue; }
            if (c === ';' && depth === 0) { end = i; break; }
            i++;
        }
        if (end === -1) { continue; }

        const expr = content.slice(exprStart, end);
        if (!expr.includes('?')) { continue; } // not actually a conditional
        const literals = extractInterpolationLiterals(expr).filter((lit) => looksLikeProse(lit));
        if (literals.length > 0) {
            findings.push({
                index: m.index,
                line: lineAt(content, m.index),
                kind: `.${prop} assignment (conditional)`,
                snippet: toSnippet(content.slice(m.index, end + 1)),
            });
        }
    }

    return findings;
}

const HTML_ATTR_NAMES = ['aria-label', 'title', 'placeholder'];

/**
 * Detect `aria-label="..."` / `title="..."` / `placeholder="..."` HTML
 * attributes with hardcoded prose. HTML attributes in this codebase are
 * always written tight (`title="..."`, no spaces around `=`), so requiring
 * no whitespace around `=` distinguishes them from a JS statement like
 * `let title = 'Sessions';` or `const placeholder = ...` (which do use
 * spaces and are plain local variables, not markup). The negative lookbehind
 * also excludes a preceding `.` (so `panel.title = '...'` — a JS property
 * assignment, already covered by `findPropertyAssignments`) and preceding
 * word/hyphen characters (so `data-title=`/`subtitle=` don't match `title=`).
 */
function findHtmlAttributes(content) {
    const findings = [];
    const attrAlt = HTML_ATTR_NAMES.join('|');
    const re = new RegExp('(?<![.\\w-])(' + attrAlt + ')=(["\'])((?:(?!\\2)[^\\\\\\n]|\\\\.)*)\\2', 'g');
    let m;
    while ((m = re.exec(content)) !== null) {
        const [full, attr, , body] = m;
        const staticText = extractStaticText(body);
        if (looksLikeProse(staticText)) {
            findings.push({
                index: m.index,
                line: lineAt(content, m.index),
                kind: `${attr} attribute`,
                snippet: toSnippet(full),
            });
        }
    }
    return findings;
}

// Simple inline elements allowed to appear nested inside a scanned tag's
// content without stopping the match — e.g. `<div>Beta — please <a href="...">
// create an issue</a>.</div>` should still be read as one block of prose
// rather than being skipped because of the `<a>...</a>` in the middle.
// `span` is included since it's routinely used inline for a trailing badge
// or counter (e.g. `<label>...text<span class="hidden-count">(3)</span>
// </label>`) — without it, the body pattern can't get past the nested
// `<span>` and the whole outer match (and its real UI text) is missed.
const INLINE_PASSTHROUGH_TAGS = ['a', 'strong', 'em', 'code', 'b', 'i', 'u', 'span'];
// Void/self-closing structural elements: they never have a closing tag, so
// allowing them inline (without requiring a matching `</tag>`) keeps e.g. a
// `<label>` with a leading `<input>` or a `<div>` with `<br>` line breaks
// from being skipped just because the body pattern saw a `<` it didn't
// recognize.
const VOID_TAGS = ['input', 'br', 'hr', 'img', 'source', 'wbr', 'meta', 'link'];

/**
 * Detect hardcoded text content inside common UI-bearing HTML tags.
 *
 * The inline passthrough tags are also matched as top-level tags (not only
 * as nested content within e.g. a `<div>`), so a literal whose *root* is one
 * of them — `el.innerHTML = '<strong>Save changes</strong>'`, which
 * `findPropertyAssignments` defers here because it contains `<` — is still
 * found. This can occasionally double-report the same text once as part of
 * an outer tag's content and once as the inline tag's own standalone match;
 * for a triage report that overlap is preferable to missing the text.
 */
function findTagContent(content) {
    const findings = [];
    const inlineAlt = INLINE_PASSTHROUGH_TAGS.join('|');
    const voidAlt = VOID_TAGS.join('|');
    const tagAlt = [...TAG_NAMES, ...INLINE_PASSTHROUGH_TAGS].join('|');
    const bodyPattern = '(?:[^<]'
        + '|<(?:' + inlineAlt + ')(?:\\s[^>]*)?>'
        + '|</(?:' + inlineAlt + ')>'
        + '|<(?:' + voidAlt + ')(?:\\s[^>]*)?/?>'
        + ')*';
    const re = new RegExp('<(' + tagAlt + ')(?:\\s[^>]*)?>(' + bodyPattern + ')</\\1>', 'g');
    let m;
    while ((m = re.exec(content)) !== null) {
        const [full, tag, body] = m;
        const staticText = extractStaticText(body);
        if (looksLikeProse(staticText)) {
            findings.push({
                index: m.index,
                line: lineAt(content, m.index),
                kind: `<${tag}> content`,
                snippet: toSnippet(full),
            });
        }
    }
    return findings;
}

// Shared DOM helpers (vscode-extension/src/webview/shared/domUtils.ts) that
// take plain UI text as a positional argument and set it as textContent
// internally, rather than the caller ever writing `.textContent = ...`
// directly. Calls to these are otherwise invisible to this scanner even
// though they are one of the most common ways webview text is set (500+
// call sites). Value: 0-based index of the text argument in each call.
const HELPER_TEXT_ARG_INDEX = { el: 2, iconHeading: 2, createButton: 1 };

/**
 * Split a raw (unparenthesized) argument-list string on top-level commas,
 * treating a quoted literal (via `skipQuotedLiteral`, so a nested template
 * literal's own comma-like characters can't desync this) as one opaque unit.
 */
function splitTopLevelArgs(argsStr) {
    const parts = [];
    let depth = 0;
    let current = '';
    for (let i = 0; i < argsStr.length; i++) {
        const c = argsStr[i];
        if (c === '"' || c === "'" || c === '`') {
            const end = skipQuotedLiteral(argsStr, i);
            current += argsStr.slice(i, end);
            i = end - 1;
            continue;
        }
        if (c === '(' || c === '[' || c === '{') { depth++; current += c; continue; }
        if (c === ')' || c === ']' || c === '}') { depth--; current += c; continue; }
        if (c === ',' && depth === 0) { parts.push(current); current = ''; continue; }
        current += c;
    }
    if (current.trim() !== '' || parts.length > 0) { parts.push(current); }
    return parts.map((p) => p.trim());
}

/**
 * Split an argument expression on top-level `+` operators (outside any
 * quoted literal — via `skipQuotedLiteral`, nested-template-safe — or nested
 * bracket), so a concatenated literal argument like `` `The last ${n}
 * releases. ` + 'more text.' `` can be read as separate pieces.
 */
function splitTopLevelConcat(expr) {
    const parts = [];
    let depth = 0;
    let current = '';
    for (let i = 0; i < expr.length; i++) {
        const c = expr[i];
        if (c === '"' || c === "'" || c === '`') {
            const end = skipQuotedLiteral(expr, i);
            current += expr.slice(i, end);
            i = end - 1;
            continue;
        }
        if (c === '(' || c === '[' || c === '{') { depth++; current += c; continue; }
        if (c === ')' || c === ']' || c === '}') { depth--; current += c; continue; }
        if (c === '+' && depth === 0) { parts.push(current); current = ''; continue; }
        current += c;
    }
    parts.push(current);
    return parts.map((p) => p.trim());
}

/**
 * If `expr` is a top-level ternary (`cond ? a : b`), return its
 * `[consequent, alternate]` pieces; otherwise `null`. Only a top-level
 * `?`/`:` — outside quotes/brackets, and not part of `?.`/`??` — is
 * recognized, tracking nested ternaries' own `?`/`:` pairs so the split
 * point is the `:` that actually closes the *first* `?` (e.g. `a ? (b ? c :
 * d) : e` splits after the outer `:`, not the inner one).
 */
function splitTernary(expr) {
    let depth = 0;
    let pending = 0;
    let qIdx = -1;
    for (let i = 0; i < expr.length; i++) {
        const c = expr[i];
        if (c === '"' || c === "'" || c === '`') { i = skipQuotedLiteral(expr, i) - 1; continue; }
        if (c === '(' || c === '[' || c === '{') { depth++; continue; }
        if (c === ')' || c === ']' || c === '}') { depth--; continue; }
        if (depth !== 0) { continue; }
        if (c === '?') {
            if (expr[i + 1] === '.' || expr[i + 1] === '?') { i++; continue; } // ?. or ??
            if (qIdx === -1) { qIdx = i; }
            pending++;
            continue;
        }
        if (c === ':') {
            if (pending === 0) { continue; }
            pending--;
            if (pending === 0) { return [expr.slice(qIdx + 1, i), expr.slice(i + 1)]; }
        }
    }
    return null;
}

/**
 * If `expr` contains a top-level `??` (nullish coalescing) or `||`
 * (logical OR) — outside quotes/brackets — return `[left, right]` split on
 * the *first* such occurrence; otherwise `null`. Handles a fallback pattern
 * like `KIND_LABEL[feature.kind] ?? 'New'`, where the left side is a
 * dynamic lookup and the right side is the literal UI text shown when it
 * misses.
 */
function splitNullishOrOr(expr) {
    let depth = 0;
    for (let i = 0; i < expr.length; i++) {
        const c = expr[i];
        if (c === '"' || c === "'" || c === '`') { i = skipQuotedLiteral(expr, i) - 1; continue; }
        if (c === '(' || c === '[' || c === '{') { depth++; continue; }
        if (c === ')' || c === ']' || c === '}') { depth--; continue; }
        if (depth !== 0) { continue; }
        if ((c === '?' && expr[i + 1] === '?') || (c === '|' && expr[i + 1] === '|')) {
            return [expr.slice(0, i), expr.slice(i + 2)];
        }
    }
    return null;
}

/**
 * Resolve an argument expression to its combined static UI text when it is
 * made up entirely of string/template literals joined by `+` — e.g.
 * `` `The last ${n} releases. ` + 'more text.' ``, which the single-literal
 * pattern (`^(quote)...(same quote)$`) can't recognize since the two quote
 * characters at the start and end of the whole expression differ — or a
 * top-level ternary or `??`/`||` fallback whose branches are (recursively)
 * resolvable this way, e.g. `serverUrl ? \`Loading data from ${serverUrl}...\`
 * : "Loading data..."` or `KIND_LABEL[feature.kind] ?? 'New'`. Returns
 * `null` if a (non-conditional) expression's pieces aren't all direct
 * literals, or if every branch of a conditional resolves to nothing (a
 * variable/call there means the text isn't fully knowable statically, so
 * that piece is skipped rather than guessed at).
 */
function extractConcatenatedLiteralText(expr) {
    const ternary = splitTernary(expr);
    if (ternary) {
        const branchTexts = ternary
            .map((branch) => extractConcatenatedLiteralText(branch))
            .filter((text) => text !== null);
        return branchTexts.length > 0 ? branchTexts.join(' ') : null;
    }

    const nullishOrOr = splitNullishOrOr(expr);
    if (nullishOrOr) {
        const branchTexts = nullishOrOr
            .map((branch) => extractConcatenatedLiteralText(branch))
            .filter((text) => text !== null);
        return branchTexts.length > 0 ? branchTexts.join(' ') : null;
    }

    const pieces = splitTopLevelConcat(expr);
    const texts = [];
    for (const piece of pieces) {
        const litMatch = /^(["'`])([\s\S]*)\1$/.exec(piece);
        if (!litMatch) { return null; }
        texts.push(extractStaticText(litMatch[2]));
    }
    return texts.join(' ');
}

/**
 * Detect hardcoded text passed as a string/template literal to a known
 * shared UI-text helper (`el(tag, className, text)`, `iconHeading(tag, icon,
 * text, className)`, `createButton(id, label, appearance)`). Only bare calls
 * are matched (not `obj.el(...)`) to avoid colliding with an unrelated
 * same-named method on some other object.
 */
function findHelperCallText(content) {
    const findings = [];
    const nameAlt = Object.keys(HELPER_TEXT_ARG_INDEX).join('|');
    const re = new RegExp('\\b(' + nameAlt + ')\\(', 'g');
    let m;
    while ((m = re.exec(content)) !== null) {
        const name = m[1];
        if (content[m.index - 1] === '.') { continue; } // e.g. `this.el(...)`
        const openIdx = m.index + m[0].length - 1;
        const end = findMatchingBracket(content, openIdx, '(', ')');
        if (end === -1) { continue; }

        const args = splitTopLevelArgs(content.slice(openIdx + 1, end));
        const arg = args[HELPER_TEXT_ARG_INDEX[name]];
        if (!arg) { continue; }
        const staticText = extractConcatenatedLiteralText(arg);
        if (staticText === null) { continue; } // not a direct literal (or concatenation of literals) — skip

        if (looksLikeProse(staticText)) {
            findings.push({
                index: m.index,
                line: lineAt(content, m.index),
                kind: `${name}() text argument`,
                snippet: toSnippet(content.slice(m.index, end + 1)),
            });
        }
    }
    return findings;
}

/** Detect a hardcoded literal passed to `document.createTextNode(...)`. */
function findTextNodeCalls(content) {
    const findings = [];
    const re = /\bdocument\.createTextNode\(/g;
    let m;
    while ((m = re.exec(content)) !== null) {
        const openIdx = m.index + m[0].length - 1;
        const end = findMatchingBracket(content, openIdx, '(', ')');
        if (end === -1) { continue; }
        const arg = content.slice(openIdx + 1, end).trim();
        const litMatch = /^(["'`])([\s\S]*)\1$/.exec(arg);
        if (!litMatch) { continue; } // not a direct literal — skip
        const staticText = extractStaticText(litMatch[2]);
        if (looksLikeProse(staticText)) {
            findings.push({
                index: m.index,
                line: lineAt(content, m.index),
                kind: 'createTextNode() argument',
                snippet: toSnippet(content.slice(m.index, end + 1)),
            });
        }
    }
    return findings;
}

const SET_ATTRIBUTE_NAMES = ['aria-label', 'title', 'placeholder'];

/** Detect a hardcoded literal passed as the value to `.setAttribute('title'|'aria-label'|'placeholder', '...')`. */
function findSetAttributeCalls(content) {
    const findings = [];
    const attrAlt = SET_ATTRIBUTE_NAMES.join('|');
    const re = new RegExp('\\.setAttribute\\(\\s*([\'"])(' + attrAlt + ')\\1\\s*,\\s*', 'g');
    let m;
    while ((m = re.exec(content)) !== null) {
        const attr = m[2];
        const valueStart = m.index + m[0].length;
        const quoteChar = content[valueStart];
        if (quoteChar !== '"' && quoteChar !== "'" && quoteChar !== '`') { continue; } // not a direct literal — skip
        const skipEnd = skipQuotedLiteral(content, valueStart);
        if (content[skipEnd - 1] !== quoteChar) { continue; } // unterminated — no closing quote found
        const end = skipEnd - 1;
        const staticText = extractStaticText(content.slice(valueStart + 1, end));
        if (looksLikeProse(staticText)) {
            findings.push({
                index: m.index,
                line: lineAt(content, m.index),
                kind: `setAttribute('${attr}') argument`,
                snippet: toSnippet(content.slice(m.index, end + 1)),
            });
        }
    }
    return findings;
}

/**
 * Run all detectors against one file's content, deduped by line+snippet and
 * optionally restricted to a set of allowed character ranges.
 */
function scanFile(content, allowedRanges) {
    let all = [
        ...findPropertyAssignments(content),
        ...findHtmlAttributes(content),
        ...findTagContent(content),
        ...findHelperCallText(content),
        ...findTextNodeCalls(content),
        ...findSetAttributeCalls(content),
    ];
    if (allowedRanges) {
        all = all.filter((f) => isWithinRanges(f.index, allowedRanges));
    }
    const seen = new Set();
    const deduped = [];
    for (const f of all) {
        const key = `${f.line}|${f.kind}|${f.snippet}`;
        if (seen.has(key)) { continue; }
        seen.add(key);
        deduped.push({ line: f.line, kind: f.kind, snippet: f.snippet });
    }
    deduped.sort((a, b) => a.line - b.line);
    return deduped;
}

// ── Report generation ───────────────────────────────────────────────────────

function buildMarkdownReport(results, total, scannedCount) {
    const lines = [];
    lines.push('# Hardcoded UI Strings Inventory');
    lines.push('');
    lines.push(`Generated by \`.github/skills/scan-hardcoded-strings/scan-hardcoded-strings.js\` on ${new Date().toISOString().slice(0, 10)}.`);
    lines.push('');
    lines.push('This is an informational triage report, not a CI gate. It lists candidate UI');
    lines.push('strings under `vscode-extension/src/webview/**` and the `get*Html()` methods in');
    lines.push('`vscode-extension/src/extension.ts` that are rendered as UI text but are not');
    lines.push('wrapped in `localize()`, `localizeFormat()`, `t()`, or `vscode.l10n.t()`. Some entries may be false');
    lines.push('positives (see the skill README for the exclusion rules) — triage each one');
    lines.push('before localizing.');
    lines.push('');
    lines.push(`- Files scanned: ${scannedCount}`);
    lines.push(`- Files with findings: ${results.length}`);
    lines.push(`- Total candidate strings: ${total}`);
    lines.push('');

    if (total === 0) {
        lines.push('No hardcoded UI strings found.');
    } else {
        lines.push('## Findings by file');
        lines.push('');
        for (const { file, findings } of results) {
            lines.push(`### \`${file}\` (${findings.length})`);
            lines.push('');
            lines.push('| Line | Kind | Snippet |');
            lines.push('|---|---|---|');
            for (const f of findings) {
                lines.push(`| ${f.line} | ${f.kind} | \`${escapeTableCell(f.snippet)}\` |`);
            }
            lines.push('');
        }
    }

    return lines.join('\n') + '\n';
}

// ── Main ───────────────────────────────────────────────────────────────────

// Characters/keywords after which a bare `/` starts a regex literal rather
// than a division operator — the standard heuristic ("this position expects
// an expression, not a value to divide"). Not exhaustive JS grammar, but
// covers this codebase's actual regex call sites (`.replace(/.../, ...)`,
// `.test(/.../)`, `return /.../`. etc.).
const REGEX_CONTEXT_RE = /(?:[(,=:[!&|?{};]|\breturn|\btypeof|\bcase)\s*$/;

/**
 * Does a bare `/` at this point in `resultSoFar` start a regex literal? Looks
 * at the last non-whitespace content already emitted (or the start of file).
 */
function isRegexLiteralStart(resultSoFar) {
    if (resultSoFar.trim() === '') { return true; }
    return REGEX_CONTEXT_RE.test(resultSoFar.slice(-60));
}

/**
 * Blank out `/* ... *\/` block comments (JSDoc included), replacing every
 * non-newline character with a space so character offsets and line numbers
 * stay identical to the original content. This keeps example markup or
 * prose written in a doc comment (e.g. `Converts [text](url) to <a
 * href="url">text</a>`) from being reported as real UI text. Line comments
 * (`//`) are deliberately left unmasked — `//` also opens a URL, and unlike a
 * block comment's `/*`, stripping from the first `//` to end-of-line risks
 * truncating a genuine template-literal line that happens to contain one —
 * but they are still skipped *opaquely* (copied through without
 * interpretation) so a quote character inside one can't desync the scanner.
 *
 * A stack-based scan tracks what kind of span each character is in — code,
 * a `"`/`'` string, a `` ` `` template literal, a `${...}` interpolation
 * inside one, or a comment — so that:
 *   - a UI string containing the literal text `/*` / `*\/` (e.g.
 *     `'<div>/* text *\/Save changes</div>'`) is left untouched rather than
 *     being mistaken for a real comment;
 *   - a regex literal containing a quote character (e.g. `.replace(/"/g,
 *     '&quot;')`) doesn't get misread as opening an unterminated string;
 *   - a *nested* template literal — `` `...${fn('a', `${x} b`, `c`)}...` ``,
 *     common in this HTML-templating codebase — doesn't get misread as
 *     closing the outer template at its first inner backtick. Both of the
 *     previous two bugs, if left unfixed, silently disable comment masking
 *     for the entire rest of the file from that point on.
 */
function maskBlockComments(content) {
    let result = '';
    // Stack of spans we're nested inside, innermost last. 'code' is also
    // used for the body of a `${...}` interpolation (tracking its own brace
    // `depth` so a nested `{}` block/object literal doesn't end it early).
    const stack = [{ type: 'code' }];
    let i = 0;
    while (i < content.length) {
        const top = stack[stack.length - 1];
        const c = content[i];
        const next = content[i + 1];

        if (top.type === 'comment') {
            if (c === '*' && next === '/') { result += '  '; i += 2; stack.pop(); continue; }
            result += c === '\n' ? '\n' : ' ';
            i++;
            continue;
        }

        if (top.type === 'string') {
            result += c;
            if (c === '\\') { result += content[i + 1] ?? ''; i += 2; continue; }
            if (c === top.quote) { stack.pop(); }
            i++;
            continue;
        }

        if (top.type === 'template') {
            if (c === '\\') { result += c + (content[i + 1] ?? ''); i += 2; continue; }
            if (c === '`') { result += c; stack.pop(); i++; continue; }
            if (c === '$' && next === '{') { result += '${'; stack.push({ type: 'code', depth: 0, inTemplateExpr: true }); i += 2; continue; }
            result += c;
            i++;
            continue;
        }

        // 'code' — either top-level or inside a `${...}` interpolation.
        if (top.inTemplateExpr) {
            if (c === '{') { top.depth++; result += c; i++; continue; }
            if (c === '}') {
                if (top.depth === 0) { stack.pop(); result += c; i++; continue; }
                top.depth--;
                result += c;
                i++;
                continue;
            }
        }
        if (c === '/' && next === '*') { stack.push({ type: 'comment' }); result += '  '; i += 2; continue; }
        if (c === '/' && next === '/') {
            // Line comment: copy through unmasked but opaquely, so any
            // stray quote/regex-like character inside it is not interpreted.
            while (i < content.length && content[i] !== '\n') { result += content[i]; i++; }
            continue;
        }
        if (c === '"' || c === "'") { stack.push({ type: 'string', quote: c }); result += c; i++; continue; }
        if (c === '`') { stack.push({ type: 'template' }); result += c; i++; continue; }
        if (c === '/' && isRegexLiteralStart(result)) {
            const end = findRegexLiteralEnd(content, i);
            if (end !== -1) {
                result += content.slice(i, end);
                i = end;
                continue;
            }
        }
        result += c;
        i++;
    }
    return result;
}

/**
 * Given a `/` at `start` that looks like it opens a regex literal, scan for
 * its closing `/` (respecting `[...]` character classes and backslash
 * escapes, and never crossing a newline — an unterminated-looking regex is
 * treated as division instead) plus any trailing flag letters. Returns the
 * index just past the literal, or -1 if it doesn't look like a real regex.
 */
function findRegexLiteralEnd(content, start) {
    let inClass = false;
    let j = start + 1;
    while (j < content.length) {
        const cc = content[j];
        if (cc === '\n') { return -1; }
        if (cc === '\\') { j += 2; continue; }
        if (cc === '[') { inClass = true; j++; continue; }
        if (cc === ']') { inClass = false; j++; continue; }
        if (cc === '/' && !inClass) {
            let k = j + 1;
            while (k < content.length && /[a-z]/i.test(content[k])) { k++; }
            return k;
        }
        j++;
    }
    return -1;
}

function runScan() {
    const files = [...collectTsFiles(WEBVIEW_DIR)];
    if (fs.existsSync(EXTENSION_FILE)) { files.push(EXTENSION_FILE); }

    const results = []; // { file, findings }
    let total = 0;

    for (const file of files.sort()) {
        const content = maskBlockComments(fs.readFileSync(file, 'utf8'));
        const allowedRanges = file === EXTENSION_FILE ? extractHtmlMethodRanges(content) : null;
        const findings = scanFile(content, allowedRanges);
        if (findings.length > 0) {
            const rel = path.relative(REPO_ROOT, file);
            results.push({ file: rel, findings });
            total += findings.length;
        }
    }

    return { results, total, scannedCount: files.length };
}

function main() {
    const argv = process.argv.slice(2);
    const jsonMode = argv.includes('--json');
    const outIdx = argv.indexOf('--out');
    // Overridable so tests can point the report at a scratch path instead of
    // writing into the repo root on every test run.
    const reportPath = outIdx !== -1 && argv[outIdx + 1] ? path.resolve(argv[outIdx + 1]) : REPORT_PATH;
    const { results, total, scannedCount } = runScan();

    if (jsonMode) {
        console.log(JSON.stringify({ total, files: results }, null, 2));
    } else {
        console.log(`Scanned ${scannedCount} file(s) under vscode-extension/src/webview/ and extension.ts's get*Html() methods\n`);
        if (total === 0) {
            console.log('No hardcoded UI strings found.');
        } else {
            for (const { file, findings } of results) {
                console.log(`${file} (${findings.length})`);
                for (const f of findings) {
                    console.log(`  L${f.line} [${f.kind}] ${f.snippet}`);
                }
                console.log('');
            }
            console.log('─────────────────────────────────────────');
            console.log(`Found ${total} candidate hardcoded string(s) across ${results.length} file(s).`);
            console.log('This is an informational inventory, not a hard failure — see the skill README for triage guidance.');
        }
    }

    fs.writeFileSync(reportPath, buildMarkdownReport(results, total, scannedCount), 'utf8');
    if (!jsonMode) {
        console.log(`\nMarkdown report written to ${path.relative(REPO_ROOT, reportPath)}`);
    }

    // Informational script — never fail the build. Setting exitCode (rather
    // than calling process.exit()) lets buffered stdout/stderr writes drain
    // before the process exits, instead of risking truncated output when
    // piped (e.g. in CI or `| head`).
    process.exitCode = 0;
}

/**
 * Run `mainFn` (defaults to `main`) but honor the "always exits 0" contract
 * even when something operational goes wrong (an unreadable source file, an
 * unwritable report path, etc.) — those errors are reported to stderr, not
 * left to crash the process with a non-zero exit that would unexpectedly
 * fail a maintenance or CI invocation of this informational script. `mainFn`
 * is injectable so the catch behavior itself can be unit tested without
 * needing to force a real filesystem failure.
 */
function runMain(mainFn = main) {
    try {
        mainFn();
    } catch (err) {
        console.error('scan-hardcoded-strings: error while scanning —', err instanceof Error ? err.message : err);
        process.exitCode = 0;
    }
}

module.exports = {
    collectTsFiles,
    skipQuotedLiteral,
    findMatchingBracket,
    extractHtmlMethodRanges,
    isWithinRanges,
    stripLocalizedCalls,
    extractInterpolationLiterals,
    stripInterpolations,
    stripHtmlTags,
    stripHtmlEntities,
    extractStaticText,
    looksLikeProse,
    toSnippet,
    escapeTableCell,
    findPropertyAssignments,
    findHtmlAttributes,
    findTagContent,
    findHelperCallText,
    findTextNodeCalls,
    findSetAttributeCalls,
    splitTopLevelArgs,
    splitTopLevelConcat,
    splitTernary,
    splitNullishOrOr,
    extractConcatenatedLiteralText,
    scanFile,
    maskBlockComments,
    isRegexLiteralStart,
    findRegexLiteralEnd,
    buildMarkdownReport,
    runScan,
    main,
    runMain,
};

if (require.main === module) {
    runMain();
}
