import { describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
	computeApiBalance,
	describeAccountBudget,
	fetchAllAccountBudgets,
	formatAccountBudgetLines,
	shouldListAccountBudgets,
	parseAccountBudget,
	type AccountAuthApi,
	type AccountBudgetLabels,
	type AccountBudget,
	type AccountPlanInfo,
	type PlanFetchResult,
} from '../../src/githubAccountBudgets';

const proPlan: AccountPlanInfo = {
	copilot_plan: 'copilot_individual',
	quota_reset_date_utc: '2026-11-01T00:00:00.000Z',
	quota_snapshots: { premium_interactions: { entitlement: 3900, quota_remaining: 2900 } },
};

describe('computeApiBalance', () => {
	test('returns null without an entitlement', () => {
		assert.equal(computeApiBalance(undefined, 10), null);
		assert.equal(computeApiBalance(0, 10), null);
	});

	test('derives used credits and percentage', () => {
		assert.deepEqual(computeApiBalance(39, 2900), {
			budgetUsd: 39, budgetAiCredits: 3900, remainingAiCredits: 2900, usedAiCredits: 1000, pctAvailable: (2900 / 3900) * 100,
		});
	});

	test('treats an unknown remaining figure as fully available and never goes negative', () => {
		assert.equal(computeApiBalance(10, undefined)?.pctAvailable, 100);
		assert.equal(computeApiBalance(10, 5000)?.usedAiCredits, 0);
		assert.equal(computeApiBalance(10, 5000)?.pctAvailable, 100, 'more remaining than the budget is capped at 100%');
		assert.equal(computeApiBalance(10, -50)?.pctAvailable, 0, 'a negative remaining is floored at 0%');
	});
});

describe('parseAccountBudget', () => {
	test('reads the premium quota and plan name', () => {
		const r = parseAccountBudget(proPlan, { copilot_individual: 'Copilot Pro' });
		assert.equal(r.status, 'ok');
		assert.equal(r.planName, 'Copilot Pro');
		assert.equal(r.balance?.budgetUsd, 39);
		assert.equal(r.balance?.usedAiCredits, 1000);
		assert.equal(r.resetDate, '2026-11-01T00:00:00.000Z');
	});

	test('accepts quota_remaining sent as a string', () => {
		const r = parseAccountBudget({ quota_snapshots: { premium_interactions: { entitlement: 1000, quota_remaining: '400' } } });
		assert.equal(r.balance?.remainingAiCredits, 400);
	});

	test('unlimited or missing quota is no-quota', () => {
		assert.equal(parseAccountBudget({ copilot_plan: 'x', quota_snapshots: { premium_interactions: { unlimited: true, entitlement: 0 } } }).status, 'no-quota');
		assert.equal(parseAccountBudget({}).status, 'no-quota');
	});

	test('falls back to the plan id when the plan is unknown', () => {
		assert.equal(parseAccountBudget({ copilot_plan: 'mystery' }).planName, 'mystery');
	});
});

describe('fetchAllAccountBudgets', () => {
	const accounts = [{ id: 'b-id', label: 'bob' }, { id: 'a-id', label: 'alice' }];

	test('uses each account\'s own session token, silently, and sorts by label', async () => {
		const calls: Array<{ account: string; silent: boolean }> = [];
		const auth: AccountAuthApi = {
			getAccounts: async () => accounts,
			getSession: async (_p, scopes, options) => {
				assert.deepEqual([...scopes], ['read:user']);
				calls.push({ account: options.account.id, silent: options.silent });
				return { accessToken: `token-${options.account.label}` };
			},
		};
		const seenTokens: string[] = [];
		const fetchPlan = async (token: string): Promise<PlanFetchResult> => { seenTokens.push(token); return { planInfo: proPlan }; };
		const result = await fetchAllAccountBudgets(auth, 'github', fetchPlan);
		assert.deepEqual(result.map((r) => r.label), ['alice', 'bob']);
		assert.ok(result.every((r) => r.status === 'ok'));
		assert.deepEqual(seenTokens.sort(), ['token-alice', 'token-bob']);
		assert.ok(calls.every((c) => c.silent));
	});

	test('one failing account does not affect the others', async () => {
		const auth: AccountAuthApi = {
			getAccounts: async () => [{ id: '1', label: 'ok-user' }, { id: '2', label: 'no-session' }, { id: '3', label: 'http-fail' }, { id: '4', label: 'throws' }],
			getSession: async (_p, _s, { account }) => {
				if (account.label === 'no-session') { return undefined; }
				if (account.label === 'throws') { throw new Error('boom'); }
				return { accessToken: account.label };
			},
		};
		const fetchPlan = async (token: string): Promise<PlanFetchResult> =>
			token === 'http-fail' ? { statusCode: 404, error: 'HTTP 404' } : { planInfo: proPlan };
		const byLabel = Object.fromEntries((await fetchAllAccountBudgets(auth, 'github', fetchPlan)).map((r) => [r.label, r]));
		assert.equal(byLabel['ok-user'].status, 'ok');
		assert.equal(byLabel['no-session'].status, 'unavailable');
		assert.equal(byLabel['no-session'].reason, 'no-session');
		assert.equal(byLabel['http-fail'].reason, 'lookup-failed');
		assert.match(byLabel['http-fail'].detail ?? '', /HTTP 404/);
		assert.equal(byLabel['throws'].reason, 'error');
		assert.equal(byLabel['throws'].detail, 'boom');
	});

	test('no accounts yields an empty list', async () => {
		const auth: AccountAuthApi = { getAccounts: async () => [], getSession: async () => undefined };
		assert.deepEqual(await fetchAllAccountBudgets(auth, 'github', async () => ({})), []);
	});
});

describe('tooltip formatting', () => {
	const ok: AccountBudget = { accountId: '1', label: 'alice', status: 'ok', planName: 'Copilot Pro', balance: computeApiBalance(39, 2900)! };
	const other: AccountBudget = { accountId: '2', label: 'bob', status: 'unavailable', reason: 'error', detail: 'x' };
	const labels: AccountBudgetLabels = {
		usedLeft: (used, budget, pct) => `${used} / ${budget} used · ${pct}% left`,
		noQuota: 'no metered budget',
		unavailable: 'unavailable',
		noSession: 'sign in',
		lookupFailed: (detail) => `lookup failed (${detail})`,
	};

	test('skips only a lone account that has a balance', () => {
		assert.deepEqual(formatAccountBudgetLines([ok], labels), []);
		assert.equal(shouldListAccountBudgets([]), false);
		assert.equal(shouldListAccountBudgets([ok]), false);
		// A lone account with no balance has nothing else representing it, so it is listed.
		assert.equal(shouldListAccountBudgets([other]), true);
		assert.equal(shouldListAccountBudgets([{ status: 'no-quota' }]), true);
		const noSession: AccountBudget = { accountId: '9', label: 'z', status: 'unavailable', reason: 'no-session' };
		assert.deepEqual(formatAccountBudgetLines([noSession], labels), ['- **z**: sign in']);
	});

	test('a lone account with a balance is listed when the gauge it would duplicate is not shown', () => {
		// e.g. a new user: one signed-in account, no tracked local sessions, so no gauge in the tooltip.
		assert.equal(shouldListAccountBudgets([ok], false), true);
		assert.deepEqual(formatAccountBudgetLines([ok], labels, false), ['- **alice** (Copilot Pro): $10.00 / $39.00 used · 74.4% left']);
		assert.deepEqual(formatAccountBudgetLines([ok], labels, true), []);
		const lines = formatAccountBudgetLines([ok, other], labels);
		assert.equal(lines.length, 2);
		assert.equal(lines[0], '- **alice** (Copilot Pro): $10.00 / $39.00 used · 74.4% left');
		assert.equal(lines[1], '- **bob**: x');
	});

	test('describes each unavailable reason', () => {
		const base = { accountId: '4', label: 'd', status: 'unavailable' } as const;
		assert.equal(describeAccountBudget({ ...base, reason: 'no-session' }, labels), 'sign in');
		assert.equal(describeAccountBudget({ ...base, reason: 'lookup-failed', detail: 'HTTP 404' }, labels), 'lookup failed (HTTP 404)');
		assert.equal(describeAccountBudget({ ...base, reason: 'error', detail: 'boom' }, labels), 'boom');
		assert.equal(describeAccountBudget(base, labels), 'unavailable');
	});

	test('describes no-quota accounts', () => {
		assert.equal(describeAccountBudget({ accountId: '3', label: 'c', status: 'no-quota' }, labels), 'no metered budget');
	});
});
