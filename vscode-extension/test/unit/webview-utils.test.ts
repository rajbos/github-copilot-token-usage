import test from 'node:test';
import * as assert from 'node:assert/strict';

import { getModelDisplayName, parseCustomProviderModel, getCustomProviderGroup, isCustomProviderGroup } from '../../../src/webview/shared/modelUtils';
import {
	setFormatLocale,
	getEditorIcon,
	getCharsPerToken,
	formatFixed,
	formatPercent,
	formatNumber,
	formatCost,
	formatSignedCostPrecise,
	formatSignedCostCompact,
	formatDurationShort,
	formatFileSize,
	getTimeSince,
	formatAbsoluteDate,
	escapeHtml,
	safeSectionHtml,
	markdownToHtml,
	STAGE_LABELS,
	STAGE_DESCRIPTIONS
} from '../../src/webview/shared/formatUtils';
import { buildAttributionTooltip } from '../../src/webview/efficiency/attributionText';
import { initializeWebviewLocalization } from '../../src/webview/shared/localization';

// ── getModelDisplayName ─────────────────────────────────────────────────

test('getModelDisplayName: returns display name for known models', () => {
	assert.equal(getModelDisplayName('gpt-4o'), 'GPT-4o');
	assert.equal(getModelDisplayName('claude-sonnet-4.5'), 'Claude Sonnet 4.5');
	assert.equal(getModelDisplayName('o3-mini'), 'o3-mini');
	assert.equal(getModelDisplayName('gpt-5'), 'GPT-5');
});

test('getModelDisplayName: Copilot routers have a display name without a pricing entry', () => {
	assert.equal(getModelDisplayName('hydrafusion'), 'HydraFusion');
	assert.equal(getModelDisplayName('auto'), 'Auto');
});

test('getModelDisplayName: returns raw model ID for unknown models', () => {
	assert.equal(getModelDisplayName('some-future-model-99'), 'some-future-model-99');
	assert.equal(getModelDisplayName(''), '');
});

test('getModelDisplayName: an Object.prototype key is an unknown model, not an inherited value', () => {
	// Model ids come from session data. With a normal object backing the lookup,
	// `constructor` resolves to Object.prototype.constructor — a function — which
	// then throws inside escapeHtml() and takes the whole view's render down.
	for (const id of ['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__']) {
		const name = getModelDisplayName(id);
		assert.equal(typeof name, 'string', `${id} must resolve to a string`);
		assert.equal(name, id, `${id} is unknown, so it stays itself`);
	}
});

test('getModelDisplayName: decodes URI-encoded segments in unknown model IDs', () => {
	assert.equal(getModelDisplayName('provider/Model%20Name'), 'provider/Model Name');
});

test('getModelDisplayName: returns raw ID when URI decoding fails (malformed percent)', () => {
	assert.equal(getModelDisplayName('bad%2model'), 'bad%2model');
});

test('getModelDisplayName: drops the custom-endpoint prefix and provider name', () => {
	// Only the model part is shown — the provider name becomes its own provider group.
	assert.equal(getModelDisplayName('customendpoint/Mistral/MistralMedium3.5'), 'MistralMedium3.5');
	assert.equal(
		getModelDisplayName('unify-chat-provider/OpenCode%20Go%20(Anthropic%20Messages)/qwen3.7-max'),
		'qwen3.7-max'
	);
});

test('getModelDisplayName: resolves the friendly name of a custom-endpoint model part', () => {
	assert.equal(getModelDisplayName('customendpoint/Mistral/gpt-4o'), 'GPT-4o');
});

test('getModelDisplayName: resolves dash-separated version ids to the dotted pricing key', () => {
	assert.equal(getModelDisplayName('claude-opus-4-8'), 'Claude Opus 4.8');
	assert.equal(getModelDisplayName('claude-sonnet-4-6'), 'Claude Sonnet 4.6');
	assert.equal(getModelDisplayName('claude-haiku-4-5-20251001'), 'Claude Haiku 4.5 (2025-10-01)');
});

test('getModelDisplayName: resolves org-UUID-prefixed catalog ids to the friendly name of the model part', () => {
	assert.equal(
		getModelDisplayName('83a386ed-9f05-4fd9-83d4-f453d20c994c/mistral-medium-latest'),
		'Mistral Medium 3.5'
	);
	assert.equal(
		getModelDisplayName('83a386ed-9f05-4fd9-83d4-f453d20c994c/codestral-latest'),
		'Codestral'
	);
	assert.equal(
		getModelDisplayName('83a386ed-9f05-4fd9-83d4-f453d20c994c/devstral-latest'),
		'Devstral 2'
	);
});

test('getModelDisplayName: strips the org-UUID prefix for unknown catalog models', () => {
	assert.equal(
		getModelDisplayName('83a386ed-9f05-4fd9-83d4-f453d20c994c/some-private-model'),
		'some-private-model'
	);
});

// ── parseCustomProviderModel ────────────────────────────────────────────

test('parseCustomProviderModel: splits a three-part custom-endpoint ID', () => {
	assert.deepEqual(parseCustomProviderModel('customendpoint/Mistral/mistral-medium-latest'), {
		source: 'customendpoint',
		providerName: 'Mistral',
		modelId: 'mistral-medium-latest'
	});
});

test('parseCustomProviderModel: URI-decodes each part', () => {
	assert.deepEqual(parseCustomProviderModel('unify-chat-provider/OpenCode%20Go/qwen3.7-max'), {
		source: 'unify-chat-provider',
		providerName: 'OpenCode Go',
		modelId: 'qwen3.7-max'
	});
});

test('parseCustomProviderModel: returns undefined unless there are exactly three non-empty parts', () => {
	assert.equal(parseCustomProviderModel('gpt-4o'), undefined);
	assert.equal(parseCustomProviderModel('provider/Model%20Name'), undefined);
	assert.equal(parseCustomProviderModel('customendpoint//mistral-medium-latest'), undefined);
	assert.equal(parseCustomProviderModel('a/b/c/d'), undefined);
	assert.equal(parseCustomProviderModel(''), undefined);
});

// ── getCustomProviderGroup / isCustomProviderGroup ──────────────────────

test('getCustomProviderGroup: names the group after the user-chosen provider', () => {
	assert.equal(getCustomProviderGroup('customendpoint/Mistral/mistral-medium-latest'), 'Mistral (Custom)');
	assert.equal(getCustomProviderGroup('unify-chat-provider/OpenCode%20Go/qwen3.7-max'), 'OpenCode Go (Custom)');
});

test('getCustomProviderGroup: returns undefined for regular model IDs', () => {
	assert.equal(getCustomProviderGroup('gpt-4o'), undefined);
	assert.equal(getCustomProviderGroup('provider/Model%20Name'), undefined);
});

test('isCustomProviderGroup: recognizes only custom provider groups', () => {
	assert.equal(isCustomProviderGroup('Mistral (Custom)'), true);
	assert.equal(isCustomProviderGroup('Mistral AI'), false);
	assert.equal(isCustomProviderGroup('GitHub Copilot'), false);
});

// ── formatDurationShort ─────────────────────────────────────────────────

test('formatDurationShort: formats minutes-only durations', () => {
	assert.equal(formatDurationShort(12 * 60 * 1000), '12m');
	assert.equal(formatDurationShort(59 * 60 * 1000), '59m');
});

test('formatDurationShort: formats hour durations with zero-padded minutes', () => {
	assert.equal(formatDurationShort(64 * 60 * 1000), '1h 04m');
	assert.equal(formatDurationShort(2 * 60 * 60 * 1000), '2h 00m');
	assert.equal(formatDurationShort((60 + 30) * 60 * 1000), '1h 30m');
});

test('formatDurationShort: formats sub-minute durations as <1m', () => {
	assert.equal(formatDurationShort(0), '<1m');
	assert.equal(formatDurationShort(29 * 1000), '<1m');
});

test('formatDurationShort: returns em dash for missing or invalid values', () => {
	assert.equal(formatDurationShort(undefined), '—');
	assert.equal(formatDurationShort(-1), '—');
	assert.equal(formatDurationShort(Number.NaN), '—');
});

// ── getEditorIcon ───────────────────────────────────────────────────────

test('getEditorIcon: returns correct icons for known editors', () => {
	assert.equal(getEditorIcon('VS Code'), '💙');
	assert.equal(getEditorIcon('Cursor'), '🖱️');
	assert.equal(getEditorIcon('OpenCode'), '🟢');
	assert.equal(getEditorIcon('Gemini CLI'), '💎');
	assert.equal(getEditorIcon('Unknown'), '❓');
});

test('getEditorIcon: returns fallback icon for unrecognized editors', () => {
	assert.equal(getEditorIcon('SomeNewEditor'), '📝');
});

// ── getCharsPerToken ────────────────────────────────────────────────────

test('getCharsPerToken: returns a positive number for known models', () => {
	const result = getCharsPerToken('gpt-4o');
	assert.ok(result > 0, 'chars per token should be positive');
	assert.ok(result < 20, 'chars per token should be reasonable');
});

test('getCharsPerToken: returns default for unknown models', () => {
	const result = getCharsPerToken('nonexistent-model-xyz');
	// Default ratio is 0.25, so 1/0.25 = 4
	assert.equal(result, 4);
});

// ── formatFixed ─────────────────────────────────────────────────────────

test('formatFixed: formats to specified decimal places', () => {
	setFormatLocale('en-US');
	assert.equal(formatFixed(3.14159, 2), '3.14');
	assert.equal(formatFixed(1000, 0), '1,000');
	assert.equal(formatFixed(0.5, 3), '0.500');
});

// ── formatPercent ───────────────────────────────────────────────────────

test('formatPercent: formats as percentage with default 1 decimal', () => {
	setFormatLocale('en-US');
	assert.equal(formatPercent(42.567), '42.6%');
	assert.equal(formatPercent(100, 0), '100%');
	assert.equal(formatPercent(0), '0.0%');
});

// ── formatNumber ────────────────────────────────────────────────────────

test('formatNumber: adds thousand separators', () => {
	setFormatLocale('en-US');
	assert.equal(formatNumber(1234567), '1,234,567');
	assert.equal(formatNumber(42), '42');
	assert.equal(formatNumber(0), '0');
});

// ── formatCost ──────────────────────────────────────────────────────────

test('formatCost: formats as USD with 2 decimal places', () => {
	setFormatLocale('en-US');
	const result = formatCost(1.23456789);
	assert.ok(result.includes('$'), 'should contain dollar sign');
	assert.ok(result.includes('1.23'), 'should round to 2 decimal places');
});

test('formatCost: zero cost', () => {
	setFormatLocale('en-US');
	const result = formatCost(0);
	assert.ok(result.includes('$'), 'should contain dollar sign');
	assert.ok(result.includes('0.00'), 'should show two decimal zeros');
});

// ── formatSignedCostPrecise / formatSignedCostCompact ───────────────────

test('formatSignedCostPrecise: signs the effect and keeps four decimals', () => {
	setFormatLocale('en-US');
	assert.equal(formatSignedCostPrecise(7.35), '+$7.3500');
	assert.equal(formatSignedCostPrecise(-7.35), '-$7.3500');
});

test('formatSignedCostPrecise: a sub-cent effect keeps its digits and its sign', () => {
	setFormatLocale('en-US');
	assert.equal(formatSignedCostPrecise(-0.0037), '-$0.0037');
	assert.equal(formatSignedCostPrecise(0.0037), '+$0.0037');
});

test('formatSignedCostPrecise: zero carries no sign', () => {
	setFormatLocale('en-US');
	assert.equal(formatSignedCostPrecise(0), '$0.0000');
});

test('formatSignedCostCompact: two decimals for ordinary dollar amounts', () => {
	setFormatLocale('en-US');
	assert.equal(formatSignedCostCompact(7.35), '+$7.35');
	assert.equal(formatSignedCostCompact(-1234.5), '-$1,234.50');
	assert.equal(formatSignedCostCompact(0), '$0.00');
});

test('formatSignedCostCompact: widens to four decimals rather than showing a non-zero effect as $0.00', () => {
	setFormatLocale('en-US');
	assert.equal(formatSignedCostCompact(-0.0037), '-$0.0037');
	assert.equal(formatSignedCostCompact(0.0037), '+$0.0037');
});

test('formatSignedCostCompact: a locale places its own separators and symbol', () => {
	setFormatLocale('nl-NL');
	// nl-NL writes the USD symbol first (followed by a non-breaking space) and
	// uses a comma as the decimal mark.
	assert.equal(formatSignedCostCompact(1234.5), 'US$\u00a0+1.234,50');
	assert.equal(formatSignedCostPrecise(-0.0037), 'US$\u00a0-0,0037');
	setFormatLocale('en-US');
});

// ── buildAttributionTooltip ─────────────────────────────────────────────

test('buildAttributionTooltip: volume bar names the session counts and the signed effect', () => {
	setFormatLocale('en-US');
	initializeWebviewLocalization({});
	assert.equal(
		buildAttributionTooltip({ headlineKey: 'efficiency.attribution.tooltip.volume', prev: 64, cur: 73, kind: 'count', effect: 7.35 }),
		'Session count: 64 → 73 sessions\nEstimated cost effect: +$7.3500',
	);
});

test('buildAttributionTooltip: session-size bar groups and rounds the token averages', () => {
	setFormatLocale('en-US');
	initializeWebviewLocalization({});
	assert.equal(
		buildAttributionTooltip({ headlineKey: 'efficiency.attribution.tooltip.size', prev: 60938.4, cur: 55120.6, kind: 'tokens', effect: -3.5 }),
		'Tokens per session: 60,938 → 55,121 tokens/session\nEstimated cost effect: -$3.5000',
	);
});

test('buildAttributionTooltip: model-mix bar renders the blended rates as currency', () => {
	setFormatLocale('en-US');
	initializeWebviewLocalization({});
	assert.equal(
		buildAttributionTooltip({ headlineKey: 'efficiency.attribution.tooltip.mix', prev: 13.41, cur: 13.41, kind: 'rate', effect: 0 }),
		'Blended price: $13.41 → $13.41 per M tokens\nEstimated cost effect: $0.0000',
	);
});

test('buildAttributionTooltip: a non-zero sub-cent effect survives into the tooltip', () => {
	setFormatLocale('en-US');
	initializeWebviewLocalization({});
	const tooltip = buildAttributionTooltip({ headlineKey: 'efficiency.attribution.tooltip.mix', prev: 13.41, cur: 13.4, kind: 'rate', effect: -0.0037 });
	assert.ok(tooltip.endsWith('Estimated cost effect: -$0.0037'), tooltip);
});

test('buildAttributionTooltip: a non-US locale groups the counts and localizes the currency', () => {
	setFormatLocale('nl-NL');
	initializeWebviewLocalization({});
	assert.equal(
		buildAttributionTooltip({ headlineKey: 'efficiency.attribution.tooltip.size', prev: 1234567, cur: 1234567, kind: 'tokens', effect: 7.35 }),
		'Tokens per session: 1.234.567 → 1.234.567 tokens/session\nEstimated cost effect: US$\u00a0+7,3500',
	);
	setFormatLocale('en-US');
});

test('buildAttributionTooltip: a translated payload localizes the whole tooltip, not just the effect line', () => {
	// The measure and its unit live inside the template, so a translation can
	// reword and reorder both — nothing English is concatenated around it.
	setFormatLocale('en-US');
	initializeWebviewLocalization({
		'efficiency.attribution.tooltip.volume': '会话数：{0} → {1} 个会话',
		'efficiency.attribution.costEffectLine': '预计成本影响：{0}',
	});
	assert.equal(
		buildAttributionTooltip({ headlineKey: 'efficiency.attribution.tooltip.volume', prev: 64, cur: 73, kind: 'count', effect: 7.35 }),
		'会话数：64 → 73 个会话\n预计成本影响：+$7.3500',
	);
	initializeWebviewLocalization({});
});

// ── escapeHtml ──────────────────────────────────────────────────────────

test('escapeHtml: escapes ampersand, angle brackets, double quote, single quote', () => {
	assert.equal(escapeHtml('a & b'), 'a &amp; b');
	assert.equal(escapeHtml('<div>'), '&lt;div&gt;');
	assert.equal(escapeHtml('"quoted"'), '&quot;quoted&quot;');
	assert.equal(escapeHtml("it's"), 'it&#039;s');
});

test('escapeHtml: leaves safe text unchanged', () => {
	assert.equal(escapeHtml('hello world'), 'hello world');
});

test('escapeHtml: neutralises a script injection attempt', () => {
	const result = escapeHtml('<script>alert("xss")</script>');
	assert.ok(!result.includes('<script'));
	assert.equal(result, '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;');
});

// ── safeSectionHtml ───────────────────────────────────────────────────────

test('safeSectionHtml: returns the builder output when it succeeds', () => {
	const result = safeSectionHtml('My Section', () => '<div>ok</div>');
	assert.equal(result, '<div>ok</div>');
});

test('safeSectionHtml: catches a thrown error and renders a fallback card instead', () => {
	const errors: string[] = [];
	const result = safeSectionHtml('Model Efficiency', () => {
		throw new Error('boom');
	}, (m) => errors.push(m));

	assert.ok(result.includes('Model Efficiency'));
	assert.ok(result.includes("couldn't be displayed"));
	assert.equal(errors.length, 1);
	assert.ok(errors[0].includes('Model Efficiency'));
	assert.ok(errors[0].includes('boom'));
});

test('safeSectionHtml: handles non-Error throws (e.g. a thrown string)', () => {
	const errors: string[] = [];
	const result = safeSectionHtml('Weird Section', () => {
		// eslint-disable-next-line @typescript-eslint/no-throw-literal
		throw 'not an Error instance';
	}, (m) => errors.push(m));

	assert.ok(result.includes('Weird Section'));
	assert.ok(errors[0].includes('not an Error instance'));
});

test('safeSectionHtml: escapes the label in the fallback card to avoid HTML injection', () => {
	const result = safeSectionHtml('<img src=x onerror=alert(1)>', () => {
		throw new Error('boom');
	}, () => { /* noop */ });

	assert.ok(!result.includes('<img src=x'));
	assert.ok(result.includes('&lt;img'));
});

test('safeSectionHtml: one failing section does not affect independently built sections', () => {
	const sectionA = safeSectionHtml('Section A', () => '<div>a-ok</div>', () => { /* noop */ });
	const sectionB = safeSectionHtml('Section B', () => { throw new Error('section B broke'); }, () => { /* noop */ });
	const sectionC = safeSectionHtml('Section C', () => '<div>c-ok</div>', () => { /* noop */ });

	const page = `${sectionA}${sectionB}${sectionC}`;
	assert.ok(page.includes('a-ok'));
	assert.ok(page.includes('c-ok'));
	assert.ok(page.includes('Section B'));
});

// ── markdownToHtml ──────────────────────────────────────────────────────

test('markdownToHtml: converts markdown link to anchor tag', () => {
	const result = markdownToHtml('[click here](https://example.com)');
	assert.equal(result, '<a href="https://example.com" target="_blank" rel="noopener noreferrer">click here</a>');
});

test('markdownToHtml: escapes HTML outside of links', () => {
	const result = markdownToHtml('See <this> & [link](https://example.com)');
	assert.ok(result.includes('&lt;this&gt;'));
	assert.ok(result.includes('&amp;'));
	assert.ok(result.includes('<a href='));
});

test('markdownToHtml: plain text without links is just HTML-escaped', () => {
	assert.equal(markdownToHtml('hello & world'), 'hello &amp; world');
});

test('markdownToHtml: generated anchor has target=_blank and rel=noopener noreferrer', () => {
	const result = markdownToHtml('[docs](https://docs.example.com)');
	assert.ok(result.includes('target="_blank"'));
	assert.ok(result.includes('rel="noopener noreferrer"'));
});

// ── STAGE_LABELS ────────────────────────────────────────────────────────

test('STAGE_LABELS: defines labels for all four stages', () => {
	assert.equal(STAGE_LABELS[1], 'Stage 1: AI Skeptic');
	assert.equal(STAGE_LABELS[2], 'Stage 2: AI Explorer');
	assert.equal(STAGE_LABELS[3], 'Stage 3: AI Collaborator');
	assert.equal(STAGE_LABELS[4], 'Stage 4: AI Strategist');
});

// ── STAGE_DESCRIPTIONS ──────────────────────────────────────────────────

test('STAGE_DESCRIPTIONS: defines descriptions for all four stages', () => {
	assert.ok(STAGE_DESCRIPTIONS[1].length > 0);
	assert.ok(STAGE_DESCRIPTIONS[2].length > 0);
	assert.ok(STAGE_DESCRIPTIONS[3].length > 0);
	assert.ok(STAGE_DESCRIPTIONS[4].length > 0);
});

// ── formatFileSize ──────────────────────────────────────────────────────

test('formatFileSize: bytes below 1 KB show as B', () => {
	assert.equal(formatFileSize(512), '512 B');
});

test('formatFileSize: kilobytes use one decimal', () => {
	assert.equal(formatFileSize(1536), '1.5 KB');
});

test('formatFileSize: megabytes use two decimals', () => {
	assert.equal(formatFileSize(5 * 1024 * 1024), '5.00 MB');
});

test('formatFileSize: scales into GB', () => {
	assert.equal(formatFileSize(3 * 1024 ** 3), '3.00 GB');
});

test('formatFileSize: scales into TB', () => {
	assert.equal(formatFileSize(2 * 1024 ** 4), '2.00 TB');
});

test('formatFileSize: scales into PB and caps there', () => {
	assert.equal(formatFileSize(4 * 1024 ** 5), '4.00 PB');
	assert.equal(formatFileSize(2048 * 1024 ** 5), '2048.00 PB');
});

test('formatFileSize: rejects negative and non-finite values', () => {
	assert.equal(formatFileSize(-1), 'N/A');
	assert.equal(formatFileSize(NaN), 'N/A');
});

// ── getTimeSince ────────────────────────────────────────────────────────

test('getTimeSince: returns "Unknown" for invalid timestamps instead of NaN text', () => {
	assert.equal(getTimeSince('not-a-date'), 'Unknown');
	assert.equal(getTimeSince(''), 'Unknown');
});

test('getTimeSince: returns "Just now" for future timestamps', () => {
	assert.equal(getTimeSince(new Date(Date.now() + 60_000).toISOString()), 'Just now');
});

test('getTimeSince: formats seconds, minutes, hours and days', () => {
	assert.equal(getTimeSince(new Date(Date.now() - 5_000).toISOString()), '5 seconds ago');
	assert.equal(getTimeSince(new Date(Date.now() - 3 * 60_000).toISOString()), '3 minutes ago');
	assert.equal(getTimeSince(new Date(Date.now() - 2 * 3_600_000).toISOString()), '2 hours ago');
	assert.equal(getTimeSince(new Date(Date.now() - 4 * 86_400_000).toISOString()), '4 days ago');
});

// ── formatAbsoluteDate ──────────────────────────────────────────────────

test('formatAbsoluteDate: renders a fixed timestamp as a locale-formatted absolute date', () => {
	setFormatLocale('en-US');
	try {
		// Built from local Y/M/D at noon (not a fixed UTC string) so the asserted calendar date
		// holds regardless of the test runner's timezone — a fixed "...T10:00:00Z" would render
		// as a different local date on UTC+14/UTC-12 hosts.
		const localJan15Noon = new Date(2026, 0, 15, 12, 0, 0);
		// Compute the expected string via the same toLocaleDateString call rather than a
		// hard-coded literal, since exact month/punctuation formatting is ICU-version-dependent.
		const expected = localJan15Noon.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
		assert.equal(formatAbsoluteDate(localJan15Noon.toISOString()), expected);
	} finally {
		setFormatLocale(undefined);
	}
});

test('formatAbsoluteDate: returns "—" for invalid ISO values instead of "Invalid Date"', () => {
	assert.equal(formatAbsoluteDate('not-a-date'), '—');
	assert.equal(formatAbsoluteDate(''), '—');
});

test('formatAbsoluteDate: also accepts epoch milliseconds or a Date directly, not just an ISO string', () => {
	setFormatLocale('en-US');
	try {
		const localJan15Noon = new Date(2026, 0, 15, 12, 0, 0);
		const expected = localJan15Noon.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
		assert.equal(formatAbsoluteDate(localJan15Noon.getTime()), expected);
		assert.equal(formatAbsoluteDate(localJan15Noon), expected);
	} finally {
		setFormatLocale(undefined);
	}
});

test('formatAbsoluteDate: honors setFormatLocale for a fixed timestamp', () => {
	setFormatLocale('de-DE');
	try {
		// See the timezone note on the en-US test above — construct from local components.
		const localJan15Noon = new Date(2026, 0, 15, 12, 0, 0);
		// Compute the expected string via the same toLocaleDateString call rather than a
		// hard-coded literal — de-DE month abbreviation/punctuation can vary across Node/ICU
		// versions, which made a hard-coded '15. Jan. 2026' flaky across environments.
		const expected = localJan15Noon.toLocaleDateString('de-DE', { year: 'numeric', month: 'short', day: 'numeric' });
		assert.equal(formatAbsoluteDate(localJan15Noon.toISOString()), expected);
	} finally {
		setFormatLocale(undefined);
	}
});
