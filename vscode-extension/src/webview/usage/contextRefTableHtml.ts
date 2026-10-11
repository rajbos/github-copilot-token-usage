// The Context References table: its cells, its head, and the collapsed long tail beneath it.
//
// Split out of main.ts because that file sits against the 6000 counted-line ceiling
// `eslint.config.mjs` enforces, and because the table is pure markup over `ContextRefRow[]` —
// nothing here reads module state, so the disclosure's open/closed flag arrives as an argument
// from the panel that owns it.
import { renderDataTable, type DataTableColumn, type DataTableOptions } from '../shared/dataTable';
import { escapeHtml } from '../shared/formatUtils';
import { localize, localizeFormat } from '../shared/localization';
import { partitionContextRefRows, type ContextRefRow } from './contextRefRows';

export const CTX_REF_TABLE_ID = 'ctx-refs';
export const CTX_REF_OTHER_TABLE_ID = 'ctx-refs-other';

function sparklineSvg(lastMonth: number, month: number, today: number): string {
	const W = 60, H = 20, PAD = 2;
	const values = [lastMonth, month, today];
	const max = Math.max(...values);
	// Flat line at the bottom when all zeros
	const points = values.map((v, i) => {
		const x = PAD + i * ((W - PAD * 2) / (values.length - 1));
		const y = max === 0 ? H - PAD : PAD + (1 - v / max) * (H - PAD * 2);
		return `${x.toFixed(1)},${y.toFixed(1)}`;
	}).join(' ');
	const isFlat = max === 0;
	const color = isFlat ? 'var(--text-muted)' : today >= month && month >= lastMonth ? 'var(--link-color)' : today <= month && month <= lastMonth ? '#f87171' : 'var(--text-secondary)';
	return `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" aria-hidden="true"><polyline points="${points}" fill="none" stroke="${color}" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>${values.map((v, i) => {
		const x = PAD + i * ((W - PAD * 2) / (values.length - 1));
		const y = max === 0 ? H - PAD : PAD + (1 - v / max) * (H - PAD * 2);
		return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="2" fill="${color}"/>`;
	}).join('')}</svg>`;
}

function numColumn(id: string, labelKey: string, value: (row: ContextRefRow) => number, activeClass?: string): DataTableColumn<ContextRefRow> {
	return {
		id,
		label: localize(labelKey),
		align: 'right',
		className: 'ctx-ref-num',
		sortValue: value,
		render: row => String(value(row)),
		cellClassName: row => value(row) > 0 ? activeClass : 'ctx-ref-zero',
	};
}

/**
 * The columns, resolved per render rather than once at module load: the headers come from the
 * localization dictionary, which is only populated once the host's payload arrives — a
 * module-level constant would freeze the English fallback into every render that follows.
 */
function ctxRefColumns(): DataTableColumn<ContextRefRow>[] {
	return [
		{ id: 'reference', label: localize('usage.contextRefs.colReference'), className: 'ctx-ref-name', sortValue: row => row.label, render: row => row.label },
		numColumn('today', 'usage.contextRefs.colToday', row => row.today, 'ctx-ref-today-active'),
		numColumn('month', 'usage.contextRefs.colThisMonth', row => row.month),
		numColumn('lastMonth', 'usage.contextRefs.colLastMonth', row => row.lastMonth),
		numColumn('last30', 'usage.contextRefs.colLast30', row => row.last30),
		{
			id: 'trend',
			label: localize('usage.contextRefs.colTrend'),
			headerTitle: localize('usage.contextRefs.colTrendTooltip'),
			align: 'center',
			className: 'ctx-ref-spark',
			render: row => ({ html: sparklineSvg(row.lastMonth, row.month, row.today) }),
		},
	];
}

function ctxRefTable(tableId: string, rows: ContextRefRow[], options: Partial<DataTableOptions<ContextRefRow>> = {}): string {
	return renderDataTable<ContextRefRow>({
		tableId,
		ariaLabel: localize('usage.contextRefs.colReference'),
		rows,
		columns: ctxRefColumns(),
		initialSort: { columnId: 'last30', direction: 'desc' },
		rowOptions: row => row.title ? { attributes: { title: row.title } } : undefined,
		className: 'ctx-ref-table',
		rootClassName: 'ctx-ref-table-wrap',
		...options,
	});
}

/**
 * The unused-reference long tail, collapsed behind a disclosure.
 *
 * These rows are still rendered — a reference kind you have never used is worth discovering —
 * but they are not worth 14 rows of dead zeroes above the fold.
 */
function renderContextRefOtherHtml(otherRows: ContextRefRow[], otherOpen: boolean): string {
	if (otherRows.length === 0) { return ''; }
	const summary = localizeFormat('usage.contextRefs.otherSummary', otherRows.length);
	return `<details class="ctx-ref-other" id="ctx-ref-other"${otherOpen ? ' open' : ''}>
			<summary>${escapeHtml(summary)}</summary>
			${ctxRefTable(CTX_REF_OTHER_TABLE_ID, otherRows, { ariaLabel: summary })}
		</details>`;
}

export function renderContextRefTable(
	rows: ContextRefRow[],
	totals: { last30: number; month: number; lastMonth: number; today: number },
	otherOpen: boolean,
): string {
	const sorted = rows.slice().sort((a, b) => b.last30 - a.last30);
	// Reference kinds with nothing today and nothing in the last 30 days drop into a collapsed
	// "Other" group rather than padding the table with zeroes. The footer is computed from the
	// stats, not from the rows above it, so collapsing the tail never changes what it sums.
	//
	// It is not the column sum of this table, and was not before this split either:
	// getTotalContextRefs() counts the 17 reference-kind fields, while four of the rows here are
	// derived metrics read from elsewhere on the same stats (Images, Prompt Files and Custom
	// Prompts from `byKind`, Code Lines from `codeContextLines`). A period whose only activity is
	// one of those four therefore shows a non-zero row over a zero total. The footer's tooltip
	// says so rather than quietly presenting it as the table's sum.
	const { active, other } = partitionContextRefRows(sorted);
	const totalLabel = `<span title="${escapeHtml(localize('usage.contextRefs.totalTooltip'))}">${escapeHtml(localize('usage.contextRefs.totalRow'))}</span>`;
	return `
		${ctxRefTable(CTX_REF_TABLE_ID, active, {
			emptyMessage: localize('usage.contextRefs.noneRecent'),
			footerRows: [{
				className: 'ctx-ref-total',
				cells: {
					reference: { html: totalLabel },
					today: String(totals.today),
					month: String(totals.month),
					lastMonth: String(totals.lastMonth),
					last30: String(totals.last30),
					trend: { html: sparklineSvg(totals.lastMonth, totals.month, totals.today) },
				},
			}],
		})}
		${renderContextRefOtherHtml(other, otherOpen)}`;
}
