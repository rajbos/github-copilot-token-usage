/**
 * Pure helpers for the "Context References" table in the usage panel.
 * Extracted from main.ts (no DOM / CSS dependencies) so they can be unit-tested in Node.js.
 *
 * The table lists every context-reference kind the extension knows how to detect — currently
 * 21 rows — whether or not you have ever used them. On a typical machine most of those rows
 * are permanently zero, which buries the handful that actually carry signal. partitionContextRefRows()
 * splits the list into the rows with recent usage and a long tail with none, so the view can
 * collapse the tail behind an "Other" disclosure the way the model leaderboard already does.
 */

/** One row of the Context References table: a reference kind and its per-period counts. */
export interface ContextRefRow {
	label: string;
	title?: string;
	last30: number;
	month: number;
	lastMonth: number;
	today: number;
}

/**
 * Recent usage of one reference kind: today plus the last 30 days.
 *
 * "This Month" and "Last Month" are deliberately excluded. They overlap the last-30-days window
 * almost entirely, so adding them would keep a row visible on the strength of usage the
 * 30-day column already reflects — and a reference last used two months ago is exactly the
 * long tail this split exists to fold away.
 */
export function contextRefRecentTotal(row: ContextRefRow): number {
	return row.today + row.last30;
}

/**
 * Split context-reference rows into the ones with recent usage and the zero long tail.
 *
 * Both halves keep the caller's sort order; neither is dropped — the tail is rendered
 * collapsed rather than hidden, so a reference kind you have never used is still discoverable.
 */
export function partitionContextRefRows(rows: ContextRefRow[]): { active: ContextRefRow[]; other: ContextRefRow[] } {
	const active: ContextRefRow[] = [];
	const other: ContextRefRow[] = [];
	for (const row of rows) {
		(contextRefRecentTotal(row) > 0 ? active : other).push(row);
	}
	return { active, other };
}
