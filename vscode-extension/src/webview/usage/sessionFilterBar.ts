/**
 * Pure markup helper for the Recent Sessions filter bar in the usage panel.
 * Extracted from main.ts (no DOM / CSS dependencies) so it can be unit-tested in Node.js.
 */

import { escapeHtml } from '../shared/formatUtils';

export type SessionFilterOption = { value: string; label: string; count: number };

/**
 * Renders one labeled row of toggle pills (e.g. "Editor  VS Code 12  JetBrains 3"). The label
 * sits in its own fixed-width column and the pills in a wrapping container, so every row's
 * pills start on the same vertical line and wrapped pills stay under the first pill.
 */
export function buildFilterPillGroupHtml(groupLabel: string, filterType: string, items: SessionFilterOption[], activeSet: Set<string>): string {
	if (items.length === 0) { return ''; }
	const pills = items.map(({ value, label, count }) => {
		const isActive = activeSet.has(value);
		const safeLabel = escapeHtml(label);
		// i18n-exempt: unchanged legacy tooltip moved from main.ts; localizing it is tracked with the rest of the baselined strings
		return `<button type="button" class="session-filter-pill${isActive ? ' active' : ''}" data-filter-type="${filterType}" data-filter-value="${escapeHtml(value)}" aria-pressed="${isActive}" title="${safeLabel}: ${count} session${count === 1 ? '' : 's'}">${safeLabel} <span class="session-filter-pill-count">${count}</span></button>`;
	}).join('');
	return `<div class="session-filter-group"><span class="session-filter-group-label">${escapeHtml(groupLabel)}</span><div class="session-filter-pills">${pills}</div></div>`;
}
