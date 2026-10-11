/**
 * Pure helpers for the "AI Billing Coverage" provider-cost table in the usage panel.
 * Extracted from main.ts (no DOM / CSS dependencies) so they can be unit-tested in Node.js.
 *
 * billingOtherSessionsCostUsd() computes the Copilot spend the API reports but the extension
 * has no local session data for (github.com/copilot web chat, cloud agent, review agent, or a
 * different device/environment). billingExtGroupCostsHtml() renders the extension-tracked
 * provider→cost table, injecting an "other sessions" row when that gap exceeds the display
 * threshold.
 */

import { renderDataTable } from '../shared/dataTable';
import { escapeHtml, formatFixed } from '../shared/formatUtils';
import type { CopilotApiBalance } from './billingStatsSanitizer';

/** Cost of Copilot usage the API reports but the extension has no local session data for
 *  (github.com/copilot web chat, cloud agent, review agent, or a different device/environment). */
export function billingOtherSessionsCostUsd(groupCosts: Record<string, number>, api: CopilotApiBalance | null | undefined): number {
	if (!api) { return 0; }
	const copilotCostUsd = groupCosts['GitHub Copilot'] ?? 0;
	return Math.max(0, (api.usedAiCredits * 0.01) - copilotCostUsd);
}

export const BILLING_EXT_GROUP_COSTS_TABLE_ID = 'billing-ext-group-costs';

interface BillingCostRow { label: string; cost: number; muted: boolean; }

/** Provider rows by descending cost, with the "other sessions" row right after the local Copilot row. */
function billingCostRows(groupCosts: Record<string, number>, otherSessionsCostUsd: number): BillingCostRow[] {
	const otherSessions: BillingCostRow[] = otherSessionsCostUsd > 0.001
		? [{ label: 'GitHub Copilot - other sessions (remote or different environment)', cost: otherSessionsCostUsd, muted: true }]
		: [];
	const rows = Object.entries(groupCosts)
		.sort(([, a], [, b]) => b - a)
		.flatMap(([group, cost]) => group === 'GitHub Copilot'
			? [{ label: 'GitHub Copilot - local sessions', cost, muted: false }, ...otherSessions]
			: [{ label: group, cost, muted: false }]);
	return 'GitHub Copilot' in groupCosts ? rows : [...rows, ...otherSessions];
}

export function billingExtGroupCostsHtml(groupCosts: Record<string, number>, api: CopilotApiBalance | null | undefined): string {
	const otherSessionsCostUsd = billingOtherSessionsCostUsd(groupCosts, api);
	const totalCostUsd = Object.values(groupCosts).reduce((s, v) => s + v, 0) + otherSessionsCostUsd;
	const title = 'Extension tracked (this calendar month, IDE sessions only)';
	// A bounded summary whose row order is meaningful (the other-sessions row sits under the
	// local Copilot row it complements), so it is neither paged nor sortable.
	const table = renderDataTable<BillingCostRow>({
		tableId: BILLING_EXT_GROUP_COSTS_TABLE_ID,
		ariaLabel: title,
		rows: billingCostRows(groupCosts, otherSessionsCostUsd),
		columns: [
			{ id: 'provider', label: 'Provider', render: row => row.label },
			{ id: 'cost', label: 'Estimated cost', align: 'right', render: row => `$${formatFixed(row.cost, 2)}` },
		],
		pageSize: false,
		rowOptions: row => row.muted ? { className: 'data-table-muted' } : undefined,
		footerRows: [{ cells: { provider: 'Total', cost: `$${formatFixed(totalCostUsd, 2)}` } }],
	});
	return `
		<div style="margin-bottom:12px;">
			<div style="font-size:12px; font-weight:600; color:var(--text-secondary); margin-bottom:6px;">${escapeHtml(title)}</div>
			${table}
		</div>`;
}
