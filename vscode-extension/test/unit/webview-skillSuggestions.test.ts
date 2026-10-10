import test from 'node:test';
import * as assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

import { bindDataTables } from '../../src/webview/shared/dataTable';
import { initializeWebviewLocalization } from '../../src/webview/shared/localization';
import {
	SKILL_SUGGESTIONS_LIST_ID,
	SKILL_SUGGESTIONS_PAGE_SIZE,
	COPY_FEEDBACK_MS,
	setSkillSessionsPage,
	setSkillSuggestionsPage,
	buildSkillSuggestionsSectionHtml,
	getSkillSuggestionsPage,
	isRepositoryOpen,
	lastPathSegment,
	resolveSkillCreateAction,
	sanitizeRepeatedTaskReport,
	sessionsTableId,
	wireSkillSuggestions,
	type RepeatedTaskCluster,
	type RepeatedTaskReport,
	type SkillSuggestionsMessage,
} from '../../src/webview/usage/skillSuggestions';

initializeWebviewLocalization({});

function makeCluster(index: number, sessionCount = 2, repositories = ['octo/app']): RepeatedTaskCluster {
	return {
		representativePrompt: `task number ${index}`,
		sessionCount,
		repositories,
		sessions: Array.from({ length: sessionCount }, (_, s) => ({
			file: `C:\\logs\\cluster-${index}-session-${s}.jsonl`,
			title: `Session ${index}.${s}`,
			lastInteraction: `2026-01-${String(28 - s).padStart(2, '0')}T10:00:00Z`,
			repository: repositories[0],
		})),
		sharedKeywords: ['task'],
		examplePrompts: [],
	};
}

function makeReport(clusterCount: number): RepeatedTaskReport {
	return {
		minClusterSize: 2,
		sessionsScanned: 99,
		clusters: Array.from({ length: clusterCount }, (_, i) => makeCluster(i)),
	};
}

function render(report: RepeatedTaskReport | null): Document {
	return new JSDOM(`<div id="root">${buildSkillSuggestionsSectionHtml(report)}</div>`).window.document;
}

function resetPages(): void {
	setSkillSuggestionsPage(1);
}

test('skillSuggestions: no report or no clusters renders nothing', () => {
	assert.equal(buildSkillSuggestionsSectionHtml(null), '');
	assert.equal(buildSkillSuggestionsSectionHtml({ minClusterSize: 2, sessionsScanned: 3, clusters: [] }), '');
});

test('skillSuggestions: title carries the total count and the subtitle the scanned sessions', () => {
	resetPages();
	const doc = render(makeReport(7));
	assert.match(doc.querySelector('.section-title')!.textContent!, /Skill Suggestions \(7\)/);
	assert.match(doc.querySelector('.section-subtitle')!.textContent!, /99 sessions scanned/);
});

for (const [count, expectedCards, pagerShown] of [[1, 1, false], [5, 5, false], [6, 5, true], [12, 5, true]] as const) {
	test(`skillSuggestions: ${count} suggestions → ${expectedCards} cards on page 1, pager ${pagerShown ? 'shown' : 'hidden'}`, () => {
		resetPages();
		const doc = render(makeReport(count));
		assert.equal(doc.querySelectorAll('.skill-suggestion-card').length, expectedCards);
		const pager = Array.from(doc.querySelectorAll('[data-table-id]'))
			.filter(el => el.getAttribute('data-table-id') === SKILL_SUGGESTIONS_LIST_ID);
		assert.equal(pager.length > 0, pagerShown);
	});
}

test('skillSuggestions: page slicing keeps global cluster indexes and the last page is partial', () => {
	resetPages();
	const clusters = makeReport(12).clusters;
	setSkillSuggestionsPage(3);
	const page = getSkillSuggestionsPage(clusters);
	assert.equal(SKILL_SUGGESTIONS_PAGE_SIZE, 5);
	assert.deepEqual([page.page, page.pageCount, page.firstRow, page.lastRow], [3, 3, 11, 12]);
	const doc = render({ minClusterSize: 2, sessionsScanned: 1, clusters });
	const indexes = Array.from(doc.querySelectorAll('.skill-suggestion-card')).map(c => c.getAttribute('data-cluster-index'));
	assert.deepEqual(indexes, ['10', '11']);
	assert.match(doc.querySelector('#data-table-root-skill-suggestions > .data-table-content > .data-table-pager')!.textContent!, /Page 3 of 3/);
});

test('skillSuggestions: a stale page is clamped when the list shrinks after a refresh', () => {
	resetPages();
	setSkillSuggestionsPage(3);
	const page = getSkillSuggestionsPage(makeReport(6).clusters);
	assert.equal(page.page, 2);
	assert.deepEqual(page.rows.map(c => c.representativePrompt), ['task number 5']);
	assert.equal(getSkillSuggestionsPage(makeReport(2).clusters).page, 1);
});

test('skillSuggestions: sessions table has one open button per session with the escaped file path', () => {
	resetPages();
	const report = makeReport(1);
	report.clusters[0].sessions[0].file = 'C:\\logs\\"evil"<b>.jsonl';
	report.clusters[0].sessions[0].title = '<img src=x onerror=alert(1)>';
	const html = buildSkillSuggestionsSectionHtml(report);
	assert.ok(!html.includes('<img src=x'), 'session title must be escaped');
	const doc = render(report);
	const buttons = Array.from(doc.querySelectorAll('button.skill-suggestion-open-session'));
	assert.equal(buttons.length, 2);
	assert.equal(buttons[0].getAttribute('data-file'), 'C:\\logs\\"evil"<b>.jsonl');
	assert.equal(buttons[1].getAttribute('data-file'), 'C:\\logs\\cluster-0-session-1.jsonl');
	const headers = Array.from(doc.querySelectorAll('#data-table-root-skill-sessions-0 thead th')).map(th => th.textContent!.trim());
	assert.deepEqual(headers, ['Session', 'Date↓', 'Repository', 'Actions']);
	const dateHeader = Array.from(doc.querySelectorAll('#data-table-root-skill-sessions-0 thead th')).find(th => th.textContent!.includes('Date'))!;
	assert.equal(dateHeader.getAttribute('aria-sort'), 'descending', 'the applied sort is exposed on the header');
	assert.match(doc.querySelector('#data-table-root-skill-sessions-0 tbody tr')!.textContent!, /<img src=x onerror=alert\(1\)>/);
});

test('skillSuggestions: representative prompt and keywords are HTML-escaped', () => {
	resetPages();
	const report = makeReport(1);
	report.clusters[0].representativePrompt = '<script>alert(1)</script>';
	report.clusters[0].sharedKeywords = ['<b>kw</b>'];
	const html = buildSkillSuggestionsSectionHtml(report);
	assert.ok(!html.includes('<script>'));
	assert.ok(!html.includes('<b>kw</b>'));
});

test('skillSuggestions: a sessions table pages only above 10 sessions', () => {
	resetPages();
	const small = render({ minClusterSize: 2, sessionsScanned: 10, clusters: [makeCluster(0, 10)] });
	assert.equal(small.querySelectorAll('.skill-suggestion-open-session').length, 10);
	assert.equal(small.querySelector('#data-table-root-skill-sessions-0 .data-table-pager'), null);

	const large = render({ minClusterSize: 2, sessionsScanned: 12, clusters: [makeCluster(0, 12)] });
	assert.equal(large.querySelectorAll('.skill-suggestion-open-session').length, 10);
	const pagerButtons = Array.from(large.querySelectorAll('#data-table-root-skill-sessions-0 .data-table-pager button'));
	assert.equal(pagerButtons.length, 2);
	assert.ok(pagerButtons.every(b => b.getAttribute('data-table-id') === sessionsTableId(0)));
});

test('isRepositoryOpen: matches the repository name against open workspace folder names', () => {
	assert.equal(isRepositoryOpen('octo/app', ['C:\\code\\App']), true);
	assert.equal(isRepositoryOpen('octo/app', ['/home/me/src/app/']), true);
	assert.equal(isRepositoryOpen('octo/app', ['/home/me/src/api']), false);
	assert.equal(isRepositoryOpen('octo/app', []), false);
	// repoDisplayName() leaves local paths unchanged, including Windows ones.
	assert.equal(isRepositoryOpen('C:\\code\\Project', ['c:\\code\\project']), true);
	assert.equal(isRepositoryOpen('C:\\code\\Project\\', ['/mnt/c/code/project']), true);
	assert.equal(isRepositoryOpen('C:\\code\\Project', ['C:\\code\\other']), false);
	assert.equal(lastPathSegment('C:\\code\\Project'), 'Project');
	assert.equal(lastPathSegment('octo/app'), 'app');
	assert.equal(lastPathSegment('///'), undefined);
});

test('resolveSkillCreateAction: a single Windows-path repository that is open drafts, and a closed one names its folder', () => {
	const cluster = makeCluster(0, 2, ['C:\\code\\Project']);
	assert.equal(resolveSkillCreateAction(cluster, ['C:\\code\\Project']).kind, 'draft');
	resetPages();
	const report: RepeatedTaskReport = { minClusterSize: 2, sessionsScanned: 2, clusters: [cluster] };
	const dom = new JSDOM(`<div id="root">${buildSkillSuggestionsSectionHtml(report)}</div>`);
	const globals = globalThis as unknown as Record<string, unknown>;
	const previous = { document: globals.document, Element: globals.Element, HTMLElement: globals.HTMLElement };
	Object.assign(globals, { document: dom.window.document, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement });
	try {
		const posted: SkillSuggestionsMessage[] = [];
		wireSkillSuggestions({ getReport: () => report, getWorkspacePaths: () => ['D:\\elsewhere'], postMessage: m => posted.push(m) });
		(dom.window.document.querySelector('button.skill-suggestion-create') as HTMLElement).click();
		assert.deepEqual(posted, []);
		const notice = dom.window.document.querySelector('.skill-suggestion-notice')!.textContent!;
		assert.match(notice, /Open "Project" in VS Code first/);
		assert.doesNotMatch(notice, /Open "C:/);
	} finally {
		Object.assign(globals, previous);
	}
});

test('resolveSkillCreateAction: drafts when the single repo is open or the cluster spans repos, else asks to open it', () => {
	assert.equal(resolveSkillCreateAction(makeCluster(0), ['/src/app']).kind, 'draft');
	assert.equal(resolveSkillCreateAction(makeCluster(0, 2, ['octo/app', 'octo/api']), []).kind, 'draft');
	const blocked = resolveSkillCreateAction(makeCluster(0), ['/src/other']);
	assert.equal(blocked.kind, 'openRepoFirst');
	assert.match(blocked.prompt, /\.github\/skills\//);
});

test('sanitizeRepeatedTaskReport: examplePrompts is optional and filtered to strings', () => {
	const legacy = sanitizeRepeatedTaskReport({ clusters: [{ representativePrompt: 'x', sessionCount: 1, sessions: [{ file: 'a' }] }] });
	assert.deepEqual(legacy!.clusters[0].examplePrompts, []);
	const mixed = sanitizeRepeatedTaskReport({ clusters: [{ representativePrompt: 'x', sessionCount: 1, sessions: [{ file: 'a' }], examplePrompts: ['ok', 3, null] }] });
	assert.deepEqual(mixed!.clusters[0].examplePrompts, ['ok']);
});

test('wireSkillSuggestions: delegated clicks post messages, page the list, and survive re-renders', () => {
	resetPages();
	const report = makeReport(7);
	report.clusters[1] = makeCluster(1, 2, ['octo/app', 'octo/api']);
	const dom = new JSDOM(`<div id="root">${buildSkillSuggestionsSectionHtml(report)}</div>`);
	const globals = globalThis as unknown as Record<string, unknown>;
	const previous = { document: globals.document, Element: globals.Element, HTMLElement: globals.HTMLElement };
	Object.assign(globals, { document: dom.window.document, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement });
	const posted: SkillSuggestionsMessage[] = [];
	try {
		const wiring = { getReport: () => report, getWorkspacePaths: () => ['/src/elsewhere'], postMessage: (m: SkillSuggestionsMessage) => posted.push(m) };
		bindDataTables(dom.window.document);
		wireSkillSuggestions(wiring);
		wireSkillSuggestions(wiring); // idempotent: a second call must not double-post
		const doc = dom.window.document;
		const click = (el: Element | null) => { assert.ok(el); (el as HTMLElement).click(); };

		click(doc.querySelector('button.skill-suggestion-open-session'));
		assert.deepEqual(posted, [{ command: 'openSessionFile', file: 'C:\\logs\\cluster-0-session-0.jsonl' }]);

		// Multi-repo cluster → user-level skill, drafted (never submitted) regardless of the open workspace.
		click(doc.querySelector('button.skill-suggestion-create[data-cluster-index="1"]'));
		assert.equal(posted.length, 2);
		assert.equal(posted[1].command, 'draftCopilotChatWithPrompt');
		assert.match((posted[1] as { prompt: string }).prompt, /~\/\.copilot\/skills\//);

		// Single repo that is not open → instructions instead of a message.
		click(doc.querySelector('button.skill-suggestion-create[data-cluster-index="0"]'));
		assert.equal(posted.length, 2);
		const notice = doc.querySelector('.skill-suggestion-notice[data-cluster-index="0"]')!;
		assert.match(notice.textContent!, /Open "app" in VS Code first/);
		assert.equal(notice.getAttribute('role'), 'status', 'blocked-create instructions must be announced');
		assert.equal(notice.getAttribute('aria-live'), 'polite');
		assert.match(notice.querySelector('pre')!.textContent!, /\.github\/skills\//);

		// Next page re-renders the section; the same listener keeps handling clicks.
		click(doc.querySelector(`[data-table-id="${SKILL_SUGGESTIONS_LIST_ID}"][data-table-direction="next"]`));
		const indexes = Array.from(doc.querySelectorAll('.skill-suggestion-card') as NodeListOf<Element>).map(c => c.getAttribute('data-cluster-index'));
		assert.deepEqual(indexes, ['5', '6']);
		const status = doc.querySelector('#data-table-root-skill-suggestions > .data-table-status')!;
		assert.equal(status.getAttribute('role'), 'status');
		assert.match(status.textContent!, /Page 2 of 2/, 'page change is announced');
		click(doc.querySelector('button.skill-suggestion-open-session'));
		assert.deepEqual(posted[2], { command: 'openSessionFile', file: 'C:\\logs\\cluster-5-session-0.jsonl' });
	} finally {
		Object.assign(globals, previous);
		resetPages();
	}
});

test('skillSuggestions: a cluster with no repository is labelled user-level without claiming several repositories', () => {
	resetPages();
	const doc = render({ minClusterSize: 2, sessionsScanned: 2, clusters: [makeCluster(0, 2, [])] });
	const text = doc.querySelector('.skill-suggestion-card')!.textContent!;
	assert.match(text, /user-level skill \(not tied to exactly one repository\)/);
	assert.doesNotMatch(text, /several repositories/);
});

test('skillSuggestions: page setters work before anything has rendered (no hidden state dependency)', () => {
	// A fresh list id would have no state yet; the module setters create it.
	setSkillSuggestionsPage(2);
	assert.equal(getSkillSuggestionsPage(makeReport(12).clusters).page, 2);
	setSkillSuggestionsPage(1);
	setSkillSessionsPage(41, 2);
	const doc = render({ minClusterSize: 2, sessionsScanned: 12, clusters: Array.from({ length: 42 }, (_, i) => makeCluster(i, i === 41 ? 12 : 2)) });
	assert.equal(doc.querySelector('.skill-suggestion-card'), doc.querySelector('.skill-suggestion-card[data-cluster-index="0"]'));
	setSkillSuggestionsPage(9);
	const lastPage = render({ minClusterSize: 2, sessionsScanned: 12, clusters: Array.from({ length: 42 }, (_, i) => makeCluster(i, i === 41 ? 12 : 2)) });
	const buttons = lastPage.querySelectorAll('.skill-suggestion-card[data-cluster-index="41"] .skill-suggestion-open-session');
	assert.equal(buttons.length, 2, 'sessions table of cluster 41 opened on its page 2 (sessions 11–12)');
	resetPages();
});

test('wireSkillSuggestions: sorting a sessions table by date toggles order and is announced', () => {
	resetPages();
	const report = makeReport(1);
	const dom = new JSDOM(`<div id="root">${buildSkillSuggestionsSectionHtml(report)}</div>`);
	const globals = globalThis as unknown as Record<string, unknown>;
	const previous = { document: globals.document, Element: globals.Element, HTMLElement: globals.HTMLElement };
	Object.assign(globals, { document: dom.window.document, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement });
	try {
		bindDataTables(dom.window.document);
		wireSkillSuggestions({ getReport: () => report, getWorkspacePaths: () => [], postMessage: () => undefined });
		const doc = dom.window.document;
		const files = () => Array.from(doc.querySelectorAll('.skill-suggestion-open-session') as NodeListOf<Element>).map(b => b.getAttribute('data-file')!.split(/[\\/]/).pop());
		assert.deepEqual(files(), ['cluster-0-session-0.jsonl', 'cluster-0-session-1.jsonl']);
		(doc.querySelector('[data-table-sort="date"]') as HTMLElement).click();
		assert.deepEqual(files(), ['cluster-0-session-1.jsonl', 'cluster-0-session-0.jsonl'], 'oldest first after toggling');
		assert.match(doc.querySelector('#data-table-root-skill-sessions-0 > .data-table-status')!.textContent!, /Sorted ascending/);
		(doc.querySelector('[data-table-sort="date"]') as HTMLElement).click(); // restore the default for other tests
		assert.deepEqual(files(), ['cluster-0-session-0.jsonl', 'cluster-0-session-1.jsonl']);
	} finally {
		Object.assign(globals, previous);
	}
});

test('wireSkillSuggestions: Copy prompt without a clipboard API does not throw', () => {
	resetPages();
	const report = makeReport(1);
	const dom = new JSDOM(`<div id="root">${buildSkillSuggestionsSectionHtml(report)}</div>`);
	const globals = globalThis as unknown as Record<string, unknown>;
	const previous = { document: globals.document, Element: globals.Element, HTMLElement: globals.HTMLElement, navigator: globals.navigator };
	Object.assign(globals, { document: dom.window.document, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement });
	Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true, writable: true });
	try {
		const errors: unknown[] = [];
		dom.window.addEventListener('error', (e: { error?: unknown }) => errors.push(e.error));
		wireSkillSuggestions({ getReport: () => report, getWorkspacePaths: () => [], postMessage: () => undefined });
		const button = dom.window.document.querySelector('button.skill-suggestion-copy') as HTMLElement;
		const label = button.textContent;
		button.click();
		assert.deepEqual(errors, []);
		assert.equal(button.textContent, label, 'label unchanged when nothing was copied');
	} finally {
		Object.defineProperty(globalThis, 'navigator', { value: previous.navigator, configurable: true, writable: true });
		Object.assign(globals, { document: previous.document, Element: previous.Element, HTMLElement: previous.HTMLElement });
	}
});

test('wireSkillSuggestions: a second Copy click while "Copied!" shows still restores the real label once', async (t) => {
	resetPages();
	const report = makeReport(1);
	const dom = new JSDOM(`<div id="root">${buildSkillSuggestionsSectionHtml(report)}</div>`);
	const globals = globalThis as unknown as Record<string, unknown>;
	const previous = { document: globals.document, Element: globals.Element, HTMLElement: globals.HTMLElement, navigator: globals.navigator };
	Object.assign(globals, { document: dom.window.document, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement });
	const copied: string[] = [];
	Object.defineProperty(globalThis, 'navigator', {
		value: { clipboard: { writeText: (text: string) => { copied.push(text); return Promise.resolve(); } } },
		configurable: true,
		writable: true,
	});
	t.mock.timers.enable({ apis: ['setTimeout'] });
	const settle = () => new Promise<void>(resolve => setImmediate(resolve));
	try {
		wireSkillSuggestions({ getReport: () => report, getWorkspacePaths: () => [], postMessage: () => undefined });
		const button = dom.window.document.querySelector('button.skill-suggestion-copy') as HTMLElement;
		const label = button.textContent;
		assert.equal(label, '📋 Copy prompt');

		button.click();
		await settle();
		assert.equal(button.textContent, '✅ Copied!');
		t.mock.timers.tick(COPY_FEEDBACK_MS / 2);
		button.click(); // second click while the success label is showing
		await settle();
		assert.equal(button.textContent, '✅ Copied!');
		assert.equal(copied.length, 2);

		// The first click's timer is cancelled: the label stays until the second one's elapses...
		t.mock.timers.tick(COPY_FEEDBACK_MS / 2);
		assert.equal(button.textContent, '✅ Copied!');
		// ...and then it returns to the real label, not the transient one.
		t.mock.timers.tick(COPY_FEEDBACK_MS / 2);
		assert.equal(button.textContent, label);
		t.mock.timers.tick(COPY_FEEDBACK_MS * 2);
		assert.equal(button.textContent, label);
	} finally {
		t.mock.timers.reset();
		Object.defineProperty(globalThis, 'navigator', { value: previous.navigator, configurable: true, writable: true });
		Object.assign(globals, { document: previous.document, Element: previous.Element, HTMLElement: previous.HTMLElement });
	}
});
