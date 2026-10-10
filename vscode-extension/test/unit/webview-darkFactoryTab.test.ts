/// <reference path="../../src/types/jsdom.d.ts" />
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

import { DarkFactoryTab } from '../../src/webview/usage/darkFactoryTab';
import type { DarkFactoryReport } from '../../../src/types';
import { buildDarkFactoryReport, scoreDarkFactoryReadiness } from '../../../src/darkFactoryReadiness';

const emptyReport: DarkFactoryReport = {
	scannedAt: '2026-03-14T09:30:00.000Z',
	apiSignalsIncluded: false,
	maxAssessableStage: 4,
	repos: [],
	skippedRepoCount: 0,
};

test('AI Readiness is a host-gated Usage Analysis tab with a lazy, refreshable scan', () => {
	const dom = new JSDOM('<div id="root"></div>');
	const previousDocument = globalThis.document;
	(globalThis as typeof globalThis & { document: Document }).document = dom.window.document;
	try {
		const messages: Array<{ command: string; requestId?: number; prompt?: string }> = [];
		const traces: string[] = [];
		const tab = new DarkFactoryTab(message => messages.push(message), stage => traces.push(stage));
		assert.equal(tab.button('activity'), '');
		assert.equal(tab.panel('readiness'), '');
		tab.startIfNeeded();
		assert.equal(messages.length, 0);

		tab.setAvailable(true);
		assert.match(tab.button('readiness'), /class="tab-button active" data-tab="readiness"/);
		dom.window.document.getElementById('root')!.innerHTML = tab.panel('readiness');
		tab.attach();
		assert.match(dom.window.document.getElementById('readiness-content')!.textContent!, /Scanning repository controls/);
		tab.startIfNeeded();
		tab.startIfNeeded();
		assert.deepEqual(messages, [{ command: 'loadReadiness', requestId: 1 }]);
		assert.equal(tab.handleMessage({ command: 'readinessLoaded', requestId: 1, report: emptyReport }), true);
		assert.match(dom.window.document.getElementById('readiness-content')!.textContent!, /No git repositories were found/);

		dom.window.document.getElementById('root')!.innerHTML = tab.panel('readiness');
		tab.attach();
		assert.match(dom.window.document.getElementById('readiness-content')!.textContent!, /No git repositories were found/);
		dom.window.document.getElementById('btn-refresh-readiness')!.click();
		assert.deepEqual(messages.at(-1), { command: 'loadReadiness', requestId: 2, force: true });
		// A forced refresh keeps the current report on screen and says it is refreshing.
		tab.handleMessage({ command: 'readinessLoaded', requestId: 1, report: emptyReport });
		const shown = () => dom.window.document.getElementById('readiness-content')!.textContent!;
		assert.match(shown(), /Showing the last scan while a fresh one runs/);
		assert.match(shown(), /No git repositories were found/);
		// A failed background refresh must not throw away the report we can still show.
		tab.handleMessage({ command: 'readinessScanFailed', requestId: 2 });
		assert.equal(dom.window.document.querySelector('[role="alert"]'), null);
		assert.match(shown(), /No git repositories were found/);
		assert.doesNotMatch(shown(), /Showing the last scan/);

		// A cached report arrives first (refreshing), then the fresh scan replaces it.
		dom.window.document.getElementById('btn-refresh-readiness')!.click();
		assert.equal(messages.at(-1)?.requestId, 3);
		tab.handleMessage({ command: 'readinessLoaded', requestId: 3, report: emptyReport, refreshing: true });
		assert.match(shown(), /Showing the last scan/);
		tab.handleMessage({ command: 'readinessLoaded', requestId: 3, report: emptyReport, refreshing: false });
		assert.doesNotMatch(shown(), /Showing the last scan/);

		dom.window.document.getElementById('btn-refresh-readiness')!.click();
		assert.equal(messages.at(-1)?.requestId, 4);
		tab.handleMessage({ command: 'readinessLoaded', requestId: 4, report: {} });
		assert.deepEqual(traces, ['readinessLoaded.invalidReport']);
		assert.match(shown(), /No git repositories were found/);

		// With nothing to show, a failure is surfaced.
		tab.invalidate();
		tab.startIfNeeded();
		assert.equal(messages.at(-1)?.requestId, 6);
		tab.handleMessage({ command: 'readinessScanFailed', requestId: 6 });
		assert.ok(dom.window.document.querySelector('[role="alert"]'));
		assert.equal(tab.handleMessage({ command: 'unrelated' }), false);
	} finally {
		(globalThis as typeof globalThis & { document: Document }).document = previousDocument;
		dom.window.close();
	}
});

test('the Copilot button drafts a chat prompt from the items still checked in that repository', () => {
	const dom = new JSDOM('<div id="root"></div>');
	const previousDocument = globalThis.document;
	(globalThis as typeof globalThis & { document: Document }).document = dom.window.document;
	try {
		const messages: Array<{ command: string; requestId?: number; prompt?: string }> = [];
		const tab = new DarkFactoryTab(message => messages.push(message), () => undefined);
		tab.setAvailable(true);
		dom.window.document.getElementById('root')!.innerHTML = tab.panel('readiness');
		tab.attach();
		tab.attach(); // re-attaching the same container must not double-post
		tab.startIfNeeded();
		const repo = scoreDarkFactoryReadiness({
			name: 'demo', repoRoot: '/tmp/demo',
			observations: {
				'codeowners': { state: 'absent', detail: 'none' },
				'ci-test-execution': { state: 'absent', detail: 'none' },
			},
		});
		const report = buildDarkFactoryReport([repo], { scannedAt: '2026-09-01T12:00:00.000Z', apiSignalsIncluded: false, skippedRepoCount: 0 });
		tab.handleMessage({ command: 'readinessLoaded', requestId: 1, report });

		const doc = dom.window.document;
		(doc.querySelector('.df-pick[data-df-id="ci-test-execution"]') as HTMLInputElement).checked = false;
		(doc.querySelector('.df-chat-btn') as HTMLElement).click();
		const drafts = messages.filter(m => m.command === 'draftCopilotChatWithPrompt');
		assert.equal(drafts.length, 1);
		assert.match(drafts[0].prompt!, /CODEOWNERS/);
		assert.equal(drafts[0].prompt!.includes('Tests executed in CI'), false);

		Array.from(doc.querySelectorAll('.df-pick')).forEach(input => { (input as HTMLInputElement).checked = false; });
		(doc.querySelector('.df-chat-btn') as HTMLElement).click();
		assert.equal(messages.filter(m => m.command === 'draftCopilotChatWithPrompt').length, 1);
		assert.match(doc.querySelector('.df-chat-btn')!.textContent!, /Select at least one item/);
	} finally {
		(globalThis as typeof globalThis & { document: Document }).document = previousDocument;
		dom.window.close();
	}
});
