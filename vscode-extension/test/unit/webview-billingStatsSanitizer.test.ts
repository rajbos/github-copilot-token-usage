import { describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
	sanitizeCopilotApiBalance,
	sanitizeBillingGroupCosts,
	sanitizeAccountBudgets,
	applyBillingFields,
	type BillingStatsFields,
	type CopilotApiBalance,
} from '../../src/webview/usage/billingStatsSanitizer';

// ── Regression guard for "billing fields dropped on the timer refresh" ─────────────
//
// The usage panel renders copilotApiBalance / monthBillingGroupCosts on initial load,
// but the periodic `updateStats` message runs sanitizeStats(), which rebuilds the stats
// object field-by-field. When those two fields were not copied, the whole "Copilot
// Billing Coverage" section disappeared after the first 5-minute refresh even though the
// extension still had the data. These tests lock in that applyBillingFields() (the helper
// sanitizeStats now calls) carries both fields through a round-trip.

describe('sanitizeCopilotApiBalance', () => {
	test('returns null for non-object input', () => {
		assert.equal(sanitizeCopilotApiBalance(null), null);
		assert.equal(sanitizeCopilotApiBalance(undefined), null);
		assert.equal(sanitizeCopilotApiBalance('nope'), null);
		assert.equal(sanitizeCopilotApiBalance(42), null);
	});

	test('round-trips a fully-populated balance unchanged', () => {
		const balance: CopilotApiBalance = {
			budgetUsd: 39,
			budgetAiCredits: 3900,
			remainingAiCredits: 1234,
			usedAiCredits: 2666,
			pctAvailable: 31.64,
		};
		assert.deepEqual(sanitizeCopilotApiBalance({ ...balance }), balance);
	});

	test('coerces missing / non-finite numeric fields to 0', () => {
		const result = sanitizeCopilotApiBalance({
			budgetUsd: 'bad',
			budgetAiCredits: NaN,
			remainingAiCredits: Infinity,
			// usedAiCredits omitted
			pctAvailable: null,
		});
		assert.deepEqual(result, {
			budgetUsd: 0,
			budgetAiCredits: 0,
			remainingAiCredits: 0,
			usedAiCredits: 0,
			pctAvailable: 0,
		});
	});
});

describe('sanitizeBillingGroupCosts', () => {
	test('returns null for non-object input', () => {
		assert.equal(sanitizeBillingGroupCosts(null), null);
		assert.equal(sanitizeBillingGroupCosts(undefined), null);
		assert.equal(sanitizeBillingGroupCosts('nope'), null);
	});

	test('keeps finite numeric entries and drops the rest', () => {
		const result = sanitizeBillingGroupCosts({
			'GitHub Copilot': 12.5,
			Anthropic: 3,
			bogus: 'x',
			nan: NaN,
			inf: Infinity,
		});
		assert.deepEqual(result, { 'GitHub Copilot': 12.5, Anthropic: 3 });
	});

	test('returns an empty object for an empty map', () => {
		assert.deepEqual(sanitizeBillingGroupCosts({}), {});
	});
});

describe('applyBillingFields (round-trip regression guard)', () => {
	test('carries both billing fields from a full payload onto the target', () => {
		const raw = {
			// unrelated fields that sanitizeStats handles elsewhere
			today: {},
			lastUpdated: '2026-07-26T00:00:00.000Z',
			copilotApiBalance: {
				budgetUsd: 39,
				budgetAiCredits: 3900,
				remainingAiCredits: 1000,
				usedAiCredits: 2900,
				pctAvailable: 25.64,
			},
			monthBillingGroupCosts: { 'GitHub Copilot': 18.2, Anthropic: 4.1 },
		};
		const target: BillingStatsFields = {};
		applyBillingFields(target, raw);

		assert.deepEqual(target.copilotApiBalance, raw.copilotApiBalance);
		assert.deepEqual(target.monthBillingGroupCosts, raw.monthBillingGroupCosts);
	});

	test('leaves the target untouched when the payload has no billing fields', () => {
		const target: BillingStatsFields = {};
		applyBillingFields(target, { today: {}, lastUpdated: 'x' });
		assert.equal('copilotApiBalance' in target, false);
		assert.equal('monthBillingGroupCosts' in target, false);
	});

	test('does not throw on a non-object payload', () => {
		const target: BillingStatsFields = {};
		assert.doesNotThrow(() => applyBillingFields(target, null));
		assert.deepEqual(target, {});
	});

	test('attaches an empty cost map (section still renders) without a balance', () => {
		const target: BillingStatsFields = {};
		applyBillingFields(target, { monthBillingGroupCosts: {} });
		assert.deepEqual(target.monthBillingGroupCosts, {});
		assert.equal(target.copilotApiBalance, undefined);
	});
});

describe('account budgets', () => {
	test('sanitizeAccountBudgets drops malformed entries and normalizes the rest', () => {
		const result = sanitizeAccountBudgets([
			null, 'x', { status: 'ok' },
			{ accountId: '1', label: 'alice', status: 'bogus', balance: { budgetUsd: 39, budgetAiCredits: 3900, remainingAiCredits: 100, usedAiCredits: 3800, pctAvailable: 2.5 } },
		]);
		assert.equal(result.length, 1);
		assert.equal(result[0].status, 'unavailable');
		assert.equal(result[0].balance?.usedAiCredits, 3800);
		assert.deepEqual(sanitizeAccountBudgets('nope'), []);
	});

	test('applyBillingFields keeps accounts across refreshes and lets an empty list clear them', () => {
		const target: BillingStatsFields = {};
		applyBillingFields(target, { accountBudgets: [{ accountId: '1', label: 'alice', status: 'no-quota' }] });
		assert.equal(target.accountBudgets?.length, 1);
		applyBillingFields(target, { accountBudgets: [] });
		assert.deepEqual(target.accountBudgets, []);
		applyBillingFields(target, {});
		assert.deepEqual(target.accountBudgets, []);
	});
});
