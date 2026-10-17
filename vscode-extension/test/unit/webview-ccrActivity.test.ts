import test from 'node:test';
import * as assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

import { initializeWebviewLocalization, localize } from '../../src/webview/shared/localization';
import {
	renderCcrActivityResult,
	renderCcrCheckButtonHtml,
	replayCcrActivityResults,
	wireCcrActivityButtons,
} from '../../src/webview/usage/ccrActivity';

initializeWebviewLocalization({});

function withDom(run: (dom: JSDOM, rerender: () => void) => void): void {
	const markup = (): string => `<div id="host">${renderCcrCheckButtonHtml('octo', 'app', 1)}${renderCcrCheckButtonHtml('octo', 'app', 2)}</div>`;
	const dom = new JSDOM(`<body><div id="container">${markup()}</div></body>`);
	const globals = globalThis as Record<string, unknown>;
	const saved = globals.document;
	globals.document = dom.window.document;
	try {
		// Mimics the data table swapping its content on a sort/page change.
		run(dom, () => { dom.window.document.getElementById('container')!.innerHTML = markup(); });
	} finally {
		globals.document = saved;
		dom.window.close();
	}
}

test('ccrActivity: answered and pending lookups survive a table re-render', () => {
	withDom((dom, rerender) => {
		const doc = dom.window.document;
		const posted: unknown[] = [];
		wireCcrActivityButtons('container', message => posted.push(message));
		const result = (pr: number): string => doc.querySelector(`[data-ccr-result="octo/app#${pr}"]`)?.textContent ?? '';
		const button = (pr: number): Element | null => doc.querySelector(`.btn-check-ccr[data-pr="${pr}"]`);

		button(1)!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
		button(2)!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
		assert.equal(posted.length, 2);
		renderCcrActivityResult('octo', 'app', 1, { command: 'ccrActivityResult', reviews: [], requests: [] });
		const answered = result(1);
		assert.ok(answered.length > 0);

		rerender();
		assert.equal(result(1), '');
		replayCcrActivityResults();
		assert.equal(result(1), answered, 'answered lookup is restored');
		assert.equal(button(1)?.hasAttribute('disabled'), false);
		assert.equal(result(2), localize('usage.repoPrs.ccrChecking'), 'pending lookup shows the checking text');
		assert.equal(button(2)?.hasAttribute('disabled'), true, 'pending lookup keeps its button disabled');
	});
});
