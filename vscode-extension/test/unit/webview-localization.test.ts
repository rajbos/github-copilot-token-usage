import test from 'node:test';
import * as assert from 'node:assert/strict';
import {
	initializeWebviewLocalization,
	localize,
	localizeFormat,
	webviewLocalizationKeys,
} from '../../src/webview/shared/localization';
import { ENGLISH_BUNDLE } from '../../src/l10nCore';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

// The webview gets its strings as a flat payload from the extension host, so
// these helpers are the last hop before a label reaches the DOM. Everything
// below resets the payload it depends on, because the module holds the current
// bundle in module state shared across tests.

test('localizeFormat: substitutes {0}/{1} placeholders in order', () => {
	initializeWebviewLocalization({});
	assert.equal(localizeFormat('usage.contextPressure.ofCount', 3, 12), '3 of 12');
	assert.equal(
		localizeFormat('usage.contextPressure.worstFill', 94),
		'Fullest session reached 94% of its window',
	);
});

test('localizeFormat: honours a translated template, including reordered placeholders', () => {
	// zh-cn phrases the count the other way round, so a naive concatenation
	// would render "3 个中的 12 个" — the numbers swapped.
	initializeWebviewLocalization({ 'usage.contextPressure.ofCount': '{1} 个中的 {0} 个' });
	assert.equal(localizeFormat('usage.contextPressure.ofCount', 3, 12), '12 个中的 3 个');
	initializeWebviewLocalization({});
});

test('localizeFormat: leaves placeholders intact when an argument is missing', () => {
	// Degrading to a visible "{1}" beats rendering the string "undefined".
	initializeWebviewLocalization({});
	assert.equal(localizeFormat('usage.contextPressure.ofCount', 3), '3 of {1}');
});

test('localizeFormat: falls back to the key itself for an unknown string', () => {
	initializeWebviewLocalization({});
	assert.equal(localizeFormat('usage.contextPressure.nope', 1), 'usage.contextPressure.nope');
});

test('localize: the context-pressure defaults are present without any payload', () => {
	// The extension host passes these through getWebviewLocalization(), but the
	// view must not show raw keys if that payload is ever missing.
	initializeWebviewLocalization({});
	for (const key of [
		'usage.contextPressure.compactedLabel',
		'usage.contextPressure.noneCompacted',
		'usage.contextPressure.compactedTooltip',
		'usage.contextPressure.nearLimitLabel',
		'usage.contextPressure.nearLimitTooltip',
		'usage.group.usage',
		'usage.group.workspace',
		'usage.group.github',
		'usage.group.coaching',
		'usage.tab.activity',
		'usage.tab.sessions',
		'usage.tab.tools',
		'usage.tab.health',
		'usage.tab.repos',
		'usage.tab.agent',
		'usage.tab.worktrees',
		'usage.tab.insights',
		'usage.tab.corrections',
		'usage.band.overview.title',
		'usage.band.overview.subtitle',
		'usage.band.spend.title',
		'usage.band.spend.subtitle',
		'usage.band.context.title',
		'usage.band.context.subtitle',
		'usage.contextRefs.otherSummary',
		'usage.contextRefs.noneRecent',
		'usage.contextWindow.compactionHeading',
		'usage.contextRefs.totalTooltip',
		'usage.contextRefs.colReference',
		'usage.contextRefs.colToday',
		'usage.contextRefs.colThisMonth',
		'usage.contextRefs.colLastMonth',
		'usage.contextRefs.colLast30',
		'usage.contextRefs.colTrend',
		'usage.contextRefs.colTrendTooltip',
		'usage.contextRefs.totalRow',
		'usage.sessions.contextFill.columnLabel',
		'usage.sessions.contextFill.nearLimitFilter',
		'usage.sessions.contextFill.nearLimitFilterTooltip',
		'usage.sessions.contextFill.used',
		'usage.sessions.contextFill.usedNearLimit',
		'usage.sessions.contextFill.noData',
	]) {
		assert.notEqual(localize(key), key, `${key} should have a built-in English default`);
	}
});

test('localize: a raw unresolved key in the payload falls back to the English default', () => {
	// initializeWebviewLocalization drops entries whose value equals their key,
	// which is what the extension sends when its bundle failed to load.
	initializeWebviewLocalization({
		'usage.contextPressure.compactedLabel': 'usage.contextPressure.compactedLabel',
	});
	assert.equal(localize('usage.contextPressure.compactedLabel'), '🗜️ Sessions compacted');
	initializeWebviewLocalization({});
});

test('localize: the model-mix table defaults are present without any payload', () => {
	// The Cost Attribution table renders on first paint, before any payload is
	// guaranteed, so raw keys must never reach its headers.
	initializeWebviewLocalization({});
	for (const key of [
		'efficiency.modelMix.heading',
		'efficiency.modelMix.caption',
		'efficiency.modelMix.model',
		'efficiency.modelMix.previous',
		'efficiency.modelMix.current',
		'efficiency.modelMix.shift',
		'efficiency.modelMix.shiftPoints',
		'efficiency.modelMix.canonicalId',
	]) {
		assert.notEqual(localize(key), key, `${key} should have a built-in English default`);
	}
	assert.equal(localizeFormat('efficiency.modelMix.shiftPoints', '+1.5'), '+1.5 pt');
	assert.equal(localizeFormat('efficiency.modelMix.canonicalId', 'gpt-4o'), 'Model ID: gpt-4o');
});

// ---------------------------------------------------------------------------
// One source of truth: DEFAULT_LOCALIZATION vs package.nls.json
//
// English webview text is currently authored in two places — `package.nls.json`
// (which the host resolves through `t()` and ships in the panel payload) and
// `DEFAULT_LOCALIZATION` in localization.ts (the fallback used when no payload
// arrived). Nothing made them agree: the `WebviewLocalization` interface ends in
// `[key: string]: string`, which neutralizes its 147 explicit declarations, and
// `getWebviewLocalization()` returns `Record<string, string>` rather than the
// interface, so there is no compile-time link between producer and consumer.
//
// They *do* agree today. These tests are what keeps that true. Without them, a
// one-sided edit makes the webview render different English depending on whether
// the host payload arrived — and the three hosts that never send one (desktop,
// JetBrains, Visual Studio) would silently diverge from VS Code.
//
// See docs/adr/LOCALIZATION-ARCHITECTURE.md (S1). Once the fallback is generated
// from the bundle rather than hand-written, these become unnecessary.
// ---------------------------------------------------------------------------

/**
 * Every localization key the webview bundles request with a literal argument,
 * mapped to the file that requests it.
 *
 * Read from source rather than from the built bundles: the point is to fail in
 * the PR that introduces a bad key, not after a build. Keys built dynamically
 * (a computed `localize(someVar)`) are out of reach here by construction — the
 * same boundary the hardcoded-string ratchet has.
 */
function requestedWebviewKeys(): Map<string, string> {
	// Tests run compiled out of `out/`, so __dirname is not next to the source.
	const webviewRoot = join(__dirname, '../../../../src/webview');
	const found = new Map<string, string>();
	const walk = (dir: string): void => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const full = join(dir, entry.name);
			if (entry.isDirectory()) { walk(full); continue; }
			if (!entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) { continue; }
			const text = readFileSync(full, 'utf8');
			// Both quote styles: most of the webview uses single quotes, but
			// diagnostics/main.ts uses double. Matching only one silently shrank
			// this scan to a subset and let the invariant go unenforced.
			for (const m of text.matchAll(/\blocalize(?:Format)?\(\s*(['"])(.*?)\1/g)) {
				const key = m[2];
				if (!found.has(key)) { found.set(key, relative(webviewRoot, full).split(sep).join('/')); }
			}
		}
	};
	walk(webviewRoot);
	return found;
}

/** The fallback English text, read through the same path the webview uses. */
function fallbackValue(key: string): string {
	// An empty payload leaves `currentLocalization` at DEFAULT_LOCALIZATION, so
	// localize() returns the fallback — no need to reach into module internals.
	initializeWebviewLocalization({});
	return localize(key);
}

test('webview fallback: every key it declares exists in package.nls.json', () => {
	const missing = webviewLocalizationKeys().filter(k => !(k in ENGLISH_BUNDLE));
	assert.deepEqual(missing, [], 'these webview keys have no package.nls.json entry, so the host can never send them');
});

test('webview fallback: English text matches package.nls.json exactly', () => {
	const divergent: string[] = [];
	for (const key of webviewLocalizationKeys()) {
		if (!(key in ENGLISH_BUNDLE)) { continue; }
		const fallback = fallbackValue(key);
		if (fallback !== ENGLISH_BUNDLE[key]) {
			divergent.push(`${key}\n  fallback: ${JSON.stringify(fallback)}\n  nls     : ${JSON.stringify(ENGLISH_BUNDLE[key])}`);
		}
	}
	assert.deepEqual(divergent, [], 'the two English copies have drifted apart');
});

test('webview fallback: the key set is non-trivial', () => {
	// Guards the two tests above against silently passing if the parsing below
	// ever stops finding keys (e.g. the interface is reformatted).
	assert.ok(webviewLocalizationKeys().length > 100, `expected the full webview key set, got ${webviewLocalizationKeys().length}`);
});

test('webview fallback: every key the webview asks for has a fallback entry', () => {
	// The other direction, and the one that actually reaches users. The tests
	// above check that what the fallback *declares* matches the bundle; this
	// checks that what the webview *requests* is declared at all.
	//
	// A key with no fallback entry renders as the raw key on any host that does
	// not send the payload dictionary — which today is three of the four hosts
	// shipping these bundles (desktop, JetBrains, Visual Studio). On VS Code the
	// host dictionary covers it, so the bug would be invisible in development
	// and visible only in the products nobody runs locally.
	const declared = new Set(webviewLocalizationKeys());
	const missing: string[] = [];
	for (const [key, file] of requestedWebviewKeys()) {
		if (!declared.has(key)) { missing.push(`${key} (${file})`); }
	}
	assert.deepEqual(missing, [], 'these keys are requested by webview code but have no English fallback');
});

test('webview fallback: the requested-key scan finds a realistic number of call sites', () => {
	// Same guard as above: if the scan silently stops matching, the test above
	// passes vacuously.
	assert.ok(requestedWebviewKeys().size > 50, `expected the webview's localize() call sites, got ${requestedWebviewKeys().size}`);
});

test('webview fallback: the generated JSON is what localize() and webviewLocalizationKeys() read', () => {
	// Pins the import binding of webviewStrings.generated.json in localization.ts:
	// the default dictionary and the exported key list must come from the same
	// source, so a rewired or shadowed import fails here rather than rendering raw keys.
	initializeWebviewLocalization({});
	assert.equal(localize('usage.contextPressure.compactedLabel'), '🗜️ Sessions compacted');
	assert.ok(webviewLocalizationKeys().includes('usage.contextPressure.compactedLabel'));
});
