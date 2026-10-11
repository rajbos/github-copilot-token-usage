// Renders the Efficiency view's metric tables — the Skills tab's per-skill impact
// cards and the Models tab's head-to-head comparison — through the shared
// `renderDataTable()` component.
//
// A pure string builder with no CSS imports (same contract as modelMixTable.ts)
// so the markup is unit-testable directly in Node, unlike main.ts.
//
// @security skill and model names come from session data and are therefore
// untrusted; every one that lands in trusted (`{ html }`) markup goes through
// `escapeHtml` first.

import { renderDataTable, type DataTableColumn } from '../shared/dataTable';
import { escapeHtml, formatCompact } from '../shared/formatUtils';
import type {
	EfficiencyDelta,
	ModelComparison,
	ModelComparisonRow,
	SkillImpact,
	SkillImpactMetric,
} from '../../../../src/efficiencyAnalysis';

export const MODEL_COMPARE_TABLE_ID = 'efficiency-model-compare';

/** Stable per skill, so each card keeps its own sort across re-renders. */
export function skillImpactTableId(skill: string): string {
	return `efficiency-skill-impact-${encodeURIComponent(skill)}`;
}

export function fmtValue(v: number | null, unit: EfficiencyDelta['unit']): string {
	if (v === null) { return '—'; }
	switch (unit) {
		case 'percent': return `${(v * 100).toFixed(1)}%`;
		case 'minutes': return `${v.toFixed(1)} min`;
		case 'tokens': return formatCompact(Math.round(v));
		case 'currency': return `$${v.toFixed(2)}`;
		case 'ratio': return v.toFixed(1);
	}
}

/** Coloured "↑ 12%" chip; `favorable` decides the colour, null reads as flat. */
function deltaChipHtml(deltaPct: number | null, favorable: boolean | null): string {
	if (deltaPct === null) { return '<span class="delta-na">—</span>'; }
	const cls = favorable === null ? 'flat' : favorable ? 'good' : 'bad';
	const arrow = deltaPct > 0 ? '↑' : deltaPct < 0 ? '↓' : '→';
	return `<span class="delta-change ${cls}">${arrow} ${Math.abs(deltaPct).toFixed(0)}%</span>`;
}

function fmtSkillMetric(m: SkillImpactMetric, v: number | null): string {
	if (v === null) { return '—'; }
	if (m.id === 'retry-rate') { return `${(v * 100).toFixed(0)}%`; }
	if (m.id === 'tokens') { return formatCompact(Math.round(v)); }
	if (m.id === 'active-minutes') { return `${v.toFixed(0)} min`; }
	return v.toFixed(1);
}

// "With" and "Without" mix units across rows (turns, tokens, minutes, a rate),
// so only the label and the percentage difference are sortable.
const SKILL_IMPACT_COLUMNS: readonly DataTableColumn<SkillImpactMetric>[] = [
	{
		id: 'metric',
		label: 'Metric',
		sortValue: m => m.label,
		render: m => m.label,
	},
	{
		id: 'with',
		label: 'With',
		align: 'right',
		render: m => fmtSkillMetric(m, m.withSkill),
	},
	{
		id: 'without',
		label: 'Without',
		align: 'right',
		render: m => fmtSkillMetric(m, m.withoutSkill),
	},
	{
		id: 'difference',
		label: 'Difference',
		align: 'right',
		sortValue: m => m.deltaPct,
		render: m => ({ html: deltaChipHtml(m.deltaPct, m.favorable) }),
	},
];

/**
 * The with/without metrics table inside one skill impact card. The metric set is
 * fixed by `computeSkillImpact()` (four rows), so the table never pages.
 */
export function renderSkillImpactTable(impact: SkillImpact): string {
	return renderDataTable({
		tableId: skillImpactTableId(impact.skill),
		ariaLabel: impact.skill,
		rows: impact.metrics,
		columns: SKILL_IMPACT_COLUMNS,
		pageSize: false,
	});
}

/** The "Better" cell — only decisive wins get a chip, so ties read as ties. */
function comparisonWinnerCell(r: ModelComparisonRow): string {
	if (r.significant && (r.winner === 'a' || r.winner === 'b')) {
		return `<span class="model-win-chip">${r.winner.toUpperCase()}</span>`;
	}
	return r.winner === 'tie' ? '<span class="model-win-chip tie">tie</span>' : '';
}

/** Sorts decisive A wins, then decisive B wins, then ties; undecided rows go last. */
function comparisonWinnerSortValue(r: ModelComparisonRow): string | null {
	if (r.significant && (r.winner === 'a' || r.winner === 'b')) { return r.winner; }
	return r.winner === 'tie' ? 'tie' : null;
}

function comparisonSideHeader(tag: 'A' | 'B', side: ModelComparison['a']): Pick<DataTableColumn<ModelComparisonRow>, 'label' | 'headerHtml'> {
	return {
		label: `${tag} · ${side.displayName} ${side.periodLabel}`,
		headerHtml: `${tag} · ${escapeHtml(side.displayName)}<span class="th-sub">${escapeHtml(side.periodLabel)}</span>`,
	};
}

function buildComparisonColumns(cmp: ModelComparison): DataTableColumn<ModelComparisonRow>[] {
	// A and B mix units across rows, so only the label, the B-vs-A percentage
	// and the winner are sortable.
	return [
		{
			id: 'metric',
			label: 'Metric',
			sortValue: r => r.label,
			render: r => ({ html: `<span title="${escapeHtml(r.description)}">${escapeHtml(r.label)}</span>` }),
		},
		{
			id: 'a',
			...comparisonSideHeader('A', cmp.a),
			align: 'right',
			className: 'eff-th-wrap',
			render: r => fmtValue(r.a, r.unit),
		},
		{
			id: 'b',
			...comparisonSideHeader('B', cmp.b),
			align: 'right',
			className: 'eff-th-wrap',
			render: r => fmtValue(r.b, r.unit),
		},
		{
			id: 'delta',
			label: 'B vs A',
			align: 'right',
			sortValue: r => r.deltaPct,
			render: r => ({ html: deltaChipHtml(r.deltaPct, r.winner === 'b' ? true : r.winner === 'a' ? false : null) }),
		},
		{
			id: 'winner',
			label: 'Better',
			align: 'right',
			firstSortDirection: 'asc',
			sortValue: comparisonWinnerSortValue,
			render: r => ({ html: comparisonWinnerCell(r) }),
		},
	];
}

/**
 * The Models tab's 5-column head-to-head table. Its rows are the fixed metric set
 * produced by `compareModels()`, in that order, so the table never pages.
 */
export function renderModelComparisonTable(cmp: ModelComparison, ariaLabel: string): string {
	return renderDataTable({
		tableId: MODEL_COMPARE_TABLE_ID,
		ariaLabel,
		rows: cmp.rows,
		columns: buildComparisonColumns(cmp),
		pageSize: false,
		rowOptions: r => (r.a === null || r.b === null ? { className: 'model-row-muted' } : undefined),
	});
}
