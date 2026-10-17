import test from 'node:test';
import * as assert from 'node:assert/strict';
import {
	AGENT_SESSIONS_PARTIAL_NOTE_KEY,
	REFRESH_GITHUB_ACTIVITY_ACTION,
	REFRESH_GITHUB_ACTIVITY_COMMAND,
	REPO_PR_PARTIAL_NOTE_KEY,
	isEmptyActivitySnapshot,
	shouldRenderErrorOnlyRow,
	snapshotFreshnessHtml,
	snapshotFreshnessState,
} from '../../src/webview/usage/snapshotFreshness';
import { initializeWebviewLocalization, localize } from '../../src/webview/shared/localization';

const HOUR = 60 * 60 * 1000;
const NOW = Date.parse('2026-08-29T12:00:00Z');
const FRESH = { fetchedAt: '2026-08-29T11:30:00Z', refreshIntervalMs: HOUR };
const STALE = { fetchedAt: '2026-08-29T10:00:00Z', refreshIntervalMs: HOUR };
const NOTE = { partialNoteKey: REPO_PR_PARTIAL_NOTE_KEY };

test('a snapshot that has never been fetched says so and still offers a refresh', () => {
	assert.equal(snapshotFreshnessState({}, NOW), 'never-fetched');
	const html = snapshotFreshnessHtml({}, NOTE, NOW);
	assert.match(html, /Not fetched yet/);
	assert.match(html, new RegExp(`data-action="${REFRESH_GITHUB_ACTIVITY_ACTION}"`));
});

test('a snapshot inside its TTL reports its age and the next refresh time', () => {
	assert.equal(snapshotFreshnessState(FRESH, NOW), 'fresh');
	const html = snapshotFreshnessHtml(FRESH, NOTE, NOW);
	assert.match(html, /Updated/);
	assert.match(html, /next refresh after/);
	assert.ok(!html.includes('Revalidating'));
});

test('a snapshot past its TTL is shown as revalidating, not as live data', () => {
	assert.equal(snapshotFreshnessState(STALE, NOW), 'stale');
	const html = snapshotFreshnessHtml(STALE, NOTE, NOW);
	assert.match(html, /Revalidating/);
	assert.match(html, /Showing the cached snapshot/);
});

test('the TTL boundary counts as stale, matching the host\'s own freshness check', () => {
	const exactlyDue = { fetchedAt: new Date(NOW - HOUR).toISOString(), refreshIntervalMs: HOUR };
	assert.equal(snapshotFreshnessState(exactlyDue, NOW), 'stale');
	const justInside = { fetchedAt: new Date(NOW - HOUR + 1).toISOString(), refreshIntervalMs: HOUR };
	assert.equal(snapshotFreshnessState(justInside, NOW), 'fresh');
});

test('a snapshot timestamped far in the future reads as stale, matching the host', () => {
	// isRepoPrSnapshotFresh()/isAgentTasksSnapshotFresh() treat `age < -intervalMs` as stale so a
	// clock change cannot pin the cache open. A banner that called the same snapshot fresh would
	// show a next-refresh time in the future while the host revalidated on every single open.
	const skewed = { fetchedAt: new Date(NOW + 3 * HOUR).toISOString(), refreshIntervalMs: HOUR };
	assert.equal(snapshotFreshnessState(skewed, NOW), 'stale');
	assert.match(snapshotFreshnessHtml(skewed, NOTE, NOW), /Revalidating/);

	// Inside one interval either way is still fresh — a little skew is not a stale snapshot.
	const slightlyAhead = { fetchedAt: new Date(NOW + HOUR / 2).toISOString(), refreshIntervalMs: HOUR };
	assert.equal(snapshotFreshnessState(slightlyAhead, NOW), 'fresh');
});

test('a snapshot with no known refresh interval never claims to be stale', () => {
	const noInterval = { fetchedAt: '2020-01-01T00:00:00Z' };
	assert.equal(snapshotFreshnessState(noInterval, NOW), 'fresh');
	assert.match(snapshotFreshnessHtml(noInterval, NOTE, NOW), /next refresh after unknown/);
});

test('an unparseable fetchedAt reads as stale, not fresh, and does not throw', () => {
	// The host's own predicates refuse to trust a timestamp they cannot parse and refresh the
	// snapshot on every open. Calling it fresh here would suppress the revalidating state while
	// exactly that happened behind the banner, every single time.
	const broken = { fetchedAt: 'not-a-date', refreshIntervalMs: HOUR };
	assert.equal(snapshotFreshnessState(broken, NOW), 'stale');
	assert.match(snapshotFreshnessHtml(broken, NOTE, NOW), /Revalidating/);
});

test('partial data is called out as a lower bound, with the panel-specific reason', () => {
	const html = snapshotFreshnessHtml({ ...FRESH, partial: true }, NOTE, NOW);
	assert.match(html, /lower bound/);
	assert.ok(html.includes('did not complete'), html);

	const agentHtml = snapshotFreshnessHtml({ ...FRESH, partial: true }, { partialNoteKey: AGENT_SESSIONS_PARTIAL_NOTE_KEY }, NOW);
	assert.ok(agentHtml.includes('task-detail budget'), agentHtml);
});

test('complete data carries no lower-bound warning', () => {
	assert.ok(!snapshotFreshnessHtml({ ...FRESH, partial: false }, NOTE, NOW).includes('lower bound'));
});

test('every banner string goes through the localization bundle', () => {
	// The webview renders whatever the extension host passed for these keys. Rendering with a
	// translated bundle must change the banner — if a string were still hardcoded it would stay
	// English here, which is exactly what the hardcoded-strings gate exists to catch.
	initializeWebviewLocalization({
		'usage.githubActivity.revalidatingTitle': '[[revalidating]]',
		'usage.githubActivity.cachePolicy': '[[policy]]',
		'usage.githubActivity.refreshNow': '[[refresh]]',
		'usage.githubActivity.partialTitle': '[[partial]]',
		'usage.githubActivity.partialRepoPrs': '[[repo-note]]',
	});
	try {
		const html = snapshotFreshnessHtml({ ...STALE, partial: true }, NOTE, NOW);
		for (const marker of ['[[revalidating]]', '[[policy]]', '[[refresh]]', '[[partial]]', '[[repo-note]]']) {
			assert.ok(html.includes(marker), `${marker} missing from ${html}`);
		}
		assert.ok(!html.includes('Revalidating.'), html);
	} finally {
		initializeWebviewLocalization({});
	}
});

test('a translated string is HTML-escaped, so bundle content cannot inject markup', () => {
	initializeWebviewLocalization({ 'usage.githubActivity.partialRepoPrs': '<img src=x onerror=alert(1)>' });
	try {
		const html = snapshotFreshnessHtml({ ...FRESH, partial: true }, NOTE, NOW);
		assert.ok(!html.includes('<img'), html);
		assert.match(html, /&lt;img/);
	} finally {
		initializeWebviewLocalization({});
	}
});

test('a placeholder template is escaped too, not just its arguments', () => {
	// localizeFormat() escapes only what you pass in; the template itself comes from the bundle and
	// was going in raw. A stray `<` in a translation must render as text, not as markup.
	initializeWebviewLocalization({
		'usage.githubActivity.updated': '<em>pwned</em> {0} · {1}',
		'usage.githubActivity.revalidatingBody': '<em>pwned</em> {0}',
	});
	try {
		const fresh = snapshotFreshnessHtml(FRESH, NOTE, NOW);
		assert.ok(!fresh.includes('<em>'), fresh);
		assert.match(fresh, /&lt;em&gt;pwned/);
		// The argument is trusted HTML by construction, so its own markup still renders.
		assert.match(fresh, /<strong>/);

		const stale = snapshotFreshnessHtml(STALE, NOTE, NOW);
		assert.ok(!stale.includes('<em>'), stale);
		assert.match(stale, /&lt;em&gt;pwned/);
	} finally {
		initializeWebviewLocalization({});
	}
});

test('a template with no placeholders still renders its slots literally', () => {
	// A translation that drops {1} must leave the slot visible rather than swallowing the value.
	initializeWebviewLocalization({ 'usage.githubActivity.updated': 'Updated {0}' });
	try {
		const html = snapshotFreshnessHtml(FRESH, NOTE, NOW);
		assert.match(html, /Updated <strong>/);
	} finally {
		initializeWebviewLocalization({});
	}
});

test('the English defaults are what the banner shows with no bundle loaded', () => {
	assert.equal(localize('usage.githubActivity.refreshNow'), '🔄 Refresh now');
	assert.equal(localize('usage.githubActivity.partialTitle'), 'Partial data — the figures below are a lower bound.');
});

test('the refresh button posts the command the extension host handles', () => {
	// Guards the contract between this button and `_getAnalysisMessageHandlers()`.
	assert.equal(REFRESH_GITHUB_ACTIVITY_COMMAND, 'refreshGitHubActivity');
	for (const state of [{}, FRESH, STALE]) {
		assert.match(snapshotFreshnessHtml(state, NOTE, NOW), new RegExp(`data-action="${REFRESH_GITHUB_ACTIVITY_ACTION}"`));
	}
});

test('an empty, never-fetched payload is the signal to re-arm the lazy loader', () => {
	// The panel is retained when hidden, so its copy of the previous identity's rows outlives a
	// sign-out, an account switch or Clear Cache. The host pushes this shape on every such discard;
	// treating it as "nothing cached yet" is what makes the tab ask for the new identity's data.
	assert.equal(isEmptyActivitySnapshot({ authenticated: true, fetchedAt: '' }), true, 'switched account');
	assert.equal(isEmptyActivitySnapshot({ authenticated: false, fetchedAt: '' }), true, 'signed out');
	assert.equal(isEmptyActivitySnapshot({ authenticated: false, fetchedAt: '2026-08-29T11:30:00Z' }), true);
	assert.equal(isEmptyActivitySnapshot({}), true, 'a payload with neither field is not data');

	// A real snapshot must not re-arm it, or every publish would trigger another load request.
	assert.equal(isEmptyActivitySnapshot({ authenticated: true, fetchedAt: '2026-08-29T11:30:00Z' }), false);
});

test('a row only hides its counts when the listing collected nothing at all', () => {
	// fetchRepoPrs() and the task listing deliberately keep the pages they got before a failure,
	// and the banner calls those figures a lower bound. An error-only row would contradict it.
	assert.equal(shouldRenderErrorOnlyRow('HTTP 500', 0), true, 'nothing collected — only the error to show');
	assert.equal(shouldRenderErrorOnlyRow('HTTP 500', 7), false, 'seven PRs survived the failure; show them');
	assert.equal(shouldRenderErrorOnlyRow(undefined, 0), false, 'an empty repo is not an error');
	assert.equal(shouldRenderErrorOnlyRow('', 0), false, 'an empty error string is not an error');
});

test('a malformed timestamp with no known interval is still not called stale', () => {
	// With no refresh policy to measure against there is nothing to be late for, so the banner says
	// what it does know — that the next refresh time is unknown — rather than inventing staleness.
	const noInterval = { fetchedAt: 'not-a-date' };
	assert.equal(snapshotFreshnessState(noInterval, NOW), 'fresh');
	assert.match(snapshotFreshnessHtml(noInterval, NOTE, NOW), /next refresh after unknown/);
});
