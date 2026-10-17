/**
 * Per-account Copilot budget lookup.
 *
 * VS Code can hold several GitHub accounts at once. `authentication.getSession()` without an
 * `account` only ever returns the one VS Code prefers for this extension, so budget info for
 * the other accounts was invisible. This module enumerates every signed-in account via
 * `authentication.getAccounts()`, fetches a session for each (silently, never prompting) and
 * reads the premium-interactions quota from `copilot_internal/user`.
 *
 * Pure of any `vscode` import: the authentication API and plan fetcher are injected, so it is
 * unit-testable in Node.
 */

/** The slice of `vscode.authentication` this module needs. */
export interface AccountAuthApi {
	getAccounts(providerId: string): PromiseLike<ReadonlyArray<{ id: string; label: string }>>;
	getSession(
		providerId: string,
		scopes: readonly string[],
		options: { silent: true; account: { id: string; label: string } },
	): PromiseLike<{ accessToken: string } | undefined>;
}

/** The slice of the `copilot_internal/user` response we read. */
export interface AccountPlanInfo {
	copilot_plan?: string;
	quota_reset_date_utc?: string;
	quota_reset_date?: string;
	quota_snapshots?: Record<string, {
		/** Typed `string` upstream, but the API sends a number; both are accepted. */
		entitlement?: number | string | null;
		quota_remaining?: number | string | null;
		unlimited?: boolean;
	} | undefined>;
}

export type PlanFetchResult = { planInfo?: AccountPlanInfo; statusCode?: number; error?: string };

/** Copilot API quota balance (monthly entitlement vs. what is left), all amounts derived from AI Credits. */
export interface ApiBalance {
	/** Monthly budget in USD (entitlement / 100). */
	budgetUsd: number;
	/** Monthly budget in AI Credits (budgetUsd * 100). */
	budgetAiCredits: number;
	/** Raw quota_remaining from the API (AI Credits). */
	remainingAiCredits: number;
	/** budgetAiCredits - remainingAiCredits, never negative. */
	usedAiCredits: number;
	/** Percentage of the budget still available, clamped to 0–100. */
	pctAvailable: number;
}

/**
 * Builds the balance from a USD entitlement and optional remaining credits. Without a known
 * remaining figure the whole budget counts as available. Returns null with no entitlement.
 */
export function computeApiBalance(budgetUsd: number | undefined, remainingAiCredits: number | undefined): ApiBalance | null {
	if (!budgetUsd) { return null; }
	const budgetAiCredits = Math.round(budgetUsd * 100);
	const remaining = remainingAiCredits ?? budgetAiCredits;
	const usedAiCredits = Math.max(0, budgetAiCredits - remaining);
	// Clamped: an out-of-range quota_remaining must not render as "500% left" or a negative percentage.
	const pctAvailable = budgetAiCredits > 0 ? Math.min(100, Math.max(0, (remaining / budgetAiCredits) * 100)) : 0;
	return { budgetUsd, budgetAiCredits, remainingAiCredits: remaining, usedAiCredits, pctAvailable };
}

/**
 * - `ok`: a metered premium quota was found.
 * - `no-quota`: the account has a Copilot plan but no metered quota (unlimited, or none reported).
 * - `unavailable`: no token could be obtained silently, or the plan lookup failed.
 */
export type AccountBudgetStatus = 'ok' | 'no-quota' | 'unavailable';

export interface AccountBudget {
	accountId: string;
	/** The account's GitHub login (VS Code's account label). */
	label: string;
	status: AccountBudgetStatus;
	planId?: string;
	planName?: string;
	balance?: ApiBalance;
	/** ISO date the quota resets, when the API reports it. */
	resetDate?: string;
	/** Why `status` is `unavailable`. A code, not prose, so each surface can localize it. */
	reason?: 'no-session' | 'lookup-failed' | 'error';
	/** Technical detail for the reason (e.g. "HTTP 404", or an exception message). Not localized. */
	detail?: string;
}

/** Turns one account's plan response into an AccountBudget (without the identity fields). */
export function parseAccountBudget(
	planInfo: AccountPlanInfo,
	planNames: Record<string, string> = {},
): Pick<AccountBudget, 'status' | 'planId' | 'planName' | 'balance' | 'resetDate'> {
	const planId = planInfo.copilot_plan;
	const planName = planId ? (planNames[planId] ?? planId) : undefined;
	const resetDate = planInfo.quota_reset_date_utc ?? planInfo.quota_reset_date;
	const quota = planInfo.quota_snapshots?.premium_interactions;
	const entitlementRaw = quota && !quota.unlimited && quota.entitlement !== null && quota.entitlement !== '' ? Number(quota.entitlement) : undefined;
	const entitlement = entitlementRaw !== undefined && Number.isFinite(entitlementRaw) ? entitlementRaw : undefined;
	const remainingRaw = quota?.quota_remaining;
	const remaining = remainingRaw === null || remainingRaw === undefined || remainingRaw === '' ? undefined : Number(remainingRaw);
	const balance = computeApiBalance(
		entitlement === undefined ? undefined : entitlement / 100,
		remaining !== undefined && Number.isFinite(remaining) ? remaining : undefined,
	);
	return balance
		? { status: 'ok', planId, planName, balance, resetDate }
		: { status: 'no-quota', planId, planName, resetDate };
}

/**
 * Fetches budget info for every account the user has signed in with in VS Code. One account
 * failing never affects the others, and no call here ever prompts the user.
 */
export async function fetchAllAccountBudgets(
	auth: AccountAuthApi,
	providerId: string,
	fetchPlan: (token: string) => Promise<PlanFetchResult>,
	planNames: Record<string, string> = {},
): Promise<AccountBudget[]> {
	const accounts = await auth.getAccounts(providerId);
	const results = await Promise.all(accounts.map((account) => fetchOneAccountBudget(auth, providerId, account, fetchPlan, planNames)));
	return results.sort((a, b) => a.label.localeCompare(b.label));
}

async function fetchOneAccountBudget(
	auth: AccountAuthApi,
	providerId: string,
	account: { id: string; label: string },
	fetchPlan: (token: string) => Promise<PlanFetchResult>,
	planNames: Record<string, string>,
): Promise<AccountBudget> {
	const base = { accountId: account.id, label: account.label };
	try {
		const session = await auth.getSession(providerId, ['read:user'], { silent: true, account });
		if (!session) {
			return { ...base, status: 'unavailable', reason: 'no-session' };
		}
		const { planInfo, error, statusCode } = await fetchPlan(session.accessToken);
		if (error || !planInfo) {
			return { ...base, status: 'unavailable', reason: 'lookup-failed', detail: error ?? (statusCode ? `HTTP ${statusCode}` : 'no data') };
		}
		return { ...base, ...parseAccountBudget(planInfo, planNames) };
	} catch (err) {
		return { ...base, status: 'unavailable', reason: 'error', detail: err instanceof Error ? err.message : String(err) };
	}
}

/** Display strings for the tooltip, supplied by the caller so they can be localized. */
export interface AccountBudgetLabels {
	usedLeft(used: string, budget: string, pctLeft: string): string;
	noQuota: string;
	unavailable: string;
	/** Shown when no silent session exists for the account. */
	noSession: string;
	lookupFailed(detail: string): string;
}

/** One-line summary of an account's budget, e.g. "$12.30 / $39.00 used · 68.5% left". */
export function describeAccountBudget(b: AccountBudget, labels: AccountBudgetLabels): string {
	if (b.status === 'ok' && b.balance) {
		return labels.usedLeft(`$${(b.balance.usedAiCredits / 100).toFixed(2)}`, `$${b.balance.budgetUsd.toFixed(2)}`, b.balance.pctAvailable.toFixed(1));
	}
	if (b.status === 'no-quota') { return labels.noQuota; }
	if (b.reason === 'no-session') { return labels.noSession; }
	if (b.reason === 'lookup-failed') { return labels.lookupFailed(b.detail ?? ''); }
	return b.detail ?? labels.unavailable;
}

/**
 * Whether the per-account list adds anything. It is redundant only for a lone account that has a
 * balance, because the existing Copilot Budget gauge / API balance card already shows exactly that.
 * A lone account without a balance (no silent session, failed lookup, no metered quota) has nothing
 * else representing it, so it is listed to explain why.
 *
 * `shownElsewhere` says whether the surface in question actually rendered that existing figure. The
 * tooltip gauge, for instance, is absent when there are no local cost groups or no budget, and a lone
 * account's budget must not vanish then.
 */
export function shouldListAccountBudgets(
	budgets: ReadonlyArray<{ status: AccountBudgetStatus; balance?: unknown }>,
	shownElsewhere = true,
): boolean {
	if (budgets.length === 0) { return false; }
	return !(shownElsewhere && budgets.length === 1 && budgets[0].status === 'ok' && !!budgets[0].balance);
}

/** Markdown bullet lines for the status bar tooltip; empty when {@link shouldListAccountBudgets} says so. */
export function formatAccountBudgetLines(budgets: readonly AccountBudget[], labels: AccountBudgetLabels, gaugeShown = true): string[] {
	if (!shouldListAccountBudgets(budgets, gaugeShown)) { return []; }
	return budgets.map((b) => {
		const plan = b.planName ? ` (${b.planName})` : '';
		return `- **${b.label}**${plan}: ${describeAccountBudget(b, labels)}`;
	});
}
