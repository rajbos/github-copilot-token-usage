import { describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import { buildFilterPillGroupHtml } from '../../src/webview/usage/sessionFilterBar';

describe('buildFilterPillGroupHtml', () => {
	const items = [
		{ value: 'Copilot CLI', label: 'Copilot CLI', count: 2 },
		{ value: 'Claude Code', label: 'Claude Code', count: 1 },
	];

	test('renders nothing for an empty group', () => {
		assert.equal(buildFilterPillGroupHtml('Editor', 'editor', [], new Set()), '');
	});

	test('puts the label and the pills in separate cells so rows align', () => {
		const html = buildFilterPillGroupHtml('Editor', 'editor', items, new Set());
		assert.match(html, /<span class="session-filter-group-label">Editor<\/span><div class="session-filter-pills">/);
		assert.equal((html.match(/session-filter-pill"/g) ?? []).length + (html.match(/session-filter-pill active"/g) ?? []).length, 2);
	});

	test('marks only active values as pressed and pluralises the tooltip', () => {
		const html = buildFilterPillGroupHtml('Editor', 'editor', items, new Set(['Claude Code']));
		assert.match(html, /session-filter-pill active" data-filter-type="editor" data-filter-value="Claude Code" aria-pressed="true" title="Claude Code: 1 session"/);
		assert.match(html, /data-filter-value="Copilot CLI" aria-pressed="false" title="Copilot CLI: 2 sessions"/);
	});

	test('escapes values and labels', () => {
		const html = buildFilterPillGroupHtml('Model', 'model', [{ value: 'a"<b>', label: '<b>x</b>', count: 1 }], new Set());
		assert.ok(!html.includes('<b>'));
		assert.match(html, /data-filter-value="a&quot;&lt;b&gt;"/);
	});
});
