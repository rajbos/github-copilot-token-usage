#!/usr/bin/env node
/**
 * Hardcoded UI string detector for the VS Code extension's webviews.
 *
 * Neither `validate-localization.js` nor `validate-l10n.mjs` can catch a plain
 * string literal written directly into UI-rendering code that never goes
 * through `localize(`/`t(`/`vscode.l10n.t(` at all — e.g.
 * `button.textContent = 'Refresh'` or `<h2>Usage Analysis</h2>` baked
 * straight into an HTML template literal. Both of those scripts only check
 * *consistency* of strings already wired through the localization system.
 * This script uses the TypeScript compiler API (not a blind regex scan) to
 * find literals sitting in a UI-rendering position instead.
 *
 * Scope:
 *   - vscode-extension/src/webview/**\/*.ts (all webview UI code)
 *   - vscode-extension/src/backend/configPanel.ts, src/backend/teamServerConfigPanel.ts, and
 *     src/loadingHtml.ts — whole files dedicated to building webview HTML outside src/webview/
 *   - vscode-extension/src/extension.ts, but only inside the `getXxxHtml`-style
 *     methods that build webview HTML (`^get[A-Za-z0-9_]*Html$`) — the rest of
 *     that 13k-line file is extension-host code with its own l10n conventions
 *     already covered by the other two scripts.
 *   - vscode-extension/src/insightsEngine.ts, but only inside `INSIGHT_CATALOG`,
 *     and under a rule of its own (see scanInsightCatalog) rather than the
 *     UI-rendering positions below — that file builds no HTML, so none of those
 *     sinks exist in it. Added with issue #2081, which localized the catalog;
 *     before that refactor this rule reported 360 violations there, all of
 *     which the refactor removed, so the file enters the ratchet with a clean
 *     slate and no baseline entries.
 *
 * What counts as a UI-rendering position:
 *   - `expr.textContent = '...'` / `.innerText` / `.innerHTML` / `.title` /
 *     `.placeholder`, via a plain `=` or a compound `+=` — the RHS may be a string/template
 *     literal, `cond ? 'A' : 'B'`, `'a' + x + 'b'` concatenation, or `x ?? 'Fallback'` /
 *     `x || 'Fallback'` (each static piece is checked independently; a non-literal operand like
 *     `x` correctly contributes nothing)
 *   - `{ textContent: '...' }` / `{ 'textContent': '...' }`-style object literal
 *     properties with the same names
 *   - known text-argument sinks: `el(tag, className, text)`, `iconHeading(tag, icon, text)`,
 *     `createButton(id, label, appearance?)`, `document.createTextNode(text)`,
 *     `setHtml(el, html)` (domUtils.ts's sanctioned `.innerHTML=` wrapper), and the shared webview
 *     card/badge wrappers that forward a fixed argument into one of the sinks above —
 *     `buildCard(id, label, value)`, `buildStatCard(label, value)`, `statusBadgeHtml(status, label?)`
 *   - `expr.setAttribute('aria-label'|'title'|'placeholder', value)`
 *   - `aria-label="..."` / `title="..."` / `placeholder="..."` attributes and text content
 *     between HTML tags (`<button>`, `<h1>`-`<h6>`, `<p>`, `<b>`, `<code>`, `<vscode-button>`, ...)
 *     embedded in any string or template literal (not just ones already known to be templates),
 *     with a template's `${...}` holes bridged so matches can span an interpolation, direct
 *     top-level text outside any tag (e.g. a raw HTML fragment concatenated with other markup
 *     before being handed to a sink), and a tag's own direct text found separately from any
 *     nested (tracked) element or HTML comment inside its body — recursion into nested markup is
 *     unbounded (not capped at one level), so content nested arbitrarily deep is still found, and
 *     each independent text run gets its own offset rather than being merged/blanked into one
 *     combined report
 *
 * Explicitly not flagged: console.log/warn/error/info/debug/trace arguments,
 * anything already an argument to `localize(`, `localizeFormat(`, `t(`,
 * `l10n.t(`, or `vscode.l10n.t(`, comments, import paths, and CSS/URL/class/
 * id/data-* values (those attribute names are never scanned).
 *
 * Known limitations — deliberate scope boundaries, not oversights (full data-flow / nested-
 * language parsing of arbitrary code is a different, much larger tool than this AST ratchet):
 *   1. A literal nested *inside* a template's `${...}` hole (e.g. a ternary whose branches are
 *      themselves template literals) is only checked against the sink positions above — if the
 *      hole itself sits inside an HTML tag in the *enclosing* template
 *      (`<vscode-button>${cond ? 'A' : `B (${x})`}</vscode-button>`), that enclosing tag context
 *      is not threaded through, so such a literal can still slip past.
 *   2. `src/backend/configPanel.ts`, `src/backend/teamServerConfigPanel.ts`, and
 *      `src/loadingHtml.ts` build large inline `<script>` bodies as plain TS string/template
 *      literals containing client-side JavaScript source. This script only sees those as opaque
 *      text (matching embedded HTML tags/attributes within them, same as any other literal) — it
 *      does not parse the JS *inside* the script tag as its own program, so a hardcoded
 *      `el.textContent = '...'`-shaped assignment written as part of that embedded script's
 *      source is invisible here. Only genuinely new occurrences of this shape count, since the
 *      baseline already covers what's there today, but it means this class of file is scanned
 *      for markup, not for the client-side logic embedded inside it.
 *   3. Sink recognition (TARGET_PROPS / TEXT_ARG_SINKS / ATTR_NAMES) is a fixed, explicit list of
 *      known property/function names, not a generic call-graph or taint analysis — a project
 *      helper that internally forwards a string argument into DOM text under a name not in that
 *      list (e.g. a `ButtonConfig.label` field consumed by some other rendering helper) is not
 *      automatically covered. Add the helper to the relevant list if it becomes a recurring
 *      source of missed strings; this script intentionally does not attempt to discover such
 *      helpers on its own.
 *   4. TAG_TEXT_RE (and NESTED_ELEMENT_OR_COMMENT_RE) stop at the *nearest* matching closing tag,
 *      not a properly balanced one — regex fundamentally cannot count arbitrary nesting depth for
 *      a repeated same-name pair (this is the same class of problem as matching balanced
 *      parentheses, which is provably not a regular language). So a tag nested directly inside
 *      another tag of the *same* name (`<div><div>Inner</div> Outer</div>`) has its outer match
 *      end at the inner tag's own close, and text after that (`Outer`) is never seen as anything.
 *      A correct general fix needs a real stack-based tokenizer, not another regex tweak — this
 *      is a boundary, not a queue of one-off patches waiting to happen.
 *   5. A `// i18n-exempt` comment is checked against the specific source line a violation is
 *      reported on (or the line directly above it) — never against the line the *enclosing*
 *      literal/statement starts on. This works cleanly for a single-line literal (a real comment
 *      can sit right above or beside it) and for a genuinely multi-line *expression* built from
 *      several separate literals — e.g. concatenation, where a real comment can precede any one
 *      operand on its own line. It does NOT work for a specific inner line of a *multiline
 *      template literal*'s own backtick content: a `//` appearing there is part of the string's
 *      rendered text, never a real TypeScript comment (see the round-4 fixture verifying exactly
 *      this is not a bypass), so there is no source position from which such a comment could ever
 *      be checked. The allowlist is the only escape hatch for that shape.
 * Use the `// i18n-exempt` / allowlist escape hatches or a manual audit for any of these shapes.
 *
 * Escape hatches for a legitimate new literal:
 *   1. An inline `// i18n-exempt: <reason>` comment on the same line as the reported text, or the
 *      line immediately above it. Only reaches text that can have a real comment next to it — see
 *      limitation 5 above for why a multiline template literal's own inner content cannot.
 *   2. An exact-match entry in `hardcoded-strings-allowlist.json` (this
 *      folder), for literals that are hard to annotate inline — required for a multiline template
 *      literal's inner text, per limitation 5.
 *
 * Baseline / ratchet:
 *   This check does not try to fix today's existing violations — it only
 *   stops new ones. `hardcoded-strings-baseline.json` records every violation
 *   that already existed when it was generated, keyed by file path + a hash
 *   of the *offending source line's trimmed content* (not the line number, so
 *   the baseline survives unrelated line-number drift), together with how
 *   many times that exact (file, hash) occurred. A file+hash existing in the
 *   baseline is not a blanket pass: only that many occurrences (in scan
 *   order) are treated as pre-existing — a genuinely new violation whose line
 *   happens to hash identically to an already-baselined one (e.g. an
 *   identical line copied elsewhere in the same file) still fails once the
 *   baselined count is exceeded. See newIndexesBeyondBaseline.
 *
 * Usage:
 *   node scripts/check-hardcoded-strings.mjs                 # check mode (CI)
 *   node scripts/check-hardcoded-strings.mjs --update-baseline # regenerate baseline
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import ts from 'typescript';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const extRoot = path.resolve(scriptDir, '..');
const repoRoot = path.resolve(extRoot, '..');
const webviewDir = path.join(extRoot, 'src', 'webview');
const extensionTsPath = path.join(extRoot, 'src', 'extension.ts');
// Whole files outside src/webview/ and extension.ts that are entirely dedicated to building
// webview HTML (unlike extension.ts's mix of concerns, these don't need a method-name filter).
const EXTRA_FULL_SCAN_FILES = [
	path.join(extRoot, 'src', 'backend', 'configPanel.ts'),
	path.join(extRoot, 'src', 'backend', 'teamServerConfigPanel.ts'),
	path.join(extRoot, 'src', 'loadingHtml.ts'),
];
// The personalized-insights catalog (issue #2081). Unlike every other scanned
// file this one renders no HTML at all — its user-facing strings are plain
// object properties and `buildBody` return values, which none of the DOM/markup
// sinks above can see. It gets its own rule in scanInsightCatalog() instead.
const insightsEnginePath = path.join(extRoot, 'src', 'insightsEngine.ts');
const INSIGHT_CATALOG_NAME = 'INSIGHT_CATALOG';
// Calls whose string arguments are localization keys, not display text.
const INSIGHT_KEY_CALLS = new Set(['translate', 'plural']);
// Catalog properties holding machine values — ids, VS Code command ids, enum
// members and the `*Key` fields, which are nls keys by construction.
const INSIGHT_NON_TEXT_PROPS = new Set([
	'id', 'category', 'severity', 'actionCommand', 'secondaryActionCommand',
	'titleKey', 'actionLabelKey', 'secondaryActionLabelKey',
]);
const baselinePath = path.join(scriptDir, 'hardcoded-strings-baseline.json');
const allowlistPath = path.join(scriptDir, 'hardcoded-strings-allowlist.json');

const HTML_METHOD_NAME_RE = /^get[A-Za-z0-9_]*Html$/;
const TARGET_PROPS = new Set(['textContent', 'innerText', 'innerHTML', 'title', 'placeholder']);
const TAGS = [
	'button', 'label', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'span',
	'td', 'th', 'option', 'summary', 'caption', 'div', 'a', 'li', 'legend',
	'strong', 'em', 'small', 'dt', 'dd', 'figcaption', 'title', 'b', 'code', 'pre',
	'text', // SVG <text> element (e.g. chart axis labels), not to be confused with the "text" attribute name
	'vscode-button', 'vscode-badge', 'vscode-checkbox', 'vscode-dropdown',
	'vscode-link', 'vscode-option', 'vscode-text-field'
];
// Body is matched non-greedily up to the nearest same-name closing tag rather than `[^<]+`, so a
// body containing nested markup (e.g. an icon <span> before trailing text) still matches instead
// of failing outright — see scanFlattenedForTagText for how the nested content is then handled.
const TAG_TEXT_RE = new RegExp(`<(${TAGS.join('|')})(?:\\s[^>]*)?>([\\s\\S]*?)</\\1>`, 'gi');
const NESTED_TAG_RE = /<[a-zA-Z]/;
// Like NESTED_TAG_RE but also matches a bare CLOSING tag start (`</button`). Used where a fragment
// is being checked for "is this markup, not prose" rather than "does this contain a nested
// element" — a concatenated HTML-bearing sink can hand reportAt a lone closing-tag piece (e.g.
// `setHtml(root, '<button>' + label + '</button>')`'s third operand), and NESTED_TAG_RE alone
// wouldn't recognize `</button>` as markup, letting "button" itself trip looksProse() as if it
// were prose.
const HTML_TAG_FRAGMENT_RE = /<\/?[a-zA-Z]/;
const ATTR_NAMES = ['aria-label', 'title', 'placeholder'];
// getStaticChunks() slices the raw TS source text, not the "cooked" string value — so a plain
// double-quoted TS string wrapping a double-quoted HTML attribute has its inner quotes escaped
// (`aria-label=\"Refresh\"`) exactly as written in the source. The optional `\\?` before each
// quote tolerates that escaping (a single-quoted TS string wrapping the same attribute needs no
// escaping and matches either way).
const ATTR_RE = new RegExp(`(?<![\\w-])(?:${ATTR_NAMES.join('|')})\\s*=\\s*\\\\?(["'])((?:(?!\\\\?\\1)[\\s\\S])*)\\\\?\\1`, 'gi');

// Functions where a specific (0-based) argument position holds display text, mirroring
// TARGET_PROPS but for call-based sinks instead of property assignment — e.g. domUtils.ts's
// `el(tag, className, text)` and `iconHeading(tag, icon, text, className)` helpers.
const TEXT_ARG_SINKS = new Map([
	['el', 2],
	['iconHeading', 2],
	['createButton', 1], // createButton(id, label, appearance?) legacy positional form; the config-object form isn't covered
	['document.createTextNode', 0],
	['setHtml', 1], // domUtils.ts's sanctioned innerHTML= wrapper — same "HTML-bearing" handling as .innerHTML below
	['buildCard', 1], // chart/main.ts: buildCard(id, label, value) — label forwarded into el(..., label)
	['buildStatCard', 0], // dashboard/main.ts: buildStatCard(label, value) — label forwarded into el(..., label)
	['statusBadgeHtml', 1], // usage/main.ts: statusBadgeHtml(status, label?) — label used as an aria-label/title attribute value
]);

// Sinks whose value is markup (raw HTML), not plain text, mirroring TARGET_PROPS' `innerHTML`.
// When such a value already contains a recognizable tag, the generic per-literal tag/attribute
// scan (scanHtmlLiteralForTags, run on every string/template literal regardless of context)
// independently reports the meaningful sub-pieces already — reporting the whole raw markup blob
// here too would double-count the same UI text as two separate CI errors/baseline entries.
const HTML_BEARING_SINKS = new Set(['setHtml']);
const HTML_BEARING_PROPS = new Set(['innerHTML']);

// \p{L}: at least one Unicode-letter run, so non-Latin UI text (e.g. Chinese, Japanese) is
// treated as prose too, not just ASCII — this extension ships zh-CN localization.
const LETTER_RUN_RE = /\p{L}{2,}/u;
const URL_SCHEME_RE = /^(?:[a-z][a-z0-9+.-]*:)?\/\//i;
const URL_PROTOCOL_RE = /^(https?|mailto|data|vscode-resource|vscode-webview|command):/i;
const CSS_UNIT_VALUE_RE = /^-?\d+(\.\d+)?(px|em|rem|ex|ch|vh|vw|vmin|vmax|pt|pc|in|cm|mm|deg|rad|grad|turn|s|ms|fr|%)$/i;
const HEX_COLOR_RE = /^#[0-9a-f]{3,8}$/i;
const CSS_FUNC_RE = /^(rgba?|hsla?|var|url|linear-gradient|radial-gradient|calc|cubic-bezier)\(/i;
const KEBAB_IDENTIFIER_RE = /^[a-z][a-z0-9]*(-[a-z0-9]+)+$/;
const CAMEL_IDENTIFIER_RE = /^[a-z]+(?:[A-Z][a-z0-9]*)+$/;

/** True if `text` looks like translatable prose rather than a number, CSS value, URL, or bare identifier/class token. */
export function looksProse(text) {
	if (!text) { return false; }
	if (!LETTER_RUN_RE.test(text)) { return false; }
	if (URL_SCHEME_RE.test(text) || URL_PROTOCOL_RE.test(text)) { return false; }
	if (CSS_UNIT_VALUE_RE.test(text) || HEX_COLOR_RE.test(text) || CSS_FUNC_RE.test(text)) { return false; }
	if (KEBAB_IDENTIFIER_RE.test(text)) { return false; }
	if (CAMEL_IDENTIFIER_RE.test(text) && !text.includes(' ')) { return false; }
	return true;
}

/** Recursively collect files under `dir` matching `extensions`. */
function collectFiles(dir, extensions) {
	const results = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			results.push(...collectFiles(full, extensions));
		} else if (extensions.some((ext) => entry.name.endsWith(ext)) && !entry.name.endsWith('.test.ts')) {
			results.push(full);
		}
	}
	return results;
}

/** Builds the dotted callee name (e.g. "l10n.t", "vscode.l10n.t") for a simple identifier/property-access chain, or null if it's not a simple chain (computed access, call result, etc). */
function getCalleeChainText(expr) {
	if (ts.isIdentifier(expr)) { return expr.text; }
	if (ts.isPropertyAccessExpression(expr)) {
		const left = getCalleeChainText(expr.expression);
		return left === null ? null : `${left}.${expr.name.text}`;
	}
	return null;
}

const LOCALIZATION_CALLS = new Set(['localize', 'localizeFormat', 't', 'l10n.t', 'vscode.l10n.t']);
export function isLocalizationCall(chain) {
	return chain !== null && LOCALIZATION_CALLS.has(chain);
}

const CONSOLE_CALL_RE = /^console\.(log|warn|error|info|debug|trace)$/;
export function isConsoleCall(chain) {
	return chain !== null && CONSOLE_CALL_RE.test(chain);
}

function unwrapParens(node) {
	let n = node;
	while (n && ts.isParenthesizedExpression(n)) { n = n.expression; }
	return n;
}

const LITERAL_LEAF_BINARY_OPS = new Set([
	ts.SyntaxKind.PlusToken, // string concatenation: 'Parsing ' + total + ' files' — checks each static piece
	ts.SyntaxKind.QuestionQuestionToken, // x ?? 'Fallback'
	ts.SyntaxKind.BarBarToken, // x || 'Fallback'
]);

/**
 * Extracts every static string/template literal leaf reachable from `node` without crossing a
 * function or a non-literal expression — so `cond ? 'A' : 'B'` (and nested conditionals in either
 * branch), `'a' + x + 'b'` concatenation, and `x ?? 'Fallback'` / `x || 'Fallback'` all yield their
 * static piece(s) instead of only checking whichever the whole RHS "is" (or nothing at all, for a
 * composed expression this doesn't recognize — e.g. a non-literal `x + y`, which correctly
 * contributes no literal). Used everywhere a literal in a UI-rendering position is checked
 * (assignment target, sink argument).
 *
 * `htmlBearing` (true only for a value flowing into `.innerHTML =` / `setHtml(...)`) filters out a
 * literal's *own* static chunks when they read as markup, deferring to the generic HTML tag/
 * attribute scan instead of double-reporting. This is decided from ALL of a template's static
 * chunks combined, not each chunk in isolation — a `${...}`-bearing template splits its static
 * text into several chunks, and a chunk landing between two holes (e.g. the
 * `;margin-bottom:12px;">` piece of `` `<div style="color:${c};margin-bottom:12px;">${label}</div>` ``)
 * can contain no `<` of its own even though the literal as a whole is unambiguously markup —
 * testing it in isolation both reports that CSS/attribute fragment as false-positive prose and,
 * in the mirror case, fails to skip a chunk like `<span>Hardcoded ` that never closes within its
 * own chunk. The combined check does NOT extend into a literal nested *inside* an interpolation
 * hole (the recursive call below) — a ternary/fallback sitting in a hole is judged on its own
 * text, independent of whatever markup surrounds the hole in the enclosing template, so
 * `` `<div>${cond ? 'Refresh' : 'Retry'}</div>` `` still reports its branches.
 */
function extractLiteralTexts(node, sourceFile, htmlBearing = false) {
	const n = unwrapParens(node);
	if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateExpression(n)) {
		// One entry per static chunk (not one combined string for a TemplateExpression) — a
		// multiline `` `${x}\n  Refresh` `` must attribute its report to Refresh's own line, not
		// the template's opening line, or a baseline hash and an `// i18n-exempt` placed next to
		// Refresh both silently apply to the wrong line.
		const chunkResults = getStaticChunks(n, sourceFile).map((chunk) => {
			// A template-tail/-middle chunk's raw text starts right after the closing `}` of the
			// previous interpolation, typically with a leading newline/indentation — e.g. for
			// `` `${label}\n  Refresh` ``, the tail's own text is "\n  Refresh" starting at the `}`.
			// Without skipping that, the reported offset resolves to the *previous* line (the one
			// with `${label}`), not Refresh's own line. LEADING_SKIP_RE (whitespace, defined below)
			// covers this; it also tolerates HOLE_PLACEHOLDER even though these are raw (non-
			// flattened) chunks where that string can't actually occur.
			const leadingSkip = chunk.text.match(LEADING_SKIP_RE)[0].length;
			return { text: chunk.text, offset: chunk.offset + leadingSkip };
		});
		const isMarkup = htmlBearing && HTML_TAG_FRAGMENT_RE.test(chunkResults.map((r) => r.text).join(''));
		const ownResults = isMarkup ? [] : chunkResults;
		if (!ts.isTemplateExpression(n)) { return ownResults; }
		// Also recurse into each interpolation hole's own expression — a hole that's itself a
		// ternary/concatenation/fallback (e.g. `` `${cond ? 'Refresh' : 'Retry'}` `` used directly
		// as a sink argument) has leaf literals of its own that the static chunks above never see.
		const spanResults = n.templateSpans.flatMap((span) => extractLiteralTexts(span.expression, sourceFile, htmlBearing));
		return [...ownResults, ...spanResults];
	}
	if (ts.isConditionalExpression(n)) {
		return [...extractLiteralTexts(n.whenTrue, sourceFile, htmlBearing), ...extractLiteralTexts(n.whenFalse, sourceFile, htmlBearing)];
	}
	if (ts.isBinaryExpression(n) && LITERAL_LEAF_BINARY_OPS.has(n.operatorToken.kind)) {
		return [...extractLiteralTexts(n.left, sourceFile, htmlBearing), ...extractLiteralTexts(n.right, sourceFile, htmlBearing)];
	}
	return [];
}

/**
 * Splits a string/template literal into its raw static text chunks (skipping `${...}` holes for
 * a template expression; a plain string or no-substitution template yields exactly one chunk),
 * each tagged with its absolute source offset.
 */
function getStaticChunks(node, sourceFile) {
	const raw = sourceFile.text;
	const chunks = [];
	function push(literalNode, prefixLen, suffixLen) {
		const start = literalNode.getStart(sourceFile);
		const end = literalNode.getEnd();
		chunks.push({ text: raw.slice(start + prefixLen, end - suffixLen), offset: start + prefixLen });
	}
	if (ts.isStringLiteral(node)) {
		push(node, 1, 1); // '...' or "..."
	} else if (ts.isNoSubstitutionTemplateLiteral(node)) {
		push(node, 1, 1); // `...`
	} else if (ts.isTemplateExpression(node)) {
		push(node.head, 1, 2); // `...${
		for (const span of node.templateSpans) {
			if (ts.isTemplateTail(span.literal)) {
				push(span.literal, 1, 1); // }...`
			} else {
				push(span.literal, 1, 2); // }...${
			}
		}
	}
	return chunks;
}

// Bridges a template's `${...}` holes with a neutral, bracket/quote-free marker so tag/attribute
// regexes can match text that spans an interpolation (e.g. `<span>${x} turns</span>`) instead of
// only seeing whichever side of the hole happens to share a chunk with the tag delimiter.
const HOLE_PLACEHOLDER = '‹…›'; // ‹…›
// Skips whitespace AND (repeats of) the interpolation placeholder itself before computing a run's
// offset — a run beginning right after a `${...}` hole (e.g. `<button>${count}\n  Refresh</button>`)
// otherwise has its offset anchored to the hole's own position (the end of the *previous* static
// chunk), not the line the real text is actually on.
const LEADING_SKIP_RE = new RegExp(`^(?:\\s|${HOLE_PLACEHOLDER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})*`);

/** Concatenates static chunks into one flat string (holes bridged by HOLE_PLACEHOLDER), plus a
 * segment map for translating a flat-text index back to an absolute source offset. */
function flattenChunks(chunks) {
	let text = '';
	const segments = [];
	chunks.forEach((chunk, i) => {
		segments.push({ flatStart: text.length, sourceOffset: chunk.offset, length: chunk.text.length });
		text += chunk.text;
		if (i < chunks.length - 1) { text += HOLE_PLACEHOLDER; }
	});
	return { text, segments };
}

/** Maps an index into flattened chunk text back to an absolute source offset, clamping into the nearest chunk if the index falls inside a placeholder. */
function mapFlatIndexToSourceOffset(index, segments) {
	let seg = segments[0];
	for (const s of segments) {
		if (s.flatStart <= index) { seg = s; } else { break; }
	}
	const within = Math.min(Math.max(index - seg.flatStart, 0), seg.length);
	return seg.sourceOffset + within;
}

// Requires "i18n-exempt" to be the first thing in the comment's content (after the `//` or `/*`
// delimiter and optional whitespace), matching the documented `// i18n-exempt: <reason>` contract
// — not merely mentioned anywhere in a longer comment, e.g. `// not i18n-exempt` or `// see the
// i18n-exempt convention above` must NOT grant an exemption.
const EXEMPT_MARKER_RE = /^(?:\/\/|\/\*)\s*i18n-exempt\b/i;

/**
 * Collects the 0-based source lines spanned by every REAL comment (// or /* *\/) in `sourceFile`
 * whose text contains "i18n-exempt", using the TypeScript scanner in trivia mode (skipTrivia:
 * false) rather than matching against raw line text. This is deliberate, not a style choice: a
 * naive line-text regex can't distinguish an actual comment from the same characters appearing
 * inside a string/template literal's own value — e.g. a template literal building
 * `<button>...</button>` markup whose rendered text happens to *contain* the substring
 * "// i18n-exempt: reason" would previously suppress its own violation, even though that text
 * renders to users and never was a comment. The scanner correctly treats string/template literal
 * bodies as opaque token text, so a marker inside one is never mistaken for a comment.
 */
function findExemptCommentLines(sourceFile) {
	const lines = new Set();
	const scanner = ts.createScanner(ts.ScriptTarget.Latest, /* skipTrivia */ false, ts.LanguageVariant.Standard, sourceFile.text);
	let kind = scanner.scan();
	while (kind !== ts.SyntaxKind.EndOfFileToken) {
		if (kind === ts.SyntaxKind.SingleLineCommentTrivia || kind === ts.SyntaxKind.MultiLineCommentTrivia) {
			if (EXEMPT_MARKER_RE.test(scanner.getTokenText())) {
				const startLine = ts.getLineAndCharacterOfPosition(sourceFile, scanner.getTokenPos()).line;
				const endLine = ts.getLineAndCharacterOfPosition(sourceFile, scanner.getTextPos()).line;
				for (let l = startLine; l <= endLine; l++) { lines.add(l); }
			}
		}
		kind = scanner.scan();
	}
	return lines;
}

/** True if the source line at `line` (1-based), or the line before it, falls within a real `i18n-exempt` comment. */
function isExemptByInlineComment(ctx, line) {
	return ctx.exemptCommentLines.has(line - 1) || ctx.exemptCommentLines.has(line - 2);
}

function loadAllowlist() {
	if (!fs.existsSync(allowlistPath)) { return new Set(); }
	const data = JSON.parse(fs.readFileSync(allowlistPath, 'utf8'));
	const list = Array.isArray(data) ? data : (Array.isArray(data.allow) ? data.allow : []);
	return new Set(list);
}

/** Records a candidate violation at an absolute source offset, applying the looksProse filter and both escape hatches. */
function reportAt(rawText, offset, ctx, reason) {
	const trimmed = rawText.trim();
	if (!looksProse(trimmed)) { return; }
	if (ctx.allowlist.has(trimmed)) { return; }
	const line = ts.getLineAndCharacterOfPosition(ctx.sourceFile, offset).line + 1;
	if (isExemptByInlineComment(ctx, line)) { return; }
	ctx.violations.push({ file: ctx.relFile, line, offset, text: trimmed, reason });
}

function checkAssignmentTarget(propName, valueNode, ctx, reasonPrefix) {
	if (!propName || !TARGET_PROPS.has(propName)) { return; }
	const htmlBearing = HTML_BEARING_PROPS.has(propName);
	// tag-bearing markup is left for the generic literal scan to avoid double-reporting the same
	// text — extractLiteralTexts itself decides that per-literal (combined across a template's
	// static chunks, not each chunk in isolation; see its doc comment).
	for (const literal of extractLiteralTexts(valueNode, ctx.sourceFile, htmlBearing)) {
		reportAt(literal.text, literal.offset, ctx, `${reasonPrefix}${propName}`);
	}
}

function scanFlattenedForAttributes(text, segments, ctx) {
	// matchAll clones the regex internally rather than mutating ATTR_RE.lastIndex, so this is
	// safe to call while another scan of the same shared regex is in progress (see
	// scanFlattenedForTagText's recursion for why that distinction matters here).
	for (const m of text.matchAll(ATTR_RE)) {
		const value = m[2];
		const quote = m[1];
		// The match's closing delimiter is either just the quote (1 char) or an escaped quote (the
		// `\\?` tolerance added for escaped-attribute source text — 2 chars); measure which one
		// actually terminated this match instead of assuming a fixed length.
		const closingLen = m[0].endsWith(`\\${quote}`) ? 2 : 1;
		const valueOffsetInMatch = m[0].length - closingLen - value.length;
		// Reuse reportOwnTextRuns (the same splitting tag text already gets) rather than reporting
		// the whole captured value as one violation: an attribute value can itself contain multiple
		// `${...}` holes with static prose on both sides (e.g. `aria-label="${a} label ${b}"`), and
		// treating that as a single combined run would anchor the whole thing to its first line —
		// unchanged even when only the text after a later hole is edited — the same combined-blob
		// bug already fixed for tag text runs in round 8.
		reportOwnTextRuns(value, m.index + valueOffsetInMatch, segments, ctx, 'HTML attribute (aria-label/title/placeholder)');
	}
}

/**
 * Scans `text` (a slice of the flattened literal starting at `textOffsetInFlat`) for tag-text
 * matches. A body containing nested markup — e.g. `<button><span class="icon"></span>
 * Corrections</button>` — is recursed into (to any depth — see the call below, unbounded) so a
 * nested (tracked) tag's own text is still separately caught, while the outer tag's own direct
 * text is reported via `splitOwnTextRuns`, which excludes each nested element's or comment's
 * *entire* span rather than requiring the whole body to be nesting-free — so nothing is
 * double-counted between the recursive call and the outer tag's own runs.
 */
// Matches a *complete* nested element (any tag name — not just ones in TAGS — open through its
// nearest matching close) or an HTML comment, as one unit. Used to carve a tag's own direct text
// runs out of its body: excluding the nested element's full span (not just its `<tag>`/`</tag>`
// delimiters) means its inner content is never re-reported as if it were the outer tag's own text
// (recursion below already reports it separately, once, if it's itself a tracked tag).
const NESTED_ELEMENT_OR_COMMENT_RE = /<!--[\s\S]*?-->|<([a-zA-Z][a-zA-Z0-9-]*)(?:\s[^>]*)?>[\s\S]*?<\/\1>|<[^>]*>/g;
// Same as NESTED_ELEMENT_OR_COMMENT_RE, but also treats an interpolation hole as its own excluded
// unit — used only for splitting a body into independent runs (see splitOwnTextRuns below), not
// for the top-level "does this contain real markup" gate in scanHtmlLiteralForTags, since a hole
// alone isn't markup. Without this, static prose on both sides of a `${...}` hole in the same tag
// body (e.g. `<button>Prefix ${count}\n  Refresh</button>`) is treated as one combined run anchored
// to the *first* side's line, so a later edit to only the second side's text reuses the unchanged
// first line's baseline hash and bypasses the ratchet.
const RUN_BOUNDARY_RE = new RegExp(
	`${NESTED_ELEMENT_OR_COMMENT_RE.source}|${HOLE_PLACEHOLDER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`,
	'g'
);

/**
 * Splits a tag's body into its own direct-text runs — the parts not inside some nested element,
 * comment, or interpolation hole — each tagged with its own offset in the flattened text.
 * Reporting each run separately (rather than collapsing the whole body into one combined,
 * nested-markup-blanked string) matters for the baseline's line-based hashing: a body with an
 * already-baselined run on one line and a later, genuinely new run added on another line must
 * produce two independently-hashed violations, not one combined report still anchored to the
 * first (unchanged) line.
 */
function splitOwnTextRuns(body, bodyStartInFlat) {
	const runs = [];
	let lastIndex = 0;
	for (const m of body.matchAll(RUN_BOUNDARY_RE)) {
		if (m.index > lastIndex) {
			runs.push({ text: body.slice(lastIndex, m.index), offsetInFlat: bodyStartInFlat + lastIndex });
		}
		lastIndex = m.index + m[0].length;
	}
	if (lastIndex < body.length) {
		runs.push({ text: body.slice(lastIndex), offsetInFlat: bodyStartInFlat + lastIndex });
	}
	return runs;
}

// Matches a complete HTML comment. Used to blank out comment bodies (replacing their characters
// with same-length spaces, so offsets stay aligned) before TAG_TEXT_RE ever runs — otherwise a tag
// name typed inside a commented-out snippet (e.g. `<!-- <span>Refresh</span> -->`, which never
// renders) is indistinguishable from a real nested element and gets reported as UI text.
const HTML_COMMENT_RE = /<!--[\s\S]*?-->/g;
function blankHtmlComments(text) {
	return text.replace(HTML_COMMENT_RE, (m) => ' '.repeat(m.length));
}

function scanFlattenedForTagText(text, textOffsetInFlat, segments, ctx) {
	// `text` is expected to already have HTML comments blanked by the caller (scanHtmlLiteralForTags
	// blanks once, up front, before any scan runs) — a recursive call here passes a `body` substring
	// that inherits that blanking, so no re-blanking is needed at this level.
	// matchAll (not a manual exec()/lastIndex loop) is required here: this function recurses into
	// a nested tag's body using the SAME shared TAG_TEXT_RE object, and exec() mutates that
	// object's .lastIndex as shared state — the recursive call would corrupt the outer loop's
	// position in `text` and either skip content or (as originally shipped) loop forever
	// re-matching the same span. matchAll clones the regex per call, so recursion is safe.
	for (const m of text.matchAll(TAG_TEXT_RE)) {
		const tag = m[1].toLowerCase();
		const body = m[2];
		const bodyStartInFlat = textOffsetInFlat + m.index + m[0].indexOf('>') + 1;

		// Recurse into a body with further nested (tracked) markup to also catch its own text, to
		// any depth — unbounded is safe here since each recursive call operates on `body`, which is
		// always strictly shorter than `text` (it excludes at least the enclosing tag's own
		// delimiters), guaranteeing termination without an artificial depth cap that would otherwise
		// silently drop content nested more than one level deep (e.g. <button><span><strong>Refresh
		// </strong></span></button>).
		if (NESTED_TAG_RE.test(body)) {
			scanFlattenedForTagText(body, bodyStartInFlat, segments, ctx);
		}

		reportOwnTextRuns(body, bodyStartInFlat, segments, ctx, `<${tag}> text content`);
	}
}

/** Splits `body` into its direct-text runs via splitOwnTextRuns and reports each at its own offset (skipping leading whitespace/interpolation-placeholder first — see the callers' comments for why). */
function reportOwnTextRuns(body, bodyStartInFlat, segments, ctx, reason) {
	for (const run of splitOwnTextRuns(body, bodyStartInFlat)) {
		// Skip leading whitespace: a multiline `<button>\n  Refresh\n</button>` otherwise
		// attributes the violation to the line right after `>` (a blank/whitespace-only line)
		// instead of the line the reportable text actually sits on, so the baseline hashes the
		// wrong line. Also skips HOLE_PLACEHOLDER, for a run beginning right after an
		// interpolation hole.
		const leadingSkip = run.text.match(LEADING_SKIP_RE)[0].length;
		const runOffset = mapFlatIndexToSourceOffset(run.offsetInFlat + leadingSkip, segments);
		reportAt(run.text, runOffset, ctx, reason);
	}
}

/**
 * Scans a string/template literal (plain strings included, not just template literals) for
 * embedded HTML tag text and aria-label/title/placeholder attributes, bridging `${...}` holes so
 * matches can span an interpolation. Also reports direct text sitting *outside* any matched tag at
 * the top level of the literal — e.g. a raw HTML fragment like `'<span class="icon"></span>
 * Insights'` (built to be concatenated with other markup before reaching a sink such as
 * `setHtml`) has "Insights" outside any wrapping element of its own; `reportOwnTextRuns` on the
 * whole literal excludes the fully-matched `<span>...</span>` (same as it would inside a tag's
 * body) and reports what's left, without duplicating what scanFlattenedForTagText already finds
 * inside actual tags.
 */
function scanHtmlLiteralForTags(node, ctx) {
	const chunks = getStaticChunks(node, ctx.sourceFile);
	if (chunks.length === 0) { return; }
	const { text: rawText, segments } = flattenChunks(chunks);
	// Blank HTML comments once, up front, before either scan runs — otherwise a commented-out
	// fragment (e.g. `<!-- <button aria-label="Refresh"></button> -->`, which never renders) can
	// still trip the attribute scan even though scanFlattenedForTagText's own comment-blanking
	// (see HTML_COMMENT_RE) already protects the tag-text path.
	const text = blankHtmlComments(rawText);
	scanFlattenedForAttributes(text, segments, ctx);
	scanFlattenedForTagText(text, 0, segments, ctx);
	// This call runs on EVERY string/template literal in scope via walk(), including plain prose
	// with no markup at all (e.g. 'Refresh', a URL, a multiline template used directly as an
	// assignment/sink value) and non-HTML sentinel strings that merely start with `<letter` (e.g.
	// '<unresolved:', a workspace-path placeholder). Those are either already fully handled by the
	// assignment/sink-specific paths (checkAssignmentTarget, checkTextArgSink,
	// checkSetAttributeSink) or aren't markup at all, so the gate below requires an actual complete
	// nested element or HTML comment for splitOwnTextRuns to exclude — a loose "looks like a tag"
	// check (any `<letter`, with no closing `>` required) would both double-report the former and
	// misclassify the latter as markup.
	//
	// The presence check itself must run against `rawText` (before comment-blanking), not `text` —
	// a literal that's *only* a comment plus trailing prose (e.g. `'<!-- section --> Refresh'`, no
	// other real tag) has nothing left for NESTED_ELEMENT_OR_COMMENT_RE to match once its comment
	// is already blanked to spaces, so the gate would wrongly conclude there's no markup here at
	// all and skip reporting the visible "Refresh". reportOwnTextRuns itself still runs on the
	// blanked `text`, so the (non-rendering) comment's own content is correctly excluded rather
	// than misread as real markup.
	if (!rawText.matchAll(NESTED_ELEMENT_OR_COMMENT_RE).next().done) {
		reportOwnTextRuns(text, 0, segments, ctx, 'text content (outside any tag)');
	}
}

/** `el(tag, className, text)` / `iconHeading(tag, icon, text, className)`-style calls where a fixed argument position holds display text. `setHtml(el, html)` is markup-bearing like `.innerHTML =` (see HTML_BEARING_SINKS): a tag-bearing value is left for the generic literal scan to avoid double-reporting the same text. */
function checkTextArgSink(node, chain, ctx) {
	const argIndex = TEXT_ARG_SINKS.get(chain);
	if (argIndex === undefined || node.arguments.length <= argIndex) { return; }
	const htmlBearing = HTML_BEARING_SINKS.has(chain);
	for (const literal of extractLiteralTexts(node.arguments[argIndex], ctx.sourceFile, htmlBearing)) {
		reportAt(literal.text, literal.offset, ctx, `${chain}() text argument`);
	}
}

/** `expr.setAttribute('title'|'aria-label'|'placeholder', value)` — the imperative-JS equivalent of an HTML attribute literal. */
function checkSetAttributeSink(node, ctx) {
	if (!ts.isPropertyAccessExpression(node.expression) || node.expression.name.text !== 'setAttribute' || node.arguments.length < 2) { return; }
	const nameArg = unwrapParens(node.arguments[0]);
	if (!ts.isStringLiteral(nameArg) || !ATTR_NAMES.includes(nameArg.text)) { return; }
	for (const literal of extractLiteralTexts(node.arguments[1], ctx.sourceFile)) {
		reportAt(literal.text, literal.offset, ctx, `setAttribute('${nameArg.text}', ...) value`);
	}
}

function walk(node, ctx) {
	if (!node) { return; }

	if (ts.isCallExpression(node)) {
		const chain = getCalleeChainText(node.expression);
		if (isConsoleCall(chain) || isLocalizationCall(chain)) {
			return; // exempt: don't descend into console.*/localize()/t()/l10n.t() arguments
		}
		if (chain !== null) { checkTextArgSink(node, chain, ctx); }
		checkSetAttributeSink(node, ctx);
	}

	// `+=` (e.g. `element.textContent += 'Refresh'`) is a valid way to append rendered text, same
	// as a plain `=`; checkAssignmentTarget is operator-agnostic, so both share the same handling.
	if (ts.isBinaryExpression(node) && ts.isPropertyAccessExpression(node.left)
		&& (node.operatorToken.kind === ts.SyntaxKind.EqualsToken || node.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken)) {
		const reasonPrefix = node.operatorToken.kind === ts.SyntaxKind.EqualsToken ? 'assignment to .' : 'compound (+=) assignment to .';
		checkAssignmentTarget(node.left.name.text, node.right, ctx, reasonPrefix);
	}

	if (ts.isPropertyAssignment(node) && (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name))) {
		checkAssignmentTarget(node.name.text, node.initializer, ctx, 'object literal property .');
	}

	if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node)) {
		scanHtmlLiteralForTags(node, ctx);
	}

	ts.forEachChild(node, (child) => walk(child, ctx));
}

/** Finds every `getXxxHtml`-style method/function body in `sourceFile` (used to scope extension.ts scanning). */
function findHtmlMethodBodies(sourceFile) {
	const bodies = [];
	function visit(node) {
		const isNamedMatch = (name) => name && ts.isIdentifier(name) && HTML_METHOD_NAME_RE.test(name.text);
		if ((ts.isMethodDeclaration(node) || ts.isFunctionDeclaration(node)) && isNamedMatch(node.name) && node.body) {
			bodies.push(node.body);
		} else if (ts.isPropertyDeclaration(node) && isNamedMatch(node.name) && node.initializer
			&& (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) {
			bodies.push(node.initializer.body);
		}
		ts.forEachChild(node, visit);
	}
	visit(sourceFile);
	return bodies;
}

/**
 * Scans the personalized-insights catalog for prose that never reaches a
 * translator.
 *
 * Why this needs its own pass rather than another entry in TARGET_PROPS: the
 * catalog renders no HTML and touches no DOM, so every sink the rest of this
 * script recognizes is absent. Its user-facing text is ordinary object
 * properties and `buildBody` return values. Post-#2081 all of it flows through
 * `ctx.translate(key, ...)`, so the rule is simply: inside `INSIGHT_CATALOG`,
 * a prose-looking literal that is not a localization key is a violation.
 *
 * What is deliberately not reported:
 *   - arguments to `translate(` / `plural(` — those are keys, not display text
 *   - the machine-valued properties in INSIGHT_NON_TEXT_PROPS (ids, VS Code
 *     command ids, `category`/`severity` enum members, and the `*Key` fields)
 *   - literals being compared (`x === 'skill'`, `tier !== 'default'`), which are
 *     data values read out of session logs, not text shown to anyone
 *
 * Known limitation, same class as the rest of this script: a prose literal
 * passed through a local helper that itself calls `translate()` is judged at
 * the helper's own call site, not traced into. That is the existing
 * TEXT_ARG_SINKS boundary (limitation 3 above), not a new one.
 */
export function scanInsightCatalog(filePath, allowlist, violations) {
	if (!fs.existsSync(filePath)) { return; }
	const sourceText = fs.readFileSync(filePath, 'utf8');
	const sourceFile = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
	const ctx = {
		sourceFile,
		exemptCommentLines: findExemptCommentLines(sourceFile),
		relFile: path.relative(repoRoot, filePath).replace(/\\/g, '/'),
		allowlist,
		violations
	};

	const callName = (node) => {
		if (!ts.isCallExpression(node)) { return null; }
		const e = node.expression;
		if (ts.isIdentifier(e)) { return e.text; }
		// `ctx.translate(...)` / `someCtx.translate(...)`
		if (ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.name)) { return e.name.text; }
		return null;
	};

	function visit(node, skip) {
		const name = callName(node);
		if (name && INSIGHT_KEY_CALLS.has(name)) {
			// The callee itself can still contain reportable code (a nested
			// translate is fine either way); only its arguments are keys.
			ts.forEachChild(node, (child) => visit(child, true));
			return;
		}
		if (ts.isPropertyAssignment(node) && node.name && ts.isIdentifier(node.name)
			&& INSIGHT_NON_TEXT_PROPS.has(node.name.text)) {
			return;
		}
		if (ts.isBinaryExpression(node)
			&& [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken,
				ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken].includes(node.operatorToken.kind)) {
			return;
		}
		if (!skip && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))) {
			reportAt(node.text, node.getStart(sourceFile), ctx, 'insight catalog text not passed through translate()');
		}
		if (!skip && ts.isTemplateExpression(node)) {
			for (const span of [node.head, ...node.templateSpans.map(s => s.literal)]) {
				reportAt(span.text, span.getStart(sourceFile), ctx, 'insight catalog text not passed through translate()');
			}
		}
		ts.forEachChild(node, (child) => visit(child, skip));
	}

	// Scope to the catalog itself — the rest of the file is threshold constants,
	// tool-name parsing and pure scoring helpers with their own string data.
	function findCatalog(node) {
		if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)
			&& node.name.text === INSIGHT_CATALOG_NAME && node.initializer) {
			visit(node.initializer, false);
			return;
		}
		ts.forEachChild(node, findCatalog);
	}
	findCatalog(sourceFile);
}

export function scanFile(filePath, allowlist, violations, rootSelector) {
	const sourceText = fs.readFileSync(filePath, 'utf8');
	const sourceFile = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
	const ctx = {
		sourceFile,
		exemptCommentLines: findExemptCommentLines(sourceFile),
		relFile: path.relative(repoRoot, filePath).replace(/\\/g, '/'),
		allowlist,
		violations
	};
	const roots = rootSelector ? rootSelector(sourceFile) : [sourceFile];
	for (const root of roots) { walk(root, ctx); }
}

function collectAllViolations() {
	const allowlist = loadAllowlist();
	const violations = [];

	for (const file of collectFiles(webviewDir, ['.ts'])) {
		scanFile(file, allowlist, violations);
	}
	for (const file of EXTRA_FULL_SCAN_FILES) {
		if (fs.existsSync(file)) { scanFile(file, allowlist, violations); }
	}
	scanFile(extensionTsPath, allowlist, violations, findHtmlMethodBodies);
	scanInsightCatalog(insightsEnginePath, allowlist, violations);

	// De-duplicate exact (file, offset, text) hits — the assignment-based and HTML-template-based
	// passes can both match the same literal at the same source position. Keying on the offset
	// (not the line) is deliberate: two distinct occurrences of identical text on the same line —
	// e.g. `<button>Refresh</button><button>Refresh</button>` — must both survive as violations.
	const seen = new Set();
	return violations.filter((v) => {
		const key = `${v.file}:${v.offset}:${v.text}`;
		if (seen.has(key)) { return false; }
		seen.add(key);
		return true;
	});
}

export function hashLine(text) {
	return crypto.createHash('sha1').update(text).digest('hex').slice(0, 12);
}

// violationLineHash is called once per violation (including every already-baselined one, of which
// there are 1000+), and most violations in a run share a handful of source files — cache each
// file's lines by absolute path instead of re-reading and re-splitting the same file repeatedly.
const fileLinesCache = new Map();
function getFileLines(absPath) {
	let lines = fileLinesCache.get(absPath);
	if (lines === undefined) {
		lines = fs.readFileSync(absPath, 'utf8').split('\n');
		fileLinesCache.set(absPath, lines);
	}
	return lines;
}

/**
 * The trimmed content of the source line(s) a violation was found on — the baseline's stable key
 * ingredient. A direct-text run can itself span multiple lines (e.g. a multiline tag body with no
 * nested element/hole to split it into separate runs); hashing only `violation.line` would leave
 * the hash unchanged when new prose is added on a later line of that same run, silently covering
 * it as pre-existing. `violation.text`'s own newline count is a reliable proxy for how many actual
 * source lines the run spans, since flattening never introduces or removes them.
 */
export function violationLineHash(violation) {
	const absPath = path.join(repoRoot, violation.file);
	const lines = getFileLines(absPath);
	const spanLineCount = violation.text.split('\n').length;
	const spanned = [];
	for (let i = 0; i < spanLineCount; i++) {
		spanned.push((lines[violation.line - 1 + i] || '').trim());
	}
	return hashLine(spanned.join('\n'));
}

function tallyKeys(keys) {
	const counts = new Map();
	for (const key of keys) { counts.set(key, (counts.get(key) || 0) + 1); }
	return counts;
}

/**
 * For each key (in scan order), determines whether it is "new": a key's first `baselineCount`
 * occurrences are pre-existing, any beyond that are new. This is what lets a genuinely new
 * duplicate of an already-baselined line get caught, instead of every occurrence of a
 * once-baselined (file, hash) silently passing forever. Pure and disk-independent so it's
 * directly testable; `main()` supplies `file::hash` keys built from `violationLineHash`.
 */
export function newIndexesBeyondBaseline(keys, baseline) {
	const seenCounts = new Map();
	return keys.map((key) => {
		const occurrence = (seenCounts.get(key) || 0) + 1;
		seenCounts.set(key, occurrence);
		return occurrence > (baseline.get(key) || 0);
	});
}

/** Loads the baseline as file::hash -> occurrence count, so a line duplicated elsewhere in the same file isn't silently covered by one baselined occurrence. */
function loadBaseline() {
	if (!fs.existsSync(baselinePath)) { return new Map(); }
	const data = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
	const entries = Array.isArray(data.violations) ? data.violations : [];
	const counts = new Map();
	for (const e of entries) {
		counts.set(`${e.file}::${e.hash}`, typeof e.count === 'number' ? e.count : 1);
	}
	return counts;
}

function writeBaseline(violations) {
	// Group by (file, hash), counting occurrences instead of collapsing them — two distinct
	// lines that happen to have identical trimmed content must both count as baselined, or a
	// later *third* occurrence of that same text would be wrongly treated as pre-existing.
	const byKey = new Map();
	for (const v of violations) {
		const hash = violationLineHash(v);
		const key = `${v.file}::${hash}`;
		const existing = byKey.get(key);
		if (existing) {
			existing.count += 1;
		} else {
			byKey.set(key, { file: v.file, hash, count: 1, line: v.line, sample: formatForDisplay(v.text).slice(0, 80) });
		}
	}
	const entries = [...byKey.values()].sort((a, b) => (a.file === b.file ? a.line - b.line : a.file.localeCompare(b.file)));
	const payload = {
		'//': 'Generated by check-hardcoded-strings.mjs --update-baseline. Do not hand-edit; see the "Detecting Hardcoded Strings" section of .github/instructions/vscode-extension.instructions.md.',
		generatedAt: new Date().toISOString(),
		violations: entries
	};
	fs.writeFileSync(baselinePath, `${JSON.stringify(payload, null, 2)}\n`);
	return entries.length;
}

const inGitHubActions = process.env.GITHUB_ACTIONS === 'true';

function escapeData(value) {
	return String(value).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}
function escapeProperty(value) {
	return escapeData(value).replace(/,/g, '%2C').replace(/:/g, '%3A');
}
/** Collapses embedded newlines/tabs and truncates a violation's text for single-line console/annotation output (the underlying `v.text` used for hashing/allowlisting is left untouched). */
function formatForDisplay(text) {
	const collapsed = text.replace(/\r\n|\r|\n/g, '\\n').replace(/\t/g, '\\t');
	return collapsed.length > 160 ? `${collapsed.slice(0, 160)}…` : collapsed;
}

function annotate(level, { file, line, message }) {
	if (!inGitHubActions) { return; }
	console.log(`::${level} file=${escapeProperty(file)},line=${line}::${escapeData(message)}`);
}

/** Webview bundle code (src/webview/**) must use the webview's own `localize()` helper (a different
 * runtime contract — string data passed in at panel-creation time, see the "Webview Localization"
 * section of vscode-extension.instructions.md) rather than the extension-host's `t()`; every other
 * scanned file (configPanel.ts, teamServerConfigPanel.ts, loadingHtml.ts, extension.ts) runs in the
 * extension host, where `t()` is correct. */
export function localizationHintForFile(file) {
	return file.startsWith('src/webview/')
		? "localize() from src/webview/shared/localization.ts"
		: "t() from src/l10n.ts";
}

function main() {
	const updateBaseline = process.argv.includes('--update-baseline');

	console.log('🔍 Scanning webview UI code for hardcoded strings...\n');
	const violations = collectAllViolations();

	if (updateBaseline) {
		const count = writeBaseline(violations);
		console.log(`✅ Wrote ${count} baseline entr${count === 1 ? 'y' : 'ies'} to ${path.relative(extRoot, baselinePath)} (from ${violations.length} violation(s) found).\n`);
		process.exit(0);
	}

	const baseline = loadBaseline();
	const keys = violations.map((v) => `${v.file}::${violationLineHash(v)}`);
	const isNew = newIndexesBeyondBaseline(keys, baseline);
	const newViolations = violations.filter((_, i) => isNew[i]);

	const seenCounts = tallyKeys(keys);
	let staleCount = 0;
	for (const [key, baselineCount] of baseline) {
		if ((seenCounts.get(key) || 0) < baselineCount) { staleCount += 1; }
	}

	console.log(`Found ${violations.length} hardcoded-looking string(s) in scope (${violations.length - newViolations.length} already in baseline).`);
	if (staleCount > 0) {
		console.log(`ℹ️  ${staleCount} baseline entr${staleCount === 1 ? 'y is' : 'ies are'} stale (fixed since the baseline was generated) — run with --update-baseline to shrink it.`);
	}

	if (newViolations.length > 0) {
		console.error(`\n❌ ${newViolations.length} new hardcoded string(s) not covered by the baseline:`);
		for (const v of newViolations) {
			const displayText = formatForDisplay(v.text);
			console.error(`   - [${v.file}:${v.line}] ${v.reason}: "${displayText}"`);
			annotate('error', { file: v.file, line: v.line, message: `Hardcoded UI string (${v.reason}): "${displayText}". Route it through ${localizationHintForFile(v.file)}, or add an "// i18n-exempt: <reason>" comment / an entry in scripts/hardcoded-strings-allowlist.json if it's intentionally not localized.` });
		}
		console.error('\nRun "npm run lint:hardcoded-strings -- --update-baseline" only if these are pre-existing and intentionally deferred — new UI code should be localized instead.\n');
		process.exit(1);
	}

	console.log('\n✅ No new hardcoded UI strings found.\n');
	process.exit(0);
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) { main(); }
