#!/usr/bin/env node
'use strict';

/**
 * Unit tests for the hardcoded-string detection logic in scan-hardcoded-strings.js.
 *
 * Run with:  node --test .github/skills/scan-hardcoded-strings/scan-hardcoded-strings.test.js
 *
 * These tests cover the pure helpers — the localization-call stripper, the
 * interpolation stripper, the prose heuristic, the individual detectors, and
 * the extension.ts scope restriction — the logic most likely to silently
 * produce a wrong inventory if a regex drifts.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const {
    stripLocalizedCalls,
    stripInterpolations,
    stripHtmlTags,
    extractStaticText,
    looksLikeProse,
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
    skipQuotedLiteral,
    scanFile,
    extractHtmlMethodRanges,
    isWithinRanges,
    buildMarkdownReport,
    runMain,
    maskBlockComments,
    isRegexLiteralStart,
    findRegexLiteralEnd,
    findMatchingBracket,
} = require('./scan-hardcoded-strings.js');

const SCRIPT_PATH = path.join(__dirname, 'scan-hardcoded-strings.js');

// ── stripLocalizedCalls ──────────────────────────────────────────────────────

test('stripLocalizedCalls: removes a localize() call entirely', () => {
    assert.equal(stripLocalizedCalls("localize('nav.refresh')"), '');
});

test('stripLocalizedCalls: removes vscode.l10n.t() and l10n.t() calls', () => {
    assert.equal(stripLocalizedCalls("vscode.l10n.t('key')"), '');
    assert.equal(stripLocalizedCalls("l10n.t('key')"), '');
});

test('stripLocalizedCalls: removes a bare t() call but not identifiers ending in "t("', () => {
    assert.equal(stripLocalizedCalls("t('key')"), '');
    assert.equal(stripLocalizedCalls('getText(foo)'), 'getText(foo)');
    assert.equal(stripLocalizedCalls('format(foo)'), 'format(foo)');
});

test('stripLocalizedCalls: leaves surrounding text intact', () => {
    assert.equal(stripLocalizedCalls("prefix ${localize('key')} suffix"), 'prefix ${} suffix');
});

test('stripLocalizedCalls: removes a localizeFormat() call (and its extra args) entirely', () => {
    assert.equal(stripLocalizedCalls("localizeFormat('nav.count', count)"), '');
    // Confirm "localize" as a plain prefix doesn't cause a bad partial match:
    // the whole "localizeFormat(...)" call must be consumed, not just "localize".
    assert.equal(stripLocalizedCalls("prefix ${localizeFormat('key', n)} suffix"), 'prefix ${} suffix');
});

// ── stripInterpolations ──────────────────────────────────────────────────────

test('stripInterpolations: blanks a plain variable interpolation', () => {
    assert.match(stripInterpolations('Hello ${name}!').trim(), /^Hello\s+!$/);
});

test('stripInterpolations: preserves string literals from a ternary interpolation', () => {
    const result = stripInterpolations("${flag ? 'Enable Overrides' : 'Disable Overrides'}");
    assert.match(result, /Enable Overrides/);
    assert.match(result, /Disable Overrides/);
});

test('stripInterpolations: drops localized calls inside an interpolation', () => {
    const result = stripInterpolations("${localize('nav.refresh')}");
    assert.equal(result.trim(), '');
});

test('stripInterpolations: one non-prose literal in a ternary does not suppress a genuine sibling', () => {
    // Regression: joining literals before the prose check let a leading URL
    // branch's failed URL check apply to the whole joined string, discarding
    // a real label like "Open link" that happened to share the interpolation.
    const result = stripInterpolations("${cond ? 'https://example.com' : 'Open link'}");
    assert.match(result, /Open link/);
    assert.doesNotMatch(result, /https:\/\//);
});

test('stripInterpolations: a typeof/comparison literal in the ternary condition is not treated as a UI-text branch', () => {
    // Regression: `typeof x === 'string' ? x : ''` used to have "string"
    // extracted as if it were a hardcoded ternary branch, because
    // extractInterpolationLiterals scanned for *any* quoted literal in the
    // expression rather than just the branches after "?".
    const result = stripInterpolations("${typeof label === 'string' ? label : ''}");
    assert.doesNotMatch(result, /string/);
});

test('stripInterpolations: a literal argument to a non-localization helper call is not treated as UI text', () => {
    // Regression: `${buttonHtml('btn-refresh')}` had 'btn-refresh' extracted
    // and flagged as prose, because extractInterpolationLiterals grabbed any
    // quoted literal anywhere in the interpolation's expression, not just an
    // actual ternary branch. 'btn-refresh' follows '(' here, not '?'/':', so
    // it is no longer a ternary-branch position.
    const result = stripInterpolations("${buttonHtml('btn-refresh')}");
    assert.doesNotMatch(result, /btn-refresh/);
});

test('stripInterpolations: preserves a literal fallback after ||', () => {
    // Regression: logviewer/main.ts's `${escapeHtml(turn.userMessage) ||
    // '<em>No message</em>'}` and diagnostics/main.ts's
    // `${escapeHtml(message.error || "Unknown error")}` were both invisible —
    // the ternary-branch rule only recognized a literal after '?'/':', not
    // the fallback side of a `||` default.
    const result1 = stripInterpolations("${escapeHtml(turn.userMessage) || '<em>No message</em>'}");
    assert.match(result1, /No message/);
    const result2 = stripInterpolations('${escapeHtml(message.error || "Unknown error")}');
    assert.match(result2, /Unknown error/);
});

test('stripInterpolations: recovers a nested template literal passed as a plain call argument', () => {
    // Regression: logviewer/hydraFusionSection.ts's `title="${escapeHtml(`${p.kind}
    // · ${p.model} · ${formatAiu(p.usage.aiu)} AIU`)}"` was invisible — the
    // nested template literal's static text ("AIU") was discarded because
    // it wasn't preceded by '?'/':'/'||' (it follows the plain call
    // `escapeHtml(`). Unlike a quoted string (routinely a lookup key/id in
    // this codebase, e.g. `buttonHtml('btn-refresh')`), a *template*
    // literal is used to build display text, so it's recovered regardless
    // of what precedes it.
    const result = stripInterpolations('${escapeHtml(`${p.kind} · ${p.model} · ${formatAiu(p.usage.aiu)} AIU`)}');
    assert.match(result, /AIU/);
});

test('stripInterpolations: does not recover a plain quoted literal that is not a branch, even inside a nested template', () => {
    // The template-literal relaxation above must not swallow the *sibling*
    // rule that a plain quoted literal is only recovered at a branch
    // position — confirm buttonHtml('btn-refresh') is still excluded when
    // it appears in a more complex surrounding expression.
    const result = stripInterpolations("${cond ? buttonHtml('btn-refresh') : ''}");
    assert.doesNotMatch(result, /btn-refresh/);
});

// ── stripHtmlEntities ────────────────────────────────────────────────────────

test('extractStaticText: strips HTML entities so an entity name is not mistaken for prose', () => {
    // Regression: maturity/shareCard.ts's `${reportLabel} &middot;
    // ${escapeHtml(when)}` reduced (once both interpolations are stripped)
    // to just "&middot;", and looksLikeProse read the entity name "middot"
    // as a real prose word.
    const result = extractStaticText('${reportLabel} &middot; ${escapeHtml(when)}');
    assert.doesNotMatch(result, /middot/);
    assert.equal(looksLikeProse(result), false);
});

test('extractStaticText: strips numeric and hex HTML entities too', () => {
    const result = extractStaticText('${a} &#8220;&#x201c;&ldquo;');
    assert.doesNotMatch(result, /&/);
});

// ── extractStaticText / looksLikeProse ───────────────────────────────────────

test('extractStaticText: strips both localized calls and interpolations', () => {
    const result = extractStaticText("${localize('key')} Loading ${count} items");
    assert.match(result, /Loading/);
    assert.match(result, /items/);
});

test('stripHtmlTags: removes tag delimiters but keeps text between them', () => {
    assert.equal(stripHtmlTags('<strong>Note:</strong>').trim(), 'Note:');
});

test('extractStaticText: a tag whose only content was an interpolation does not leak its tag name as prose', () => {
    // Regression: `<strong>${formatNumber(count)}</strong> (${formatPercent(pct, 0)})`
    // used to leave `<strong></strong>` behind after interpolation removal,
    // and looksLikeProse counted "strong" itself as a hardcoded letter run.
    const result = extractStaticText('<strong>${formatNumber(count)}</strong> (${formatPercent(pct, 0)})');
    assert.equal(looksLikeProse(result), false);
});

test('looksLikeProse: rejects pure numbers, symbols, and emoji', () => {
    assert.equal(looksLikeProse('123'), false);
    assert.equal(looksLikeProse('→'), false);
    assert.equal(looksLikeProse('  '), false);
});

test('looksLikeProse: rejects URLs', () => {
    assert.equal(looksLikeProse('https://example.com/docs'), false);
    assert.equal(looksLikeProse('www.example.com'), false);
});

test('looksLikeProse: rejects CSS values', () => {
    assert.equal(looksLikeProse('#fff'), false);
    assert.equal(looksLikeProse('12px'), false);
    assert.equal(looksLikeProse('1.5rem'), false);
    assert.equal(looksLikeProse('rgba(0,0,0,0.5)'), false);
    assert.equal(looksLikeProse('var(--text-muted)'), false);
});

test('looksLikeProse: rejects known CSS-keyword/state single tokens', () => {
    assert.equal(looksLikeProse('active'), false);
    assert.equal(looksLikeProse('flex'), false);
    assert.equal(looksLikeProse('hidden'), false);
});

test('looksLikeProse: accepts genuine UI prose', () => {
    assert.equal(looksLikeProse('No data available.'), true);
    assert.equal(looksLikeProse('Refresh'), true);
    assert.equal(looksLikeProse('Enable Overrides'), true);
});

test('looksLikeProse: accepts a genuine one-word label that is not a known CSS keyword', () => {
    // Regression: the single-token exclusion must be a narrow denylist, not a
    // blanket rule against every lowercase word — "tie", "open", "manage" are
    // real visible UI text (e.g. a <span class="model-win-chip tie">tie</span>).
    assert.equal(looksLikeProse('tie'), true);
    assert.equal(looksLikeProse('open'), true);
    assert.equal(looksLikeProse('manage'), true);
});

test('looksLikeProse: accepts non-English (non-ASCII) UI text', () => {
    // Regression: the letter-run check was ASCII-only ([A-Za-z]), so hardcoded
    // Chinese/Cyrillic/etc. text was silently exempt from the inventory.
    assert.equal(looksLikeProse('刷新'), true);
    assert.equal(looksLikeProse('Сохранить'), true);
});

// ── escapeTableCell ───────────────────────────────────────────────────────────

test('escapeTableCell: escapes backslashes before pipes so escaping cannot combine', () => {
    // A naive `text.replace(/\|/g, '\\|')` would turn a trailing backslash
    // before a pipe into `\\|`, changing which characters are escaped.
    assert.equal(escapeTableCell('a\\|b'), 'a\\\\\\|b');
});

test('escapeTableCell: neutralizes backticks so a snippet cannot close its code span early', () => {
    assert.equal(escapeTableCell('has `backtick` inside'), "has 'backtick' inside");
});

// ── findMatchingBracket ──────────────────────────────────────────────────────

test('findMatchingBracket: finds the matching close paren', () => {
    const src = 'el(a, b, c)';
    assert.equal(findMatchingBracket(src, 2, '(', ')'), src.length - 1);
});

test('findMatchingBracket: treats quoted content as opaque, ignoring brackets inside it', () => {
    // Regression: an unmatched "(" inside a UI string used to make the naive
    // depth counter overshoot past the call's real closing paren.
    const src = "el('span', 'label', 'What does this (mean?')";
    const end = findMatchingBracket(src, 2, '(', ')');
    assert.equal(end, src.length - 1);
});

test('findMatchingBracket: works for braces too', () => {
    const src = '{ a: 1, b: { c: 2 } }';
    assert.equal(findMatchingBracket(src, 0, '{', '}'), src.length - 1);
});

test('findMatchingBracket: a nested template literal does not desync the paren count', () => {
    // Regression: a template literal's own backtick was treated as a flat
    // quote, so a *nested* template literal inside a `${...}` interpolation
    // (e.g. `` `outer ${fn(`inner)`)}` ``, common in this HTML-templating
    // codebase) had its inner backtick misread as closing the outer one,
    // making the call's real closing paren undercounted.
    const src = "el('div', '', `outer ${fn(`inner)`)}`)";
    const openIdx = src.indexOf('(');
    assert.equal(findMatchingBracket(src, openIdx, '(', ')'), src.length - 1);
});

// ── skipQuotedLiteral ────────────────────────────────────────────────────────

test('skipQuotedLiteral: skips a plain quoted string', () => {
    const src = "'hello' rest";
    assert.equal(skipQuotedLiteral(src, 0), "'hello'".length);
});

test('skipQuotedLiteral: skips a template literal containing a nested template inside an interpolation', () => {
    const src = '`outer ${fn(`inner`)} end` rest';
    const end = skipQuotedLiteral(src, 0);
    assert.equal(src.slice(0, end), '`outer ${fn(`inner`)} end`');
});

test('skipQuotedLiteral: tracks an object literal inside an interpolation without closing early', () => {
    const src = '`${ {a: 1} }` rest';
    const end = skipQuotedLiteral(src, 0);
    assert.equal(src.slice(0, end), '`${ {a: 1} }`');
});

// ── findPropertyAssignments ───────────────────────────────────────────────────

test('findPropertyAssignments: flags a hardcoded .textContent string literal', () => {
    const findings = findPropertyAssignments("el.textContent = 'No data available.';");
    assert.equal(findings.length, 1);
    assert.equal(findings[0].kind, '.textContent assignment');
});

test('findPropertyAssignments: does not flag an already-localized assignment', () => {
    const findings = findPropertyAssignments("el.textContent = localize('details.noData');");
    assert.equal(findings.length, 0);
});

test('findPropertyAssignments: does not flag a variable or function-call RHS', () => {
    const findings = findPropertyAssignments('el.textContent = someVariable;');
    assert.equal(findings.length, 0);
});

test('findPropertyAssignments: flags a template literal with hardcoded prose around an interpolation', () => {
    const findings = findPropertyAssignments('el.title = `Delete data for ${userId} now`;');
    assert.equal(findings.length, 1);
});

test('findPropertyAssignments: skips innerHTML assignments containing markup (deferred to tag scan)', () => {
    const findings = findPropertyAssignments('el.innerHTML = `<div>Some text</div>`;');
    assert.equal(findings.length, 0);
});

test('findPropertyAssignments: a nested template literal inside an interpolation does not truncate the match', () => {
    // Regression: the template-literal RHS regex (`` `([^`]*)` ``) stopped at
    // the FIRST backtick, so `.title = \`${format(\`Save changes\`)}\`;` was
    // truncated at the nested template's opener and its real text ("Save
    // changes") was never inspected.
    const findings = findPropertyAssignments('el.title = `${format(`Save changes`)}`;');
    assert.equal(findings.length, 1);
    assert.match(findings[0].snippet, /Save changes/);
});

test('findPropertyAssignments: flags a ternary RHS whose branches are literals', () => {
    // Regression: `otherTr.title = expanded ? 'Collapse other editors' :
    // 'Expand other editors';` was invisible because the RHS doesn't start
    // immediately with a quote.
    const findings = findPropertyAssignments(
        "otherTr.title = editorOtherExpanded ? 'Collapse other editors' : 'Expand other editors';"
    );
    assert.equal(findings.length, 1);
    assert.equal(findings[0].kind, '.title assignment (conditional)');
});

test('findPropertyAssignments: a plain literal RHS containing "?" is not double-reported as conditional', () => {
    const findings = findPropertyAssignments("el.title = 'What does this mean?';");
    assert.equal(findings.length, 1);
    assert.equal(findings[0].kind, '.title assignment');
});

test('findPropertyAssignments: does not treat a "===" comparison as an assignment', () => {
    // Regression: `.title === 'string' ? i.title : ''` is a typeof-style
    // comparison inside some other expression, not a `.title =` assignment —
    // `=\s*` alone would match the first "=" of "===" and misread the rest.
    const findings = findPropertyAssignments("check(i.title === 'string' ? i.title : '');");
    assert.equal(findings.length, 0);
});

test('findPropertyAssignments: does not flag a "typeof x === literal" comparison inside a real ternary condition', () => {
    // Regression: extractInterpolationLiterals used to pick up the 'string'
    // typeof-comparison literal in the ternary's *condition* and flag it as
    // if it were a hardcoded UI-text branch.
    const findings = findPropertyAssignments(
        "el.textContent = typeof check?.label === 'string' ? check.label : '';"
    );
    assert.equal(findings.length, 0);
});

test('findPropertyAssignments: flags a multi-line ternary with template-literal branches', () => {
    // Regression: a ternary wrapped across lines (a common style for a long
    // condition/branches) was invisible because the RHS scan stopped at the
    // first newline, and template-literal branches weren't recognized as
    // literals at all (only single/double-quoted ones were).
    const src = [
        'card.title = isExcluded',
        '    ? `${provider} is hidden — click to show it again and include it in the totals below.`',
        '    : `Click to hide ${provider} — filters it out of the totals and the Editor/Model usage lists below.`;',
    ].join('\n');
    const findings = findPropertyAssignments(src);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].kind, '.title assignment (conditional)');
});

test('findPropertyAssignments: a semicolon inside a quoted conditional branch does not truncate the statement', () => {
    // Regression: the statement-boundary scan looked for the first `;`
    // anywhere in the text (`[^;]*?`), so `el.title = condition ? 'Save;
    // changes' : 'Cancel';` was truncated right after "Save" and neither
    // branch was ever extracted.
    const findings = findPropertyAssignments("el.title = condition ? 'Save; changes' : 'Cancel';");
    assert.equal(findings.length, 1);
    assert.match(findings[0].snippet, /Save; changes/);
});

// ── findHtmlAttributes ───────────────────────────────────────────────────────

test('findHtmlAttributes: flags a hardcoded aria-label', () => {
    const findings = findHtmlAttributes('<button aria-label="Close panel"></button>');
    assert.equal(findings.length, 1);
    assert.equal(findings[0].kind, 'aria-label attribute');
});

test('findHtmlAttributes: flags a hardcoded title HTML attribute', () => {
    const findings = findHtmlAttributes('<button title="Show all dismissed tips again"></button>');
    assert.equal(findings.length, 1);
    assert.equal(findings[0].kind, 'title attribute');
});

test('findHtmlAttributes: flags a hardcoded placeholder HTML attribute', () => {
    const findings = findHtmlAttributes('<input placeholder="Enter a folder path" />');
    assert.equal(findings.length, 1);
    assert.equal(findings[0].kind, 'placeholder attribute');
});

test('findHtmlAttributes: does not flag an already-localized aria-label', () => {
    const findings = findHtmlAttributes("<button aria-label=\"${localize('close')}\"></button>");
    assert.equal(findings.length, 0);
});

test('findHtmlAttributes: does not flag a JS ".title = " property assignment', () => {
    // findPropertyAssignments already covers this syntactic form; the HTML
    // attribute detector must not double-report the same occurrence.
    const findings = findHtmlAttributes("panel.title = 'Session: foo';");
    assert.equal(findings.length, 0);
});

test('findHtmlAttributes: does not flag a plain local variable named "title"/"placeholder"', () => {
    // Regression: `let title = 'Sessions';` is a JS variable declaration, not
    // an HTML attribute — HTML attributes in this codebase are always written
    // tight (`title="..."`, no spaces around `=`).
    const findings = findHtmlAttributes("let title = 'Sessions by Provider';\nconst placeholder = 'Pick a folder';");
    assert.equal(findings.length, 0);
});

test('findHtmlAttributes: does not flag "subtitle=" or "data-title=" (not the title attribute)', () => {
    const findings = findHtmlAttributes('<div subtitle="Some prose" data-title="Other prose"></div>');
    assert.equal(findings.length, 0);
});

// ── findTagContent ────────────────────────────────────────────────────────────

test('findTagContent: flags hardcoded text inside a <button>', () => {
    const findings = findTagContent('<button>Refresh</button>');
    assert.equal(findings.length, 1);
    assert.equal(findings[0].kind, '<button> content');
});

test('findTagContent: flags hardcoded text inside a <div>', () => {
    const findings = findTagContent('<div class="info-box-title">Share Card</div>');
    assert.equal(findings.length, 1);
    assert.equal(findings[0].kind, '<div> content');
});

test('findTagContent: recovers a ternary\'s string literals inside tag content', () => {
    const findings = findTagContent("<button>${flag ? 'Disable Overrides' : 'Enable Overrides'}</button>");
    assert.equal(findings.length, 1);
    assert.match(findings[0].snippet, /Enable Overrides/);
});

test('findTagContent: does not flag an already-localized tag body', () => {
    const findings = findTagContent("<span>${localize('logviewer.summary.editorMode')}</span>");
    assert.equal(findings.length, 0);
});

test('findTagContent: does not flag a tag with only a CSS-value-like or empty body', () => {
    assert.equal(findTagContent('<span class="dot"></span>').length, 0);
    assert.equal(findTagContent('<span style="color:#fff"> </span>').length, 0);
});

test('findTagContent: tolerates simple nested inline tags (<a>, <strong>) inside a block tag', () => {
    const findings = findTagContent(
        '<div class="beta-footer-content"><strong>Beta</strong> — please <a href="https://example.com">create an issue</a> on the repository.</div>'
    );
    assert.equal(findings.length, 1);
    assert.match(findings[0].snippet, /create an issue/);
});

test('findTagContent: flags hardcoded text inside a <li>', () => {
    const findings = findTagContent('<li>Repository-specific usage tracking</li>');
    assert.equal(findings.length, 1);
    assert.equal(findings[0].kind, '<li> content');
});

test('findTagContent: flags hardcoded text inside a document <title>', () => {
    const findings = findTagContent('<title>Diagnostic Report</title>');
    assert.equal(findings.length, 1);
    assert.equal(findings[0].kind, '<title> content');
});

test('findTagContent: flags an inline tag (<strong>) used as the root of the literal, not just nested', () => {
    // Regression: a literal whose *root* is an inline-only tag (e.g. the body
    // of an `el.innerHTML = '<strong>Save changes</strong>'` assignment,
    // which findPropertyAssignments defers here because it contains "<")
    // must still be found even though <strong> isn't a TAG_NAMES container.
    const findings = findTagContent('<strong>Save changes</strong>');
    assert.equal(findings.length, 1);
    assert.equal(findings[0].kind, '<strong> content');
});

test('findTagContent: tolerates a void/structural tag (<input>) before visible text in a <label>', () => {
    const findings = findTagContent('<label><input type="checkbox" /> Enable feature flag</label>');
    assert.equal(findings.length, 1);
    assert.match(findings[0].snippet, /Enable feature flag/);
});

test('findTagContent: tolerates <br> line breaks inside a <div>', () => {
    const findings = findTagContent('<div>It never tells you<br>that you are ready to go dark.</div>');
    assert.equal(findings.length, 1);
    assert.match(findings[0].snippet, /ready to go dark/);
});

test('findTagContent: flags hardcoded text inside a <vscode-button>', () => {
    const findings = findTagContent('<vscode-button id="btn-refresh">🔄 Refresh</vscode-button>');
    assert.equal(findings.length, 1);
    assert.equal(findings[0].kind, '<vscode-button> content');
});

test('findTagContent: tolerates a nested <span> badge inside a <label> without losing the outer text', () => {
    // Regression: a <span> nested inside another scanned tag (e.g. a trailing
    // counter badge) was not in INLINE_PASSTHROUGH_TAGS, so the body pattern
    // couldn't get past it and the whole outer <label> match — including its
    // real UI text — was missed (diagnostics/main.ts's "Show only sessions
    // with unattributed tokens" checkbox label).
    const findings = findTagContent(
        '<label>Show only sessions with unattributed tokens<span class="hidden-count">(3)</span></label>',
    );
    assert.equal(findings.length, 1);
    assert.equal(findings[0].kind, '<label> content');
    assert.match(findings[0].snippet, /unattributed tokens/);
});

test('findTagContent: flags hardcoded text inside an SVG <text> element', () => {
    // Regression: 'text' wasn't in TAG_NAMES, so SVG chart labels like
    // usage/main.ts's <text>One-shot edit rate</text> and
    // <text>higher is better</text> were invisible to this scan.
    const findings = findTagContent('<text class="efficiency-chart-hint" x="836" y="17">higher is better</text>');
    assert.equal(findings.length, 1);
    assert.equal(findings[0].kind, '<text> content');
});

// ── splitTopLevelArgs ─────────────────────────────────────────────────────────

test('splitTopLevelArgs: splits simple comma-separated arguments', () => {
    assert.deepEqual(splitTopLevelArgs("'div', 'header'"), ["'div'", "'header'"]);
});

test('splitTopLevelArgs: does not split on commas inside nested parens/brackets/braces', () => {
    const args = splitTopLevelArgs("'div', foo(a, b), [1, 2], { x: 1, y: 2 }");
    assert.deepEqual(args, ["'div'", 'foo(a, b)', '[1, 2]', '{ x: 1, y: 2 }']);
});

test('splitTopLevelArgs: does not split on commas or interpolation braces inside a template literal', () => {
    const args = splitTopLevelArgs("'button', `toggle${a === 'x' ? ' active' : ''}`, 'Day'");
    assert.deepEqual(args, ["'button'", "`toggle${a === 'x' ? ' active' : ''}`", "'Day'"]);
});

// ── findHelperCallText ───────────────────────────────────────────────────────

test('findHelperCallText: flags the text argument of el(tag, className, text)', () => {
    const findings = findHelperCallText("el('button', 'my-btn', 'Take me there')");
    assert.equal(findings.length, 1);
    assert.equal(findings[0].kind, 'el() text argument');
});

test('findHelperCallText: flags the text argument of iconHeading(tag, icon, text, className)', () => {
    const findings = findHelperCallText("iconHeading('h3', 'graph', 'Key Metrics')");
    assert.equal(findings.length, 1);
    assert.equal(findings[0].kind, 'iconHeading() text argument');
});

test('findHelperCallText: flags the label argument of the legacy createButton(id, label, appearance)', () => {
    const findings = findHelperCallText("createButton('btn-save', 'Save changes', 'primary')");
    assert.equal(findings.length, 1);
    assert.equal(findings[0].kind, 'createButton() text argument');
});

test('findHelperCallText: does not flag a variable/expression text argument', () => {
    const findings = findHelperCallText("el('span', 'label', getChartTitle())");
    assert.equal(findings.length, 0);
});

test('findHelperCallText: does not flag createButton(config) called with a single object argument', () => {
    const findings = findHelperCallText('createButton(config)');
    assert.equal(findings.length, 0);
});

test('findHelperCallText: does not flag a method call like this.el(...) or obj.el(...)', () => {
    const findings = findHelperCallText("this.el('button', 'my-btn', 'Take me there')");
    assert.equal(findings.length, 0);
});

test('findHelperCallText: handles a template-literal text argument containing an interpolation', () => {
    const findings = findHelperCallText("el('span', 'header-icon', `Loading ${count} items`)");
    assert.equal(findings.length, 1);
    assert.match(findings[0].snippet, /Loading/);
});

test('findHelperCallText: flags a text argument made of literals joined by +', () => {
    // Regression: whatsnew/main.ts's el('div', 'intro', `The last ${n} releases. ` +
    // 'more text.') was invisible — the single-literal pattern requires the
    // whole argument to start and end with the SAME quote character, which a
    // concatenation of a template literal and a string literal never does.
    const findings = findHelperCallText(
        "el('div', 'intro', `The last ${n} releases, in plain English. ` + 'Only until you have opened it.')",
    );
    assert.equal(findings.length, 1);
    assert.match(findings[0].snippet, /plain English/);
});

test('findHelperCallText: does not flag a concatenation with a non-literal piece', () => {
    const findings = findHelperCallText("el('div', 'intro', 'Prefix ' + getSuffix())");
    assert.equal(findings.length, 0);
});

test('findHelperCallText: flags a text argument that is a ternary of literal branches', () => {
    // Regression: dashboard/main.ts's el('div', 'loading-text', serverUrl ?
    // `Loading dashboard data from ${serverUrl}...` : 'Loading dashboard
    // data...') was invisible — extractConcatenatedLiteralText only handled
    // a direct literal or a `+` concatenation, not a top-level ternary.
    const findings = findHelperCallText(
        "el('div', 'loading-text', serverUrl ? `Loading dashboard data from ${serverUrl}...` : 'Loading dashboard data...')",
    );
    assert.equal(findings.length, 1);
    assert.match(findings[0].snippet, /Loading dashboard data/);
});

// ── splitTopLevelConcat / splitTernary / extractConcatenatedLiteralText ────────

test('splitTopLevelConcat: splits on a top-level + but not one inside a literal or nested call', () => {
    const parts = splitTopLevelConcat("`a ${1 + 2}` + 'b' + foo(1 + 1)");
    assert.deepEqual(parts, ["`a ${1 + 2}`", "'b'", 'foo(1 + 1)']);
});

test('splitTopLevelConcat: a nested template inside a piece does not desync the split', () => {
    const parts = splitTopLevelConcat("`a ${fn(`b + c`)}` + 'd'");
    assert.deepEqual(parts, ['`a ${fn(`b + c`)}`', "'d'"]);
});

test('extractConcatenatedLiteralText: joins the static text of concatenated literals', () => {
    const text = extractConcatenatedLiteralText("'Hello ' + `world`");
    assert.equal(text, 'Hello  world');
});

test('extractConcatenatedLiteralText: returns null when any piece is not a direct literal', () => {
    assert.equal(extractConcatenatedLiteralText("'Hello ' + name"), null);
});

test('splitTernary: splits a simple top-level ternary', () => {
    assert.deepEqual(splitTernary("cond ? 'a' : 'b'"), [" 'a' ", " 'b'"]);
});

test('splitTernary: returns null for a non-ternary expression', () => {
    assert.equal(splitTernary('getChartTitle()'), null);
});

test('splitTernary: does not split on optional chaining or nullish coalescing', () => {
    assert.equal(splitTernary("a?.b ?? 'c'"), null);
});

test('splitTernary: a nested ternary in a branch does not confuse the outer split point', () => {
    const [consequent, alternate] = splitTernary("a ? (b ? 'x' : 'y') : 'z'");
    assert.equal(consequent.trim(), "(b ? 'x' : 'y')");
    assert.equal(alternate.trim(), "'z'");
});

test('extractConcatenatedLiteralText: resolves a ternary of literal branches', () => {
    const text = extractConcatenatedLiteralText(
        "serverUrl ? `Loading dashboard data from ${serverUrl}...` : 'Loading dashboard data...'",
    );
    assert.match(text, /Loading dashboard data from/);
    assert.match(text, /Loading dashboard data\.\.\./);
});

test('extractConcatenatedLiteralText: returns null when a ternary has no literal branch', () => {
    assert.equal(extractConcatenatedLiteralText('cond ? getA() : getB()'), null);
});

// ── splitNullishOrOr / ?? and || fallback support ──────────────────────────────

test('splitNullishOrOr: splits on a top-level ??', () => {
    assert.deepEqual(splitNullishOrOr("KIND_LABEL[feature.kind] ?? 'New'"), ['KIND_LABEL[feature.kind] ', " 'New'"]);
});

test('splitNullishOrOr: splits on a top-level ||', () => {
    assert.deepEqual(splitNullishOrOr("getLabel() || 'Default'"), ['getLabel() ', " 'Default'"]);
});

test('splitNullishOrOr: returns null when there is no top-level ?? or ||', () => {
    assert.equal(splitNullishOrOr('getLabel()'), null);
});

test('splitNullishOrOr: does not split on ?? or || inside a nested call/bracket', () => {
    assert.equal(splitNullishOrOr("foo(a ?? b)"), null);
});

test('findHelperCallText: flags a text argument that is a ?? fallback to a literal', () => {
    // Regression: whatsnew/main.ts's el('span', 'feature-kind',
    // KIND_LABEL[feature.kind] ?? 'New') was invisible —
    // extractConcatenatedLiteralText only handled `+` concatenation and
    // ternaries, not a `??` fallback.
    const findings = findHelperCallText("el('span', 'feature-kind', KIND_LABEL[feature.kind] ?? 'New')");
    assert.equal(findings.length, 1);
    assert.match(findings[0].snippet, /New/);
});

test('extractConcatenatedLiteralText: resolves a || fallback to a literal', () => {
    const text = extractConcatenatedLiteralText("getLabel() || 'Default label'");
    assert.equal(text, 'Default label');
});

// ── findTextNodeCalls ────────────────────────────────────────────────────────

test('findTextNodeCalls: flags a hardcoded document.createTextNode() argument', () => {
    const findings = findTextNodeCalls("document.createTextNode(' By Editor')");
    assert.equal(findings.length, 1);
    assert.equal(findings[0].kind, 'createTextNode() argument');
});

test('findTextNodeCalls: does not flag a variable argument', () => {
    const findings = findTextNodeCalls('document.createTextNode(label)');
    assert.equal(findings.length, 0);
});

// ── findSetAttributeCalls ────────────────────────────────────────────────────

test('findSetAttributeCalls: flags a hardcoded title set via setAttribute', () => {
    const findings = findSetAttributeCalls("docLink.setAttribute('title', 'View official documentation')");
    assert.equal(findings.length, 1);
    assert.equal(findings[0].kind, "setAttribute('title') argument");
});

test('findSetAttributeCalls: flags a hardcoded aria-label set via setAttribute (double quotes)', () => {
    const findings = findSetAttributeCalls('el.setAttribute("aria-label", "Report this unknown path")');
    assert.equal(findings.length, 1);
    assert.equal(findings[0].kind, "setAttribute('aria-label') argument");
});

test('findSetAttributeCalls: does not flag an unrelated attribute name', () => {
    const findings = findSetAttributeCalls("el.setAttribute('data-file', 'Some hardcoded value here')");
    assert.equal(findings.length, 0);
});

test('findSetAttributeCalls: does not flag a variable value argument', () => {
    const findings = findSetAttributeCalls("el.setAttribute('title', someVariable)");
    assert.equal(findings.length, 0);
});

test('findSetAttributeCalls: a nested template in the value does not truncate the match', () => {
    const findings = findSetAttributeCalls("el.setAttribute('title', `outer ${fn(`inner`)} text`)");
    assert.equal(findings.length, 1);
    assert.match(findings[0].snippet, /outer/);
});

// ── scanFile ──────────────────────────────────────────────────────────────────

test('scanFile: dedupes identical findings across detectors', () => {
    const content = "el.title = 'Delete data';\nel.title = 'Delete data';";
    const findings = scanFile(content);
    // Both lines are distinct occurrences (different line numbers) so both are kept.
    assert.equal(findings.length, 2);
});

test('scanFile: restricts findings to allowed ranges when provided', () => {
    const content = [
        "class Foo {",
        "  private outsideHelper() { return '<div>Outside prose here</div>'; }",
        "  private getFooHtml(): string {",
        "    return `<div>Inside prose here</div>`;",
        '  }',
        '}',
    ].join('\n');
    const ranges = extractHtmlMethodRanges(content);
    assert.equal(ranges.length, 1);
    const findings = scanFile(content, ranges);
    assert.ok(findings.every((f) => /Inside prose here/.test(f.snippet)));
    assert.ok(!findings.some((f) => /Outside prose here/.test(f.snippet)));
});

// ── extractHtmlMethodRanges / isWithinRanges ─────────────────────────────────

test('extractHtmlMethodRanges: finds a get*Html method declaration and its body', () => {
    const content = [
        'class Foo {',
        '  private getDetailsHtml(webview: vscode.Webview): string {',
        "    return '<p>hi</p>';",
        '  }',
        '}',
    ].join('\n');
    const ranges = extractHtmlMethodRanges(content);
    assert.equal(ranges.length, 1);
    const [start, end] = ranges[0];
    assert.equal(content[start], '{');
    assert.equal(content[end], '}');
});

test('extractHtmlMethodRanges: does not treat a call site as a declaration', () => {
    const content = [
        'class Foo {',
        '  private getLoadingHtml(): string {',
        '    return this.getLoadingHtmlCssBase() + this.getLoadingHtmlBody("x");',
        '  }',
        '  private getLoadingHtmlCssBase(): string {',
        "    return '';",
        '  }',
        '  private getLoadingHtmlBody(nonce: string): string {',
        "    return '';",
        '  }',
        '}',
    ].join('\n');
    const ranges = extractHtmlMethodRanges(content);
    // Exactly the three declarations, not the two call sites inside getLoadingHtml's body.
    assert.equal(ranges.length, 3);
});

test('extractHtmlMethodRanges: handles multi-line parameter lists', () => {
    const content = [
        'class Foo {',
        '  private getDashboardHtml(',
        '    webview: vscode.Webview,',
        '    data: DashboardData,',
        '  ): string {',
        "    return '<p>hi</p>';",
        '  }',
        '}',
    ].join('\n');
    const ranges = extractHtmlMethodRanges(content);
    assert.equal(ranges.length, 1);
});

test('isWithinRanges: true only inside a range', () => {
    const ranges = [[10, 20], [30, 40]];
    assert.equal(isWithinRanges(15, ranges), true);
    assert.equal(isWithinRanges(25, ranges), false);
    assert.equal(isWithinRanges(35, ranges), true);
});

// ── buildMarkdownReport ───────────────────────────────────────────────────────

test('buildMarkdownReport: reports zero findings cleanly', () => {
    const md = buildMarkdownReport([], 0, 5);
    assert.match(md, /Files scanned: 5/);
    assert.match(md, /No hardcoded UI strings found\./);
});

test('buildMarkdownReport: renders a findings table with escaped snippet content', () => {
    const results = [{
        file: 'vscode-extension/src/webview/details/main.ts',
        findings: [{ line: 42, kind: '.textContent assignment', snippet: "el.textContent = 'a | b'" }],
    }];
    const md = buildMarkdownReport(results, 1, 1);
    assert.match(md, /Total candidate strings: 1/);
    assert.match(md, /\| 42 \| \.textContent assignment \| `el\.textContent = 'a \\\| b'` \|/);
});

// ── maskBlockComments ─────────────────────────────────────────────────────────

test('maskBlockComments: blanks a JSDoc example so it is not treated as real markup', () => {
    const src = [
        '/**',
        ' * Converts [text](url) to <a href="url" target="_blank">text</a>',
        ' */',
        'export function markdownToHtml() {}',
    ].join('\n');
    const masked = maskBlockComments(src);
    assert.doesNotMatch(masked, /<a href/);
    // Line/character positions must be unchanged.
    assert.equal(masked.length, src.length);
    assert.equal(masked.split('\n').length, src.split('\n').length);
    assert.match(masked, /export function markdownToHtml/);
});

test('maskBlockComments: does not touch code outside comments', () => {
    const src = "el.textContent = 'Refresh';";
    assert.equal(maskBlockComments(src), src);
});

test('maskBlockComments: does not corrupt a string literal that itself contains "/*"/"*/"', () => {
    // Regression: a naive /\/\*[\s\S]*?\*\//g regex would treat the literal
    // text inside this string as a real comment and blank out "Save changes".
    const src = "const html = '<div>/* text */Save changes</div>';";
    assert.equal(maskBlockComments(src), src);
});

test('maskBlockComments: still masks a real comment that sits next to a quote-like string', () => {
    const src = "/* comment */ el.textContent = 'Refresh';";
    const masked = maskBlockComments(src);
    assert.doesNotMatch(masked, /comment/);
    assert.match(masked, /el\.textContent = 'Refresh';/);
    assert.equal(masked.length, src.length);
});

test('maskBlockComments: a regex literal containing a quote character does not desync the scanner', () => {
    // Regression: `.replace(/"/g, '&quot;')` looks, to a naive char-by-char
    // scanner, like it opens an unterminated double-quoted string at the `"`
    // inside the regex. That stuck "still inside a string" state then
    // silently disabled comment masking for the rest of the file — a real
    // /** ... */ doc comment later in the file (containing example markup)
    // was never masked because the scanner still thought it was inside a
    // string when it reached the comment's "/*".
    const src = [
        "function escapeHtml(s) {",
        '  return s.replace(/"/g, "&quot;");',
        '}',
        '',
        '/**',
        ' * Converts [text](url) to <a href="url">text</a>',
        ' */',
        'export function markdownToHtml() {}',
    ].join('\n');
    const masked = maskBlockComments(src);
    assert.doesNotMatch(masked, /<a href/);
    assert.match(masked, /export function markdownToHtml/);
    assert.equal(masked.length, src.length);
});

test('maskBlockComments: a regex literal containing "/*"-like text does not open a fake comment', () => {
    const src = 'const re = /\\/\\*not a comment\\*\\//; const x = "keep me";';
    const masked = maskBlockComments(src);
    assert.equal(masked, src);
});

test('maskBlockComments: division is not mistaken for the start of a regex literal', () => {
    const src = 'const ratio = total / 2; const s = "keep me";';
    assert.equal(maskBlockComments(src), src);
});

test('maskBlockComments: a nested template literal inside ${...} does not desync the scanner', () => {
    // Regression: a template literal containing an interpolation whose
    // expression itself contains another template literal — extremely
    // common in this HTML-templating codebase, e.g.
    // `${attrBar('label', \`$${a} /M tokens\`, ...)}` — was misread as the
    // *outer* template ending at the first nested backtick. Everything after
    // that point was scanned as if it were plain code, and a "/" inside the
    // nested template's own text (e.g. "/M tokens") could then be
    // misidentified as opening a regex literal, corrupting comment masking
    // for the rest of the file.
    const src = [
        'function render() {',
        '  return `',
        '    ${attrBar(\'Model mix ($/token)\', `$${a.prev} → $${a.cur} /M tokens`, a.mixEffect)}',
        '  `;',
        '}',
        '',
        '/** A real doc comment with example markup: <a href="url">text</a> */',
        'export function next() {}',
    ].join('\n');
    const masked = maskBlockComments(src);
    assert.doesNotMatch(masked, /<a href/);
    assert.match(masked, /export function next/);
    assert.equal(masked.length, src.length);
});

test('maskBlockComments: a "}" inside a nested object literal in ${...} does not end the interpolation early', () => {
    const src = 'const html = `${fn({ a: 1, b: 2 })} rest`;\n/** doc <a href="url">text</a> */\nfunction f() {}';
    const masked = maskBlockComments(src);
    assert.doesNotMatch(masked, /<a href/);
    assert.match(masked, /function f/);
    assert.equal(masked.length, src.length);
});

// ── isRegexLiteralStart / findRegexLiteralEnd ────────────────────────────────

test('isRegexLiteralStart: true after an operator/punctuation that expects an expression', () => {
    assert.equal(isRegexLiteralStart('foo.replace('), true);
    assert.equal(isRegexLiteralStart('return '), true);
    assert.equal(isRegexLiteralStart(''), true);
});

test('isRegexLiteralStart: false after an identifier/number/closing bracket (division context)', () => {
    assert.equal(isRegexLiteralStart('total '), false);
    assert.equal(isRegexLiteralStart('foo() '), false);
    assert.equal(isRegexLiteralStart('a[0] '), false);
});

test('findRegexLiteralEnd: finds the closing slash and includes trailing flags', () => {
    const src = '/foo\\/bar/gi, rest';
    const end = findRegexLiteralEnd(src, 0);
    assert.equal(src.slice(0, end), '/foo\\/bar/gi');
});

test('findRegexLiteralEnd: a "/" inside a character class does not end the regex early', () => {
    const src = '/[a/b]/g, rest';
    const end = findRegexLiteralEnd(src, 0);
    assert.equal(src.slice(0, end), '/[a/b]/g');
});

test('scanFile: does not flag example markup inside a /** ... */ doc comment', () => {
    const src = [
        '/**',
        ' * Converts [text](url) to <a href="url" target="_blank" rel="noopener noreferrer">text</a>',
        ' */',
        "export function markdownToHtml() { return '<a>real text</a>'; }",
    ].join('\n');
    const findings = scanFile(maskBlockComments(src));
    assert.ok(!findings.some((f) => /target="_blank"/.test(f.snippet)));
    assert.ok(findings.some((f) => /real text/.test(f.snippet)));
});

// ── runMain (error-path contract) ────────────────────────────────────────────

test('runMain: an operational error is logged to stderr without changing the exit code contract', () => {
    const originalExitCode = process.exitCode;
    const originalConsoleError = console.error;
    process.exitCode = undefined;
    let logged = '';
    console.error = (...args) => { logged = args.join(' '); };
    try {
        runMain(() => { throw new Error('simulated unreadable file'); });
        assert.equal(process.exitCode, 0);
        assert.match(logged, /simulated unreadable file/);
    } finally {
        console.error = originalConsoleError;
        process.exitCode = originalExitCode;
    }
});

test('runMain: a normal (non-throwing) mainFn leaves exit code as it set it', () => {
    const originalExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
        runMain(() => { process.exitCode = 0; });
        assert.equal(process.exitCode, 0);
    } finally {
        process.exitCode = originalExitCode;
    }
});

// ── CLI smoke tests (the actual executable path) ─────────────────────────────
//
// Everything above tests the exported pure helpers directly; these two tests
// instead invoke the script exactly as a user/CI would, so a regression in
// main()'s wiring (argv parsing, console output, report writing) is caught
// even though it isn't itself an exported function. `--out` points the report
// at a scratch file in os.tmpdir() so running the suite leaves no report in
// the repo root.

function withTempReportPath(fn) {
    const tmpPath = path.join(os.tmpdir(), `scan-hardcoded-strings-test-${process.pid}-${Date.now()}.md`);
    try {
        fn(tmpPath);
    } finally {
        fs.rmSync(tmpPath, { force: true });
    }
}

test('CLI smoke test: normal mode exits 0, scans real files, and writes the report to --out', () => {
    withTempReportPath((tmpPath) => {
        const result = spawnSync(process.execPath, [SCRIPT_PATH, '--out', tmpPath], { encoding: 'utf8' });
        assert.equal(result.status, 0);
        assert.match(result.stdout, /Scanned \d+ file\(s\)/);
        assert.match(result.stdout, /Markdown report written to/);
        assert.ok(fs.existsSync(tmpPath));
        assert.match(fs.readFileSync(tmpPath, 'utf8'), /# Hardcoded UI Strings Inventory/);
    });
});

test('CLI smoke test: --json mode exits 0 and prints parseable JSON with the expected shape', () => {
    withTempReportPath((tmpPath) => {
        const result = spawnSync(process.execPath, [SCRIPT_PATH, '--json', '--out', tmpPath], { encoding: 'utf8' });
        assert.equal(result.status, 0);
        const parsed = JSON.parse(result.stdout);
        assert.equal(typeof parsed.total, 'number');
        assert.ok(Array.isArray(parsed.files));
    });
});
