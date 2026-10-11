import { describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
	billingOtherSessionsCostUsd,
	billingExtGroupCostsHtml,
} from '../../src/webview/usage/billingCoverage';
import type { CopilotApiBalance } from '../../src/webview/usage/billingStatsSanitizer';
import { setFormatLocale } from '../../src/webview/shared/formatUtils';

// Lock the locale so cost assertions ("$4.00") don't depend on the machine's default locale.
setFormatLocale('en-US');

// ── Coverage for the "other sessions" billing row (PR #1872) ──────────────────
//
// The AI Billing Coverage table shows what the extension tracks locally versus what the
// Copilot API reports across all channels. The gap between the two is rendered as a
// "GitHub Copilot - other sessions" row. These tests lock in the two behaviors that
// would otherwise regress silently:
//   - the Math.max(0, ...) clamp in billingOtherSessionsCostUsd (API reporting *less*
//     than the locally tracked cost must not produce a negative row), and
//   - the api-null guard (no API quota snapshot yet → no other-sessions row, no crash).

function makeApi(usedAiCredits: number): CopilotApiBalance {
	return {
		budgetUsd: 39,
		budgetAiCredits: 3900,
		remainingAiCredits: 3900 - usedAiCredits,
		usedAiCredits,
		pctAvailable: ((3900 - usedAiCredits) / 3900) * 100,
	};
}

describe('billingOtherSessionsCostUsd', () => {
	test('returns 0 when api is null or undefined', () => {
		const groupCosts = { 'GitHub Copilot': 5 };
		assert.equal(billingOtherSessionsCostUsd(groupCosts, null), 0);
		assert.equal(billingOtherSessionsCostUsd(groupCosts, undefined), 0);
	});

	test('clamps to 0 when the API reports less than the local GitHub Copilot cost', () => {
		// API reports $4.00 used, but local sessions already account for $5.00.
		const groupCosts = { 'GitHub Copilot': 5 };
		assert.equal(billingOtherSessionsCostUsd(groupCosts, makeApi(400)), 0);
	});

	test('returns the positive difference when the API reports more than locally tracked', () => {
		// API reports $10.00 used, local sessions account for $6.00 → $4.00 elsewhere.
		const groupCosts = { 'GitHub Copilot': 6 };
		assert.equal(billingOtherSessionsCostUsd(groupCosts, makeApi(1000)), 4);
	});

	test('treats a missing GitHub Copilot key as 0 local cost', () => {
		// API reports $10.00 used, no local Copilot sessions at all → full $10.00 elsewhere.
		const groupCosts = { 'Claude Code': 3 };
		assert.equal(billingOtherSessionsCostUsd(groupCosts, makeApi(1000)), 10);
	});

	test('returns 0 when api reports zero usage', () => {
		assert.equal(billingOtherSessionsCostUsd({}, makeApi(0)), 0);
	});
});

describe('billingExtGroupCostsHtml', () => {
	test('includes the other-sessions row when the gap exceeds the display threshold', () => {
		// API reports $10.00 used, local Copilot cost $6.00 → $4.00 gap.
		const html = billingExtGroupCostsHtml({ 'GitHub Copilot': 6 }, makeApi(1000));
		assert.ok(html.includes('GitHub Copilot - other sessions'), 'expected the other-sessions row');
		assert.ok(html.includes('$4.00'), 'expected the gap cost in the row');
	});

	test('omits the other-sessions row when the gap is at or below the display threshold', () => {
		// Zero gap: API reports exactly the locally tracked $6.00.
		assert.ok(
			!billingExtGroupCostsHtml({ 'GitHub Copilot': 6 }, makeApi(600)).includes('other sessions'),
			'did not expect the other-sessions row for a zero gap',
		);
		// Positive gap below the 0.001 threshold: API reports $6.0005 used.
		assert.ok(
			!billingExtGroupCostsHtml({ 'GitHub Copilot': 6 }, makeApi(600.05)).includes('other sessions'),
			'did not expect the other-sessions row for a sub-threshold gap',
		);
	});

	test('total includes the other-sessions cost', () => {
		// $6.00 local Copilot + $3.00 Claude Code + $4.00 other sessions → $13.00 total.
		const html = billingExtGroupCostsHtml(
			{ 'GitHub Copilot': 6, 'Claude Code': 3 },
			makeApi(1000),
		);
		assert.ok(html.includes('$13.00'), 'expected the total to include the other-sessions cost');
	});

	test('renders the other-sessions row when there is no local Copilot row', () => {
		const html = billingExtGroupCostsHtml({ 'Claude Code': 3 }, makeApi(1000));
		assert.ok(html.includes('GitHub Copilot - other sessions'), 'expected the other-sessions row');
		assert.ok(!html.includes('GitHub Copilot - local sessions'), 'did not expect a local Copilot row');
		assert.ok(html.includes('$13.00'), 'expected the total to include the other-sessions cost');
	});

	test('api-null path renders without the other-sessions row and without crashing', () => {
		const html = billingExtGroupCostsHtml({ 'GitHub Copilot': 6 }, null);
		assert.ok(!html.includes('other sessions'), 'did not expect the other-sessions row');
		assert.ok(html.includes('GitHub Copilot - local sessions'), 'expected the local Copilot row');
		assert.ok(html.includes('$6.00'), 'expected the total to equal the local cost only');
	});

	test('the other-sessions row sits muted under the local Copilot row, with the total in the footer', () => {
		const html = billingExtGroupCostsHtml({ 'Claude Code': 9, 'GitHub Copilot': 6 }, makeApi(1000));
		const body = html.match(/<tbody>(.*?)<\/tbody>/s)?.[1] ?? '';
		const labels = [...body.matchAll(/<tr[^>]*><td>([^<]*)<\/td>/g)].map(m => m[1]);
		assert.deepEqual(labels, [
			'Claude Code',
			'GitHub Copilot - local sessions',
			'GitHub Copilot - other sessions (remote or different environment)',
		], 'providers by cost, the API gap directly under the local Copilot row');
		assert.match(body, /<tr class="data-table-muted"><td>GitHub Copilot - other sessions/);
		assert.match(html, /<tfoot><tr class="data-table-footer-row"><td>Total<\/td><td class="data-table-align-right">\$19\.00<\/td><\/tr><\/tfoot>/);
		assert.ok(!html.includes('data-table-sort='), 'a bounded summary with a meaningful row order is not sortable');
	});
});
