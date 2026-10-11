#!/usr/bin/env node
/**
 * Ratchet for hardcoded colors in webview CSS.
 *
 * Webviews must follow the user's VS Code theme (dark, light, high contrast).
 * A literal `#1e1e1e` or `rgba(0, 0, 0, 0.5)` in a stylesheet looks right in
 * one theme and wrong in the others, and nothing in a diff flags it. Prefer
 * `var(--vscode-*)` tokens or the semantic variables in `shared/theme.css`.
 *
 * Counts hex colors (#rgb, #rgba, #rrggbb, #rrggbbaa) and rgb()/rgba()/hsl()/
 * hsla() functions in `src/webview/**\/*.css`, ignoring comments. Same shape as
 * the other ratchets (check-bare-tolocale, check-hardcoded-strings):
 *   - counts are tracked per file: a file may shrink, never grow, and a file
 *     not in the baseline starts at zero;
 *   - `hardcoded-colors-allowlist.json` lists files and individual literals
 *     that are legitimately fixed (e.g. theme.css, which DEFINES the semantic
 *     palette). A color entry may be scoped to CSS properties (`properties`);
 *     allowlisted colors are not counted at all.
 *
 * Usage:
 *   node scripts/check-hardcoded-colors.mjs                  # check (CI)
 *   node scripts/check-hardcoded-colors.mjs --update-baseline
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const extRoot = path.resolve(scriptDir, '..');
const repoRoot = path.resolve(extRoot, '..');
const baselinePath = path.join(scriptDir, 'hardcoded-colors-baseline.json');
const allowlistPath = path.join(scriptDir, 'hardcoded-colors-allowlist.json');
const SCAN_ROOT = path.join(extRoot, 'src', 'webview');

// Case-insensitive (CSS function names and hex digits are). Matches a hex color or a complete absolute color function:
// rgb/rgba/hsl/hsla/hwb/lab/lch/oklab/oklch/color(), with balanced parentheses (one level of nesting, e.g. rgba(var(--x), .5)).
// color-mix() and light-dark() are not matched as a whole: their literal operands (#fff, rgb(...)) are matched individually,
// while a mix of var()/currentColor/transparent operands is theme-derived and allowed. The lookbehind keeps `color(` from
// matching inside `background-color(` or similar; `color:` the property is never followed by a paren.
// var(), currentColor, transparent and inherit are never colors here. Named colors (`white`, `red`) are a known gap: they are
// plain identifiers, indistinguishable from other keywords without a per-property model.
const COLOR_LITERAL = /#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{3,4})\b|(?<![\w-])(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\((?:[^()]|\([^()]*\))*\)/gi;

function collectCssFiles(dir) {
	if (!fs.existsSync(dir)) { return []; }
	const out = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) { out.push(...collectCssFiles(full)); continue; }
		if (entry.name.endsWith('.css')) { out.push(full); }
	}
	return out;
}

function stripComments(css) {
	// Keep newlines so nothing else shifts; only the text matters for counting.
	return css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
}

const normalize = (literal) => literal.toLowerCase().replace(/\s+/g, '');

/**
 * Splits CSS into declarations, ignoring selector and at-rule preludes. A
 * chunk of text ending in `{` is a prelude (`#abc`, `.item:has(#abcdef)`,
 * `@media (...)`); a chunk ending in `;` or `}` inside a block is a
 * declaration (`color: #abc`, `--x: #abcdef`). `;` and `{`/`}` inside
 * parentheses or quotes (`url(data:...;base64,...)`) do not split.
 * Returns `{ prop, value }` pairs.
 */
export function declarations(css) {
	const text = stripComments(css);
	const out = [];
	let start = 0;
	let parens = 0;
	let quote = '';
	const flush = (end, terminator) => {
		const chunk = text.slice(start, end);
		start = end + 1;
		if (terminator === '{') { return; }
		const colon = chunk.indexOf(':');
		if (colon === -1) { return; }
		out.push({ prop: chunk.slice(0, colon).trim().toLowerCase(), value: chunk.slice(colon + 1) });
	};
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (quote) { if (ch === '\\') { i++; } else if (ch === quote) { quote = ''; } continue; }
		if (ch === '"' || ch === "'") { quote = ch; continue; }
		if (ch === '(') { parens++; continue; }
		if (ch === ')') { parens = Math.max(0, parens - 1); continue; }
		if (parens > 0) { continue; }
		if (ch === '{') { flush(i, '{'); }
		else if (ch === ';' || ch === '}') { flush(i, ch); }
	}
	flush(text.length, ';');
	return out;
}

/** `url(#abcdef)` is an SVG fragment reference and a quoted string is text, not a color. */
const stripUrls = (value) => value
	.replace(/url\(\s*(?:"[^"]*"|'[^']*'|[^)]*)\)/gi, ' ')
	.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, ' ');

/**
 * Returns the color literals used as declaration values in `css` that are not
 * allowlisted, in source order. Selectors never count. `allowed` maps a
 * literal to the properties it may appear in (`null` = any property).
 */
export function findColors(css, allowed = {}) {
	const entries = new Map(Object.entries(allowed).map(([literal, props]) => [normalize(literal), props]));
	const hits = [];
	for (const { prop, value } of declarations(css)) {
		for (const m of stripUrls(value).matchAll(COLOR_LITERAL)) {
			const props = entries.get(normalize(m[0]));
			if (props !== undefined && (props === null || props.includes(prop))) { continue; }
			hits.push(m[0]);
		}
	}
	return hits;
}

function loadAllowlist() {
	if (!fs.existsSync(allowlistPath)) { return { files: {}, colors: {} }; }
	const raw = JSON.parse(fs.readFileSync(allowlistPath, 'utf8'));
	return { files: raw.files ?? {}, colors: raw.colors ?? {} };
}

export function countColors() {
	const allowlist = loadAllowlist();
	const allowed = Object.fromEntries(Object.entries(allowlist.colors)
		.map(([literal, entry]) => [literal, entry.properties ?? null]));
	const counts = {};
	for (const file of collectCssFiles(SCAN_ROOT)) {
		const rel = path.relative(repoRoot, file).split(path.sep).join('/');
		if (Object.prototype.hasOwnProperty.call(allowlist.files, rel)) { continue; }
		const n = findColors(fs.readFileSync(file, 'utf8'), allowed).length;
		if (n > 0) { counts[rel] = n; }
	}
	return counts;
}

function main() {
	const counts = countColors();
	const total = Object.values(counts).reduce((a, b) => a + b, 0);

	if (process.argv.includes('--update-baseline')) {
		const payload = {
			'//': 'Generated by check-hardcoded-colors.mjs --update-baseline. Counts may shrink, never grow.',
			counts,
		};
		fs.writeFileSync(baselinePath, `${JSON.stringify(payload, null, 2)}\n`);
		console.log(`✅ Baseline updated: ${total} hardcoded color(s) across ${Object.keys(counts).length} file(s).\n`);
		return;
	}

	const baseline = fs.existsSync(baselinePath)
		? JSON.parse(fs.readFileSync(baselinePath, 'utf8')).counts
		: {};

	const regressions = [];
	for (const [file, count] of Object.entries(counts)) {
		const allowed = baseline[file] ?? 0;
		if (count > allowed) { regressions.push(`${file}: ${count} (baseline ${allowed})`); }
	}

	const baselineTotal = Object.values(baseline).reduce((a, b) => a + b, 0);
	console.log(`🎨 Hardcoded webview CSS colors: ${total} (baseline ${baselineTotal}).`);
	if (total < baselineTotal) {
		console.log(`ℹ️  ${baselineTotal - total} fewer than the baseline — run with --update-baseline to lock the improvement in.`);
	}

	if (regressions.length > 0) {
		console.error('\n❌ New hardcoded color(s) in webview CSS — use a var(--vscode-*) token or a');
		console.error('   semantic variable from shared/theme.css so light and high-contrast themes work.');
		console.error('   A genuinely fixed color goes in scripts/hardcoded-colors-allowlist.json:\n');
		for (const line of regressions) { console.error(`   - ${line}`); }
		console.error('');
		process.exit(1);
	}
	console.log('✅ No new hardcoded colors.\n');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) { main(); }
