import test from 'node:test';
import * as assert from 'node:assert/strict';

import type { ModelComparison, ModelComparisonRow, SkillImpact, SkillImpactMetric } from '../../../src/efficiencyAnalysis';
import { resetDataTableState, setDataTableState } from '../../src/webview/shared/dataTable';
import { setFormatLocale } from '../../src/webview/shared/formatUtils';
import { initializeWebviewLocalization } from '../../src/webview/shared/localization';
import {
	MODEL_COMPARE_TABLE_ID,
	renderModelComparisonTable,
	renderSkillImpactTable,
	skillImpactTableId,
} from '../../src/webview/efficiency/efficiencyTables';

setFormatLocale('en-US');
initializeWebviewLocalization({});

function metric(id: SkillImpactMetric['id'], label: string, withSkill: number | null, withoutSkill: number | null, deltaPct: number | null, favorable: boolean | null): SkillImpactMetric {
	return { id, label, withSkill, withoutSkill, deltaPct, goodDirection: 'down', favorable };
}

function impact(skill: string): SkillImpact {
	return {
		skill,
		totalCalls: 12,
		withSkill: { sessions: 6 },
		withoutSkill: { sessions: 20 },
		metrics: [
			metric('turns', 'Turns per session', 4.25, 6, -29, true),
			metric('tokens', 'Tokens per session', 120_000, 100_000, 20, false),
			metric('active-minutes', 'Active minutes', 12.4, null, null, null),
			metric('retry-rate', 'Retry rate', 0.1, 0.104, 4, null),
		],
	} as unknown as SkillImpact;
}

function row(id: string, label: string, a: number | null, b: number | null, deltaPct: number | null, winner: ModelComparisonRow['winner'], significant: boolean): ModelComparisonRow {
	return { id, label, description: `${label} <help>`, a, b, unit: 'ratio', goodDirection: 'down', deltaPct, winner, significant } as unknown as ModelComparisonRow;
}

function comparison(): ModelComparison {
	return {
		a: { displayName: 'GPT-4o', periodLabel: 'Last 30 days' },
		b: { displayName: '<b>evil</b>', periodLabel: 'Jan 1 – Jan 31' },
		rows: [
			row('turns', 'Turns per edit', 3, 2, -33, 'b', true),
			row('retries', 'Retries', 1, 1.5, 50, 'a', true),
			row('cost', 'Cost per edit', 2, 2.05, 2, 'tie', false),
			row('lines', 'Lines changed', null, 4, null, null, false),
		],
		verdict: null,
		caveats: [],
	} as unknown as ModelComparison;
}

const labelsInOrder = (html: string, labels: string[]): string[] =>
	labels.slice().sort((x, y) => html.indexOf(`>${x}<`) - html.indexOf(`>${y}<`));

test('skill impact table: renders through the shared table with a stable per-skill id', () => {
	const html = renderSkillImpactTable(impact('/graphify'));
	assert.equal(skillImpactTableId('/graphify'), 'efficiency-skill-impact-%2Fgraphify');
	assert.match(html, /id="data-table-root-efficiency-skill-impact-%2Fgraphify"/);
	assert.notEqual(skillImpactTableId('a b'), skillImpactTableId('a_b'));
	assert.match(html, /<table class="data-table" aria-label="\/graphify">/);
	assert.doesNotMatch(html, /data-table-pager|data-table-summary/);
});

test('skill impact table: keeps the metric formatting and delta colouring', () => {
	const html = renderSkillImpactTable(impact('review'));
	assert.match(html, />4\.3</);
	assert.match(html, />6\.0</);
	assert.match(html, />12 min</);
	assert.match(html, />10%</);
	assert.match(html, /<span class="delta-change good">↓ 29%<\/span>/);
	assert.match(html, /<span class="delta-change bad">↑ 20%<\/span>/);
	assert.match(html, /<span class="delta-change flat">↑ 4%<\/span>/);
	assert.match(html, /<span class="delta-na">—<\/span>/);
});

test('skill impact table: only the label and difference columns sort (with/without mix units)', () => {
	const html = renderSkillImpactTable(impact('review'));
	assert.match(html, /data-table-sort="metric"/);
	assert.match(html, /data-table-sort="difference"/);
	assert.doesNotMatch(html, /data-table-sort="with"/);
	assert.doesNotMatch(html, /data-table-sort="without"/);
	const tableId = skillImpactTableId('review');
	try {
		setDataTableState(tableId, { sortColumn: 'difference', sortDirection: 'desc' });
		const sorted = renderSkillImpactTable(impact('review'));
		const labels = ['Turns per session', 'Tokens per session', 'Active minutes', 'Retry rate'];
		// Missing deltas sort last in both directions.
		assert.deepEqual(labelsInOrder(sorted, labels), ['Tokens per session', 'Retry rate', 'Turns per session', 'Active minutes']);
	} finally {
		resetDataTableState(tableId);
	}
});

test('skill impact table: escapes a hostile skill name', () => {
	const html = renderSkillImpactTable(impact('<img src=x onerror=alert(1)>'));
	assert.doesNotMatch(html, /<img/);
	assert.match(html, /aria-label="&lt;img src=x onerror=alert\(1\)&gt;"/);
});

test('model comparison table: escapes side names in the sub-labelled headers', () => {
	const html = renderModelComparisonTable(comparison(), 'Compare two models');
	assert.match(html, /<table class="data-table" aria-label="Compare two models">/);
	assert.match(html, /A · GPT-4o<span class="th-sub">Last 30 days<\/span>/);
	assert.match(html, /B · &lt;b&gt;evil&lt;\/b&gt;<span class="th-sub">Jan 1 – Jan 31<\/span>/);
	assert.doesNotMatch(html, /<b>evil/);
	assert.equal((html.match(/scope="col"/g) ?? []).length, 5);
	assert.doesNotMatch(html, /data-table-pager|data-table-summary/);
});

test('model comparison table: keeps tooltips, muted rows, delta colours and winner chips', () => {
	const html = renderModelComparisonTable(comparison(), 'Compare two models');
	assert.match(html, /<span title="Turns per edit &lt;help&gt;">Turns per edit<\/span>/);
	assert.match(html, /<tr class="model-row-muted">/);
	assert.equal((html.match(/model-row-muted/g) ?? []).length, 1);
	assert.match(html, /<span class="delta-change good">↓ 33%<\/span>/);
	assert.match(html, /<span class="delta-change bad">↑ 50%<\/span>/);
	assert.match(html, /<span class="delta-change flat">↑ 2%<\/span>/);
	assert.match(html, /<span class="model-win-chip">B<\/span>/);
	assert.match(html, /<span class="model-win-chip">A<\/span>/);
	assert.match(html, /<span class="model-win-chip tie">tie<\/span>/);
	assert.match(html, />—</);
});

test('model comparison table: keeps the analytics order by default and sorts by B-vs-A change', () => {
	const labels = ['Turns per edit', 'Retries', 'Cost per edit', 'Lines changed'];
	try {
		assert.deepEqual(labelsInOrder(renderModelComparisonTable(comparison(), 'x'), labels), labels);
		assert.doesNotMatch(renderModelComparisonTable(comparison(), 'x'), /data-table-sort="a"|data-table-sort="b"/);
		setDataTableState(MODEL_COMPARE_TABLE_ID, { sortColumn: 'delta', sortDirection: 'asc' });
		assert.deepEqual(labelsInOrder(renderModelComparisonTable(comparison(), 'x'), labels), ['Turns per edit', 'Cost per edit', 'Retries', 'Lines changed']);
		setDataTableState(MODEL_COMPARE_TABLE_ID, { sortColumn: 'winner', sortDirection: 'asc' });
		assert.deepEqual(labelsInOrder(renderModelComparisonTable(comparison(), 'x'), labels), ['Retries', 'Turns per edit', 'Cost per edit', 'Lines changed']);
	} finally {
		resetDataTableState(MODEL_COMPARE_TABLE_ID);
	}
});
