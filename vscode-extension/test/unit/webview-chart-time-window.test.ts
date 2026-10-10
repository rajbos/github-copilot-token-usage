import test from 'node:test';
import * as assert from 'node:assert/strict';

import type { ChartPeriodData } from '../../../src/types';
import { filterPeriodByTimeWindow } from '../../src/webview/chart/timeWindowFilter';

const NOW = new Date(2026, 8, 24, 15, 0, 0); // Sep 24, 2026 (local)

function dayKey(d: Date): string {
	return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('-');
}

/** A day period of `days` bars ending today; bar i has value i + 1 so slices are easy to identify. */
function buildDayPeriod(days: number): ChartPeriodData {
	const keys: string[] = [];
	for (let i = days - 1; i >= 0; i--) {
		keys.push(dayKey(new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate() - i)));
	}
	const values = keys.map((_, i) => i + 1);
	const dataset = () => [{ label: 'x', data: [...values] }];
	return {
		labels: [...keys],
		periodKeys: keys,
		tokensData: [...values],
		sessionsData: [...values],
		modelDatasets: dataset(),
		editorDatasets: dataset(),
		repositoryDatasets: dataset(),
		periodCount: keys.length,
		totalTokens: values.reduce((a, b) => a + b, 0),
		totalSessions: values.reduce((a, b) => a + b, 0),
		avgPerPeriod: 0,
		costData: [...values],
		totalCost: values.reduce((a, b) => a + b, 0),
		avgCostPerPeriod: 0,
		taskCategoryDatasets: dataset(),
		taskCategoryTokenDatasets: dataset(),
		taskCategorySessionDatasets: dataset(),
		taskCategoryCostDatasets: dataset(),
		providerTokensDatasets: dataset(),
	};
}

test('last30 on a day period with a year of history keeps only the last 30 days (issue #2187)', () => {
	const period = buildDayPeriod(365);
	const filtered = filterPeriodByTimeWindow(period, 'last30', 'day', NOW);

	assert.equal(filtered.labels.length, 30);
	assert.equal(filtered.periodCount, 30);
	assert.equal(filtered.periodKeys[0], '2026-08-26');
	assert.equal(filtered.periodKeys[29], '2026-09-24');
	// Summary cards read these totals, so they must cover the window, not the full history.
	const expectedTotal = filtered.tokensData.reduce((a, b) => a + b, 0);
	assert.equal(filtered.totalTokens, expectedTotal);
	assert.ok(filtered.totalTokens < period.totalTokens);
	// Cost cards read these too.
	assert.equal(filtered.costData.length, 30);
	const expectedCost = filtered.costData.reduce((a, b) => a + b, 0);
	assert.equal(filtered.totalCost, expectedCost);
	assert.ok(filtered.totalCost < period.totalCost);
	assert.equal(filtered.avgCostPerPeriod, expectedCost / 30);
});

test('every per-bar dataset stays aligned with the filtered labels', () => {
	const filtered = filterPeriodByTimeWindow(buildDayPeriod(365), 'last30', 'day', NOW);
	const datasetFields = [
		'modelDatasets', 'editorDatasets', 'repositoryDatasets', 'providerTokensDatasets',
		'taskCategoryDatasets', 'taskCategoryTokenDatasets', 'taskCategorySessionDatasets', 'taskCategoryCostDatasets',
	] as const;
	for (const field of datasetFields) {
		const datasets = filtered[field] as Array<{ data: number[] }>;
		assert.equal(datasets[0].data.length, filtered.labels.length, `${field} length`);
		assert.deepEqual(datasets[0].data, filtered.tokensData, `${field} values`);
	}
});

test('last30 on a day period with exactly 30 days returns all bars', () => {
	const filtered = filterPeriodByTimeWindow(buildDayPeriod(30), 'last30', 'day', NOW);
	assert.equal(filtered.labels.length, 30);
});

test('last7 and allTime on a day period', () => {
	const period = buildDayPeriod(365);
	assert.equal(filterPeriodByTimeWindow(period, 'last7', 'day', NOW).labels.length, 7);
	assert.equal(filterPeriodByTimeWindow(period, 'allTime', 'day', NOW).labels.length, 365);
});

test('legacy payload with empty costData yields zero cost, not NaN', () => {
	const period = { ...buildDayPeriod(60), costData: [], locData: [], linesAddedData: [], linesRemovedData: [], totalLinesAdded: 0, totalLinesRemoved: 0, avgLocPerPeriod: 0 };
	const filtered = filterPeriodByTimeWindow(period, 'last30', 'day', NOW);
	assert.equal(filtered.costData.length, 30);
	assert.ok(filtered.costData.every(v => v === 0));
	assert.equal(filtered.totalCost, 0);
	assert.equal(filtered.avgCostPerPeriod, 0);
	assert.equal(filtered.totalLinesAdded, 0);
	assert.equal(filtered.totalLinesRemoved, 0);
	assert.equal(filtered.avgLocPerPeriod, 0);
});

/** A week period of `weeks` bars keyed by Monday, ending with the current week. */
function buildWeekPeriod(weeks: number): ChartPeriodData {
	const day = NOW.getDay();
	const thisMonday = new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate() - (day === 0 ? 6 : day - 1));
	const keys: string[] = [];
	for (let i = weeks - 1; i >= 0; i--) {
		keys.push(dayKey(new Date(thisMonday.getFullYear(), thisMonday.getMonth(), thisMonday.getDate() - 7 * i)));
	}
	const values = keys.map((_, i) => i + 1);
	return {
		labels: [...keys], periodKeys: keys, tokensData: [...values], sessionsData: [...values],
		modelDatasets: [], editorDatasets: [], repositoryDatasets: [], periodCount: keys.length,
		totalTokens: values.reduce((a, b) => a + b, 0), totalSessions: values.reduce((a, b) => a + b, 0),
		avgPerPeriod: 0, costData: [...values], totalCost: values.reduce((a, b) => a + b, 0), avgCostPerPeriod: 0,
	};
}

test('today with week aggregation keeps only the current week, not full history', () => {
	// NOW is a Thursday, so no week key equals today's date.
	const filtered = filterPeriodByTimeWindow(buildWeekPeriod(52), 'today', 'week', NOW);
	assert.deepEqual(filtered.periodKeys, ['2026-09-21']);
});

test('week aggregation keeps the partial week the window starts in', () => {
	// last7 starts Fri 2026-09-18, which falls in the week of Mon 2026-09-14.
	const filtered = filterPeriodByTimeWindow(buildWeekPeriod(52), 'last7', 'week', NOW);
	assert.deepEqual(filtered.periodKeys, ['2026-09-14', '2026-09-21']);
	// currentMonth starts Tue 2026-09-01, in the week of Mon 2026-08-31.
	assert.equal(filterPeriodByTimeWindow(buildWeekPeriod(52), 'currentMonth', 'week', NOW).periodKeys[0], '2026-08-31');
});
