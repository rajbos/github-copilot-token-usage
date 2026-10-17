import test from 'node:test';
import * as assert from 'node:assert/strict';

import { getAllProviders, getFilterableProviders, getActiveExcludedProviders, type ProviderStats } from '../../src/webview/details/providerFilter';

function stats(periods: Partial<Record<keyof ProviderStats, Record<string, number>>>): ProviderStats {
	return {
		today: { billingGroupCosts: periods.today },
		last30Days: { billingGroupCosts: periods.last30Days },
		month: { billingGroupCosts: periods.month },
		lastMonth: { billingGroupCosts: periods.lastMonth },
	};
}

test('getAllProviders: unions every period and sorts GitHub Copilot first', () => {
	const result = getAllProviders(stats({ month: { OpenAI: 1, 'GitHub Copilot': 2 }, lastMonth: { Anthropic: 3 } }));
	assert.deepEqual(result, ['GitHub Copilot', 'Anthropic', 'OpenAI']);
});

test('getAllProviders: picks up a provider that appears in only one period, for each period', () => {
	for (const period of ['today', 'last30Days', 'month', 'lastMonth'] as const) {
		const result = getAllProviders(stats({ month: { 'GitHub Copilot': 1 }, [period]: { 'GitHub Copilot': 1, OpenAI: 2 } }));
		assert.deepEqual(result, ['GitHub Copilot', 'OpenAI'], `OpenAI only in ${period}`);
	}
});

test('getAllProviders: returns an empty list when no period has a breakdown', () => {
	assert.deepEqual(getAllProviders(stats({})), []);
});

test('getFilterableProviders: lists providers with cost this month when there are two or more', () => {
	const result = getFilterableProviders(stats({ month: { 'GitHub Copilot': 5, Anthropic: 682, OpenAI: 0 } }));
	assert.deepEqual(result, ['GitHub Copilot', 'Anthropic']);
});

test('getFilterableProviders: is empty when only one provider has cost this month (panel hidden)', () => {
	// Anthropic appears in other periods but has no cost this month — nothing to compare.
	const result = getFilterableProviders(stats({ month: { 'GitHub Copilot': 5, Anthropic: 0 }, lastMonth: { Anthropic: 40 } }));
	assert.deepEqual(result, []);
});

test('getActiveExcludedProviders: ignores saved exclusions when the panel is hidden (issue #2198)', () => {
	const filterable = getFilterableProviders(stats({ today: { 'GitHub Copilot': 3 }, month: { 'GitHub Copilot': 682 } }));
	assert.deepEqual([...getActiveExcludedProviders(['GitHub Copilot'], filterable)], []);
});

test('getActiveExcludedProviders: keeps only exclusions for providers that have a visible card', () => {
	const filterable = ['GitHub Copilot', 'Anthropic'];
	const active = getActiveExcludedProviders(new Set(['Anthropic', 'Google']), filterable);
	assert.deepEqual([...active], ['Anthropic']);
});
