import { describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import { buildShareCardData } from '../../src/shareCardData';
import { buildToolboxCardHtml, buildToolboxSummaryText } from '../../src/webview/maturity/toolboxCard';
import type { DetailedStats, PeriodStats } from '../../../src/types';
import { aggregatePeriodStats, type SessionAggregateInput, type UtcDateRanges } from '../../../src/statsHelpers';

function period(sessions: number, tokens: number, editorUsage: PeriodStats['editorUsage']): PeriodStats {
	return { tokens, sessions, editorUsage } as PeriodStats;
}

const stats = {
	today: period(1, 500, { 'VS Code': { tokens: 500, sessions: 1, interactions: 4 } }),
	month: period(0, 0, {}),
	lastMonth: period(5, 9000, {}),
	last30Days: period(6, 12_345, {
		'Claude Code': { tokens: 2000, sessions: 2, interactions: 10 },
		'VS Code': { tokens: 9000, sessions: 4, interactions: 30 },
		'Idle Editor': { tokens: 0, sessions: 0, interactions: 0 },
		'Legacy Editor': { tokens: 100, sessions: 1 },
	}),
} as unknown as DetailedStats;

describe('buildShareCardData', () => {
	test('returns undefined until the aggregated stats exist', () => {
		assert.equal(buildShareCardData(undefined), undefined);
	});

	test('offers exactly the periods the aggregate covers, last 30 days first', () => {
		const data = buildShareCardData(stats)!;
		assert.deepEqual(data.map((d) => d.period), ['last30', 'today', 'currentMonth', 'lastMonth']);
	});

	test('sums sessions, tokens and per-editor interactions for the whole period', () => {
		const last30 = buildShareCardData(stats)!.find((d) => d.period === 'last30')!;
		assert.equal(last30.sessions, 6);
		assert.equal(last30.tokens, 12_345);
		assert.equal(last30.interactions, 40, 'a missing interactions value counts as 0');
	});

	test('lists active editors busiest first and drops editors with no sessions', () => {
		const last30 = buildShareCardData(stats)!.find((d) => d.period === 'last30')!;
		assert.deepEqual(last30.editors, [
			{ name: 'VS Code', sessions: 4 },
			{ name: 'Claude Code', sessions: 2 },
			{ name: 'Legacy Editor', sessions: 1 },
		]);
	});

	test('keeps an empty period (no editors) so the card can explain it', () => {
		const month = buildShareCardData(stats)!.find((d) => d.period === 'currentMonth')!;
		assert.deepEqual(month, { period: 'currentMonth', sessions: 0, interactions: 0, tokens: 0, editors: [] });
	});
});

describe('toolbox card rendering', () => {
	const last30 = buildShareCardData(stats)!.find((d) => d.period === 'last30')!;

	test('summary text names the editors, totals and period', () => {
		const text = buildToolboxSummaryText(last30);
		assert.match(text, /^My AI Coding Toolbox — 3 editors detected: /);
		assert.match(text, /VS Code \(4\)/);
		assert.match(text, /6 sessions, 40 interactions, .* tokens in the last 30 days\. #AIEngineeringFluency$/);
	});

	test('card shows the period label and escapes editor names', () => {
		const html = buildToolboxCardHtml({ ...last30, editors: [{ name: '<img src=x>', sessions: 1 }] });
		assert.match(html, /Last 30 days · 1 editor detected/);
		assert.ok(!html.includes('<img src=x>'), 'editor names must be escaped');
		assert.match(html, /id="btn-share-card-linkedin"/);
		assert.match(html, /id="btn-copy-toolbox-summary"/);
	});

	test('an empty period shows a notice instead of a blank card', () => {
		const html = buildToolboxCardHtml({ period: 'today', sessions: 0, interactions: 0, tokens: 0, editors: [] });
		assert.match(html, /No session activity in this period/);
	});
});

describe('aggregate to card', () => {
	test('a session spanning two days shows as one session with all of its interactions', () => {
		const ranges = { todayUtcKey: '2025-03-15', monthUtcStartKey: '2025-03-01', lastMonthUtcStartKey: '2025-02-01', lastMonthUtcEndKey: '2025-02-28', last30DaysUtcStartKey: '2025-02-14', last30DaysStartMs: Date.UTC(2025, 1, 14), lastMonthStartMs: Date.UTC(2025, 1, 1) } as UtcDateRanges;
		const input = {
			editorType: 'vscode',
			mtime: Date.UTC(2025, 2, 15, 10),
			sessionData: {
				tokens: 150, actualTokens: 0, thinkingTokens: 0, interactions: 5, modelUsage: {}, contextReferences: {}, mcpTools: { total: 0, byServer: {}, byTool: {} },
				dailyRollups: {
					'2025-03-14': { tokens: 100, actualTokens: 0, thinkingTokens: 0, interactions: 3, modelUsage: {} },
					'2025-03-15': { tokens: 50, actualTokens: 0, thinkingTokens: 0, interactions: 2, modelUsage: {} },
				},
			},
		} as unknown as SessionAggregateInput;
		const agg = aggregatePeriodStats([input], ranges);
		const card = buildShareCardData({ today: agg.todayStats, month: agg.monthStats, lastMonth: agg.lastMonthStats, last30Days: agg.last30DaysStats } as unknown as DetailedStats)!;
		const last30 = card.find((d) => d.period === 'last30')!;
		assert.deepEqual(last30.editors, [{ name: 'vscode', sessions: 1 }]);
		assert.equal(last30.sessions, 1);
		assert.equal(last30.interactions, 5);
		assert.equal(card.find((d) => d.period === 'today')!.interactions, 2);
	});
});

describe('toolbox summary phrasing', () => {
	test('"today" reads without an article', () => {
		const text = buildToolboxSummaryText({ period: 'today', sessions: 1, interactions: 2, tokens: 3, editors: [{ name: 'VS Code', sessions: 1 }] });
		assert.match(text, /tokens today\. #AIEngineeringFluency$/);
		assert.ok(!/in the today/.test(text));
	});

	test('an empty period does not print a dangling editor list', () => {
		const text = buildToolboxSummaryText({ period: 'lastMonth', sessions: 0, interactions: 0, tokens: 0, editors: [] });
		assert.match(text, /^My AI Coding Toolbox — 0 editors detected\. 0 sessions/);
		assert.match(text, /in the previous month\./);
	});
});
