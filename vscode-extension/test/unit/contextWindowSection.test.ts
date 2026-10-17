import test from 'node:test';
import * as assert from 'node:assert/strict';
import { buildContextWindowSectionHtml, NEAR_LIMIT_PERCENT, type ContextWindowSectionStats } from '../../src/webview/usage/contextWindowSection';

const emptyStats: ContextWindowSectionStats = { today: {}, last30Days: {}, lastMonth: {} };

test('NEAR_LIMIT_PERCENT is a whole percentage', () => {
	assert.ok(Number.isInteger(NEAR_LIMIT_PERCENT));
	assert.ok(NEAR_LIMIT_PERCENT > 0 && NEAR_LIMIT_PERCENT <= 100);
});

test('buildContextWindowSectionHtml renders three "No data" columns for empty stats', () => {
	const html = buildContextWindowSectionHtml(emptyStats);
	assert.ok(html.includes('id="section-context-window"'));
	assert.equal(html.split('No data').length - 1, 3);
	assert.ok(!html.includes('automatic-compactions-card'));
});

test('buildContextWindowSectionHtml shows the largest request for a period', () => {
	const html = buildContextWindowSectionHtml({
		...emptyStats,
		today: {
			contextWindow: {
				maxRequestInputTokens: 123456,
				maxRequestModels: ['unknown-model'],
				tierCounts: {},
			} as never,
		},
	});
	assert.ok(html.includes('Largest request'));
	assert.ok(html.includes('123,456') || html.includes('123456') || html.includes('123.456'));
});

test('buildContextWindowSectionHtml renders automatic compactions by source', () => {
	const html = buildContextWindowSectionHtml({
		...emptyStats,
		autoCompactionsLast7Days: { total: 5, bySource: { copilotCli: 3, claude: 2 } } as never,
	});
	assert.ok(html.includes('automatic-compactions-card'));
	assert.ok(html.includes('GitHub Copilot CLI'));
	assert.ok(html.includes('Claude'));
});
