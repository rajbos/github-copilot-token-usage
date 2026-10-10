import test from 'node:test';
import * as assert from 'node:assert/strict';

import {
	tooltipSecondaryPeriod,
	formatTooltipStatsTable,
	computeCopilotBudgetDisplay,
	buildCopilotBudgetSubRowLabels,
	formatProviderCostTable,
	TOOLTIP_COLUMN_GUTTER,
	type StatusBarDisplaySetting
} from '../../src/extension';
import type { DetailedStats, PeriodStats } from '../../../src/types';

function createPeriodStats(overrides: Partial<PeriodStats> = {}): PeriodStats {
	return {
		tokens: 0,
		thinkingTokens: 0,
		estimatedTokens: 0,
		actualTokens: 0,
		sessions: 0,
		avgInteractionsPerSession: 0,
		avgTokensPerSession: 0,
		modelUsage: {},
		editorUsage: {},
		co2: 0,
		treesEquivalent: 0,
		waterUsage: 0,
		estimatedCost: 0,
		...overrides,
	};
}

function createDetailedStats(overrides: {
	today?: Partial<PeriodStats>;
	month?: Partial<PeriodStats>;
	lastMonth?: Partial<PeriodStats>;
	last30Days?: Partial<PeriodStats>;
} = {}): DetailedStats {
	return {
		today: createPeriodStats(overrides.today),
		month: createPeriodStats(overrides.month),
		lastMonth: createPeriodStats(overrides.lastMonth),
		last30Days: createPeriodStats(overrides.last30Days),
		lastUpdated: new Date()
	};
}

function formatExpectedUsage(n: number, fractionDigits: number, unit: string): string {
	const rounded = Math.round(n * (10 ** fractionDigits)) / (10 ** fractionDigits);
	const format = Math.abs(rounded) >= 1000
		? { minimumFractionDigits: 0, maximumFractionDigits: 0 }
		: { minimumFractionDigits: fractionDigits, maximumFractionDigits: fractionDigits };
	return `${n.toLocaleString(undefined, format)} ${unit}`;
}

test('formatTooltipStatsTable renders 3 columns: Today, Current Month, and Last 30 Days', () => {
	const stats = createDetailedStats({
		today: {
			tokens: 44042172,
			estimatedCostCopilot: 20.54,
			billingGroupCosts: { 'GitHub Copilot': 20.54, 'Anthropic': 19.85 },
			co2: 8808,
			waterUsage: 13213
		},
		month: {
			tokens: 656117347,
			estimatedCostCopilot: 221.94,
			billingGroupCosts: { 'GitHub Copilot': 221.94, 'Anthropic': 64.87 },
			co2: 131223,
			waterUsage: 196835
		},
		last30Days: {
			tokens: 712000000,
			estimatedCostCopilot: 245.50,
			billingGroupCosts: { 'GitHub Copilot': 245.50, 'Anthropic': 70.00 },
			co2: 142000,
			waterUsage: 213000
		}
	});

	const markdown = formatTooltipStatsTable(stats);

	// Check table header and 4-column alignment. The gutter rides on the header cells too, so
	// each header and its values agree on one column width instead of the values alone being
	// padded (which left the header labels butting up against the next column).
	const g = TOOLTIP_COLUMN_GUTTER;
	assert.ok(markdown.includes(`| ${g} | 📅 Today${g} | 📊 Current Month${g} | 📈 Last 30 Days |`));
	assert.ok(markdown.includes('|:---|:---|:---|:---|'));

	// Check Tokens row
	const tToday = (44042172).toLocaleString();
	const tMonth = (656117347).toLocaleString();
	const t30Days = (712000000).toLocaleString();
	assert.ok(markdown.includes(`| Tokens :${g} | ${tToday}${g} | ${tMonth}${g} | ${t30Days} |`));

	// Check GitHub Copilot cost row
	assert.ok(markdown.includes(`| GitHub Copilot cost :${g} | $ 20.54${g} | $ 221.94${g} | $ 245.50 |`));

	// Check All providers cost row (summed)
	assert.ok(markdown.includes(`| All providers cost :${g} | $ 40.39${g} | $ 286.81${g} | $ 315.50 |`));

	// Check CO2 estimated row (>= 1000 hides decimals)
	const co2Today = formatExpectedUsage(8808, 2, 'grams');
	const co2Month = formatExpectedUsage(131223, 2, 'grams');
	const co230Days = formatExpectedUsage(142000, 2, 'grams');
	assert.ok(markdown.includes(`| CO₂ estimated :${g} | ${co2Today}${g} | ${co2Month}${g} | ${co230Days} |`));

	// Check Water estimated row (>= 1000 hides decimals)
	const waterToday = formatExpectedUsage(13213, 3, 'liters');
	const waterMonth = formatExpectedUsage(196835, 3, 'liters');
	const water30Days = formatExpectedUsage(213000, 3, 'liters');
	assert.ok(markdown.includes(`| Water estimated :${g} | ${waterToday}${g} | ${waterMonth}${g} | ${water30Days} |`));
});

test('formatTooltipStatsTable formats small CO2 and water values with decimals', () => {
	const stats = createDetailedStats({
		today: { co2: 12.345, waterUsage: 0.123 },
		month: { co2: 99.5, waterUsage: 5.678 },
		last30Days: { co2: 150.25, waterUsage: 12.345 }
	});

	const markdown = formatTooltipStatsTable(stats);
	const g = TOOLTIP_COLUMN_GUTTER;

	const co2Today = formatExpectedUsage(12.345, 2, 'grams');
	const co2Month = formatExpectedUsage(99.5, 2, 'grams');
	const co230Days = formatExpectedUsage(150.25, 2, 'grams');
	assert.ok(markdown.includes(`| CO₂ estimated :${g} | ${co2Today}${g} | ${co2Month}${g} | ${co230Days} |`));

	const waterToday = formatExpectedUsage(0.123, 3, 'liters');
	const waterMonth = formatExpectedUsage(5.678, 3, 'liters');
	const water30Days = formatExpectedUsage(12.345, 3, 'liters');
	assert.ok(markdown.includes(`| Water estimated :${g} | ${waterToday}${g} | ${waterMonth}${g} | ${water30Days} |`));
});

test('formatTooltipStatsTable hides decimals when value rounds to 1000+', () => {
	const stats = createDetailedStats({
		today: { co2: 999.996, waterUsage: 999.9996 },
		month: { co2: 1000, waterUsage: 1000 },
		last30Days: { co2: 1001, waterUsage: 1001 }
	});

	const markdown = formatTooltipStatsTable(stats);
	const g = TOOLTIP_COLUMN_GUTTER;

	const co2Today = formatExpectedUsage(999.996, 2, 'grams');
	const co2Month = formatExpectedUsage(1000, 2, 'grams');
	const co230Days = formatExpectedUsage(1001, 2, 'grams');
	assert.ok(markdown.includes(`| CO₂ estimated :${g} | ${co2Today}${g} | ${co2Month}${g} | ${co230Days} |`));

	const waterToday = formatExpectedUsage(999.9996, 3, 'liters');
	const waterMonth = formatExpectedUsage(1000, 3, 'liters');
	const water30Days = formatExpectedUsage(1001, 3, 'liters');
	assert.ok(markdown.includes(`| Water estimated :${g} | ${waterToday}${g} | ${waterMonth}${g} | ${water30Days} |`));
});

test('tooltipSecondaryPeriod: default both/none shows last30days', () => {
	assert.equal(tooltipSecondaryPeriod('both', 'none'), 'last30days');
});

test('tooltipSecondaryPeriod: last30days tokens shows last30days', () => {
	assert.equal(tooltipSecondaryPeriod('last30days', 'none'), 'last30days');
});

test('tooltipSecondaryPeriod: both cost setting shows last30days', () => {
	assert.equal(tooltipSecondaryPeriod('none', 'both'), 'last30days');
});

test('tooltipSecondaryPeriod: last30days cost setting shows last30days', () => {
	assert.equal(tooltipSecondaryPeriod('today', 'last30days'), 'last30days');
});

test('tooltipSecondaryPeriod: currentMonth tokens shows currentMonth', () => {
	assert.equal(tooltipSecondaryPeriod('currentMonth', 'none'), 'currentMonth');
});

test('tooltipSecondaryPeriod: todayAndCurrentMonth tokens shows currentMonth', () => {
	assert.equal(tooltipSecondaryPeriod('todayAndCurrentMonth', 'none'), 'currentMonth');
});

test('tooltipSecondaryPeriod: today tokens shows currentMonth', () => {
	assert.equal(tooltipSecondaryPeriod('today', 'none'), 'currentMonth');
});

test('tooltipSecondaryPeriod: none/none shows currentMonth', () => {
	assert.equal(tooltipSecondaryPeriod('none', 'none'), 'currentMonth');
});

test('tooltipSecondaryPeriod: both settings are today shows currentMonth', () => {
	assert.equal(tooltipSecondaryPeriod('today', 'today'), 'currentMonth');
});

test('tooltipSecondaryPeriod: currentMonth tokens and currentMonth cost shows currentMonth', () => {
	assert.equal(tooltipSecondaryPeriod('currentMonth', 'currentMonth'), 'currentMonth');
});

test('tooltipSecondaryPeriod: todayAndCurrentMonth both settings shows currentMonth', () => {
	assert.equal(tooltipSecondaryPeriod('todayAndCurrentMonth', 'todayAndCurrentMonth'), 'currentMonth');
});

// Verify the type export is usable
test('StatusBarDisplaySetting type is exported', () => {
	const val: StatusBarDisplaySetting = 'both';
	assert.equal(val, 'both');
});

// Regression coverage for the "Copilot Budget" tooltip row math: the headline
// $used/$budget figure must include untracked (other devices/cloud) usage so
// it matches the bar's percentage, and "remaining" must account for it too —
// otherwise a user reading only the headline figure sees far more budget left
// than actually remains (see PR discussion: $556.61/$800 read as ~$243 left,
// while the untracked-usage sub-row alone left only ~$41).
test('computeCopilotBudgetDisplay: folds untracked usage into totalUsed and remaining', () => {
	const result = computeCopilotBudgetDisplay(556.61, 800, 759.21);
	assert.ok(Math.abs(result.gapUsd - 202.60) < 1e-9);
	assert.ok(Math.abs(result.totalUsed - 759.21) < 1e-9);
	assert.ok(Math.abs(result.remaining - 40.79) < 1e-9);
	assert.ok(Math.abs(result.trackedRatio - 556.61 / 800) < 1e-9);
	assert.ok(Math.abs(result.gapRatio - 202.60 / 800) < 1e-9);
});

test('computeCopilotBudgetDisplay: no API balance means no gap, remaining is budget minus tracked cost', () => {
	const result = computeCopilotBudgetDisplay(100, 800, null);
	assert.equal(result.gapUsd, 0);
	assert.equal(result.totalUsed, 100);
	assert.equal(result.remaining, 700);
});

test('computeCopilotBudgetDisplay: API-reported usage below tracked cost never produces a negative gap', () => {
	// The API total can lag local tracking; a negative gap would silently
	// shrink totalUsed below the tracked cost, which would be worse than the
	// original bug.
	const result = computeCopilotBudgetDisplay(500, 800, 400);
	assert.equal(result.gapUsd, 0);
	assert.equal(result.totalUsed, 500);
});

test('computeCopilotBudgetDisplay: over budget yields a negative remaining', () => {
	const result = computeCopilotBudgetDisplay(750, 800, 812.34);
	assert.ok(Math.abs(result.gapUsd - 62.34) < 1e-9);
	assert.ok(Math.abs(result.remaining - -12.34) < 1e-9);
});

// The Copilot Budget gauge row got too wide to fit the hover popup on one line, so the figures
// that used to share it are now one short sub-row each: remaining budget moved off the gauge
// row entirely, and the tracked/untracked pair no longer share a single run-on line.
test('buildCopilotBudgetSubRowLabels: tracked, untracked and remaining each get their own line', () => {
	assert.deepEqual(
		buildCopilotBudgetSubRowLabels(668.74, 455.93, 125.33),
		['$668.74 tracked here', '$125.33 untracked (other devices/cloud)', '$455.93 left'],
	);
});

test('buildCopilotBudgetSubRowLabels: no gap leaves only the remaining-budget line', () => {
	// With nothing untracked, "tracked here" would just restate the gauge row's own total.
	assert.deepEqual(buildCopilotBudgetSubRowLabels(100, 700, 0), ['$700.00 left']);
});

test('buildCopilotBudgetSubRowLabels: a sub-cent gap is not worth a split', () => {
	assert.deepEqual(buildCopilotBudgetSubRowLabels(100, 699.99, 0.004), ['$699.99 left']);
});

test('buildCopilotBudgetSubRowLabels: overspending reads as "over", not a negative "left"', () => {
	assert.deepEqual(
		buildCopilotBudgetSubRowLabels(750, -12.34, 62.34),
		['$750.00 tracked here', '$62.34 untracked (other devices/cloud)', '$12.34 over'],
	);
});

// The "💰 Costs by Provider" table renders the section title as its own header row and pads and
// right-aligns the cost column. Both are easy to regress into a table that still parses but looks
// wrong, and neither shows up in a test of the period table, so assert the rendered Markdown.
const MONTH_COSTS = { 'GitHub Copilot': 668.74, 'Mistral AI': 67.03, 'Anthropic': 56.52, 'Other': 0 };
const MONTH_TOTAL = 668.74 + 67.03 + 56.52;
const GAUGE = {
	usedOfBudget: '$794.07 / $1250.00',
	barCell: '[bar]',
	subRowLabels: ['$668.74 tracked here', '$125.33 untracked (other devices/cloud)', '$455.93 left'],
	source: 'Copilot plan quota',
};
/** Records the ratio each provider row asked for, so share math is observable without SVG. */
function shareBarSpy(seen: number[]) {
	return (ratio: number) => { seen.push(ratio); return `[${Math.round(ratio * 100)}%]`; };
}

test('formatProviderCostTable: the section title is the table header, with a right-aligned cost column', () => {
	const lines = formatProviderCostTable(MONTH_COSTS, MONTH_TOTAL, GAUGE, shareBarSpy([])).split('\n');

	// A separate title line above an empty `|  |  |  |` header is what this replaced — the title
	// must be inside the header row, immediately above the alignment row.
	assert.equal(lines[1], '| 💰 Costs by Provider — Current Month |  |  |');
	assert.equal(lines[2], '|:---|---:|:---|');
	assert.ok(!lines.includes('|  |  |  |'), 'the empty header row should be gone');
});

test('formatProviderCostTable: provider rows are ordered by cost and carry the column gutter', () => {
	const g = TOOLTIP_COLUMN_GUTTER;
	const markdown = formatProviderCostTable(MONTH_COSTS, MONTH_TOTAL, GAUGE, shareBarSpy([]));

	const providerRows = markdown.split('\n').filter((line) => line.includes(g) && line.startsWith('| ') && !line.includes('🎯'));
	assert.deepEqual(providerRows, [
		`| GitHub Copilot${g} | $668.74${g} | [84%] |`,
		`| Mistral AI${g} | $67.03${g} | [8%] |`,
		`| Anthropic${g} | $56.52${g} | [7%] |`,
		`| Other${g} | $0.00${g} | [0%] |`,
	]);
});

test('formatProviderCostTable: the budget gauge, its sub-rows and the share heading render in order', () => {
	const g = TOOLTIP_COLUMN_GUTTER;
	const markdown = formatProviderCostTable(MONTH_COSTS, MONTH_TOTAL, GAUGE, shareBarSpy([]));

	const gaugeIndex = markdown.indexOf(`| 🎯 Copilot Budget${g} | $794.07 / $1250.00${g} | [bar] |`);
	assert.ok(gaugeIndex > 0, 'expected the gauge row');
	const subRows = GAUGE.subRowLabels.map((label) => markdown.indexOf(`| &nbsp;&nbsp;↳ ${label} |  |  |`));
	assert.deepEqual(subRows, [...subRows].sort((a, b) => a - b), 'sub-rows keep their given order');
	assert.ok(subRows[0] > gaugeIndex, 'sub-rows follow the gauge row');
	// The heading separates the gauge block from the per-provider rows; it must not drift above it.
	const headingIndex = markdown.indexOf('| **Share of total spend** |  |  |');
	assert.ok(headingIndex > subRows[2], 'the share heading follows the sub-rows');
	assert.ok(headingIndex < markdown.indexOf('| GitHub Copilot'), 'the share heading precedes the providers');
	assert.ok(!markdown.includes('Budget from'), 'the budget-source footnote is no longer rendered');
});

test('formatProviderCostTable: with no budget there is no gauge, share heading or footnote', () => {
	const markdown = formatProviderCostTable(MONTH_COSTS, MONTH_TOTAL, null, shareBarSpy([]));

	assert.ok(!markdown.includes('🎯'), 'no gauge row without a budget');
	assert.ok(!markdown.includes('Share of total spend'), 'the heading only labels the gauge block');
	assert.ok(!markdown.includes('Budget from'), 'no footnote without a budget');
	assert.ok(markdown.includes('| GitHub Copilot'), 'provider rows still render');
});

test('formatProviderCostTable: a zero total spends no ratio rather than dividing by zero', () => {
	const seen: number[] = [];
	const markdown = formatProviderCostTable({ 'GitHub Copilot': 0, 'Anthropic': 0 }, 0, null, shareBarSpy(seen));

	assert.deepEqual(seen, [0, 0], 'every share is 0, never NaN or Infinity');
	assert.ok(!markdown.includes('NaN'));
});

test('formatProviderCostTable: no providers renders nothing at all', () => {
	assert.equal(formatProviderCostTable({}, 0, GAUGE, shareBarSpy([])), '');
});
