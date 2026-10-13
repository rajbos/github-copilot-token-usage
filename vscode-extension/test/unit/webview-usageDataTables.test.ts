import test from 'node:test';
import * as assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

import { initializeWebviewLocalization } from '../../src/webview/shared/localization';
import { resetDataTableState, setDataTableFilter, setDataTableSort } from '../../src/webview/shared/dataTable';
import { renderContextRefTable, CTX_REF_OTHER_TABLE_ID, CTX_REF_TABLE_ID } from '../../src/webview/usage/contextRefTableHtml';
import { buildServerMemoriesSectionHtml, SERVER_MEMORIES_TABLE_ID } from '../../src/webview/usage/serverMemories';
import {
	AGENT_PLUGINS_TABLE_ID,
	renderAgentPluginsFilter,
	renderAgentPluginsTable,
	renderMemoryFilesTable,
	renderRepoHygieneListTable,
	REPO_HYGIENE_LIST_TABLE_ID,
	type RepoHygieneListRow,
} from '../../src/webview/usage/usageListTables';
import type { ContextRefRow } from '../../src/webview/usage/contextRefRows';

initializeWebviewLocalization({});

/**
 * Text of each body row's cells in the first table, parsed by a real HTML parser. Escaped markup
 * reads back as literal text (`<b>x</b>`); unescaped markup would become an element and lose its tags.
 */
function bodyRows(html: string): string[][] {
	const doc = new JSDOM(html).window.document;
	const rows = Array.from(doc.querySelector('tbody')?.children ?? []) as Element[];
	return rows.map(row => (Array.from(row.children) as Element[]).map(cell => (cell.textContent ?? '').trim()));
}

const ref = (label: string, counts: Partial<ContextRefRow> = {}): ContextRefRow => ({ label, today: 0, month: 0, lastMonth: 0, last30: 0, ...counts });

test('context refs: active kinds by last-30-days usage, a totals footer, and the unused tail in its own table', () => {
	resetDataTableState(CTX_REF_TABLE_ID);
	resetDataTableState(CTX_REF_OTHER_TABLE_ID);
	const html = renderContextRefTable(
		[ref('#selection', { last30: 4 }), ref('#file', { today: 2, last30: 9 }), ref('#clipboard', { lastMonth: 3 })],
		{ today: 2, month: 5, lastMonth: 3, last30: 13 },
		false,
	);
	const [mainTable, otherTable] = html.split('<details');
	assert.deepEqual(bodyRows(mainTable).map(cells => cells[0]), ['#file', '#selection']);
	assert.match(mainTable, /<td class="data-table-align-right ctx-ref-num ctx-ref-today-active">2<\/td>/, 'today usage is highlighted');
	assert.match(mainTable, /<td class="data-table-align-right ctx-ref-num ctx-ref-zero">0<\/td>/, 'zero counts are muted');
	assert.match(mainTable, /<tfoot><tr class="data-table-footer-row ctx-ref-total">/);
	assert.match(mainTable, /<span title="[^"]+">📊 Total References<\/span>/, 'the footer explains what the total counts');
	assert.match(mainTable, /<td class="data-table-align-right ctx-ref-num">13<\/td>/);
	assert.match(otherTable, /id="ctx-ref-other"/);
	assert.match(otherTable, new RegExp(`id="data-table-root-${CTX_REF_OTHER_TABLE_ID}"`));
	assert.deepEqual(bodyRows(otherTable).map(cells => cells[0]), ['#clipboard']);
});

test('context refs: a period with no recent references keeps the footer and says so', () => {
	resetDataTableState(CTX_REF_TABLE_ID);
	const html = renderContextRefTable([ref('#clipboard', { lastMonth: 1 })], { today: 0, month: 0, lastMonth: 1, last30: 0 }, true);
	const mainTable = html.split('<details')[0];
	assert.match(mainTable, /class="data-table-empty"[^>]*>No context references recorded today or in the last 30 days\.</);
	assert.match(mainTable, /ctx-ref-total/);
	assert.match(html, /<details class="ctx-ref-other" id="ctx-ref-other" open>/, 'the disclosure keeps its open state');
});

test('context refs: a row tooltip is escaped onto the row', () => {
	resetDataTableState(CTX_REF_TABLE_ID);
	const html = renderContextRefTable([{ ...ref('#file', { today: 1 }), title: 'a "quoted" <tip>' }], { today: 1, month: 0, lastMonth: 0, last30: 0 }, false);
	assert.match(html, /<tr title="a &quot;quoted&quot; &lt;tip&gt;">/);
});

test('agent plugins: plugins with usage are hidden by default and the toggle reveals them', () => {
	resetDataTableState(AGENT_PLUGINS_TABLE_ID);
	const plugins = [
		{ pluginName: 'unused', availableSkillCount: 3, usedSkillCount: 0 },
		{ pluginName: 'used <one>', availableSkillCount: 2, usedSkillCount: 1 },
	];
	const filter = renderAgentPluginsFilter();
	assert.match(filter, /id="plugin-hide-toggle"[^>]*data-table-filter="hideWithUsage" checked/);
	assert.deepEqual(bodyRows(renderAgentPluginsTable(plugins, 'Agent Plugins')).map(cells => cells[0]), ['unused']);

	setDataTableFilter(AGENT_PLUGINS_TABLE_ID, 'hideWithUsage', false);
	const html = renderAgentPluginsTable(plugins, 'Agent Plugins');
	assert.deepEqual(bodyRows(html).map(cells => cells[0]), ['unused', 'used <one>']);
	assert.match(html, /data-command="openAgentPlugins" data-plugin-name="used &lt;one&gt;"/, 'the action button keeps its data attributes');
});

test('memory files: largest workspace first, localized global bucket, nullable last-updated', () => {
	resetDataTableState('memory-files');
	const html = renderMemoryFilesTable([
		{ workspaceName: 'small', repoCount: 1, sessionCount: 0, userCount: 0, totalBytes: 10, newestMtimeMs: null, staleFileCount: 0 },
		{ workspaceName: '__user__', repoCount: 0, sessionCount: 0, userCount: 2, totalBytes: 99, newestMtimeMs: 0, staleFileCount: 1 },
	]);
	const rows = bodyRows(html);
	assert.equal(rows[0][0], 'User (global)', 'the largest bucket comes first, under its localized label');
	assert.equal(rows[0][3], '2');
	assert.equal(rows[1][0], 'small');
	assert.equal(rows[1][6], '—', 'a workspace without files has no last-updated date');
	assert.notEqual(rows[0][6], '—', 'an epoch-0 timestamp is still a date');
});

test('server memories: promotion groups keep the host order and escape fact text', () => {
	resetDataTableState(SERVER_MEMORIES_TABLE_ID);
	const html = buildServerMemoriesSectionHtml({
		repo: 'o/r', enabled: true, truncated: false, totalMemories: 2, distinctSubjects: 2, documentedCount: 0,
		promotionCandidateCount: 2, repeatedGroupCount: 1, fullyStaleCount: 0,
		topPromotionGroups: [
			{ displaySubject: 'zeta', representativeFact: 'use <pnpm>', repeatCount: 3, citationCount: 1 },
			{ displaySubject: 'alpha', representativeFact: 'run tests', repeatCount: 1, citationCount: 5 },
		],
	});
	assert.match(html, new RegExp(`id="data-table-root-${SERVER_MEMORIES_TABLE_ID}"`));
	const rows = bodyRows(html);
	assert.deepEqual(rows.map(cells => cells[0].replace(/\s*\(.*\)$/, '')), ['zeta', 'alpha'], 'no re-sort of the host ranking');
	assert.equal(rows[0][1], 'use <pnpm>');
	assert.equal(rows[1][2], '5');
});

test('repository hygiene list: host order by default, numeric score sort with unanalysed last, escaped, long-tail footer', () => {
	resetDataTableState(REPO_HYGIENE_LIST_TABLE_ID);
	const repo = (name: string, scoreLabel: string, sessions: number): RepoHygieneListRow => ({
		workspaceName: name, workspacePath: `/repos/${name}`, sessions, interactions: sessions * 10, scoreLabel,
		action: scoreLabel === '—' ? 'analyze' : 'details', actionLabel: 'Analyze', actionDisabled: false, actionSecondary: false,
	});
	const rows = [repo('busy', '—', 40), repo('<b>mid</b>', '85%', 20), repo('quiet', '9%', 10)];
	const html = renderRepoHygieneListTable({ rows, other: { count: 3, sessions: 4, interactions: 40 } });
	assert.deepEqual(bodyRows(html).map(r => r[0]), ['busy', '<b>mid</b>', 'quiet']);
	assert.match(html, /title="\/repos\/busy"/);
	assert.match(html, /class="btn-repo-action" data-action="analyze" data-workspace-path="\/repos\/busy"/);
	assert.match(html, /<tfoot>.*Other \(3 repositories with low activity\).*id="btn-show-other-workspaces"/s);
	setDataTableSort(REPO_HYGIENE_LIST_TABLE_ID, 'score');
	const byScore = renderRepoHygieneListTable({ rows, showCollapse: true });
	assert.deepEqual(bodyRows(byScore).map(r => r[3]), ['85%', '9%', '—'], 'numeric column: highest first, unanalysed last');
	assert.match(byScore, /id="btn-collapse-other-workspaces"/);
	assert.doesNotMatch(byScore, /btn-show-other-workspaces/);
	resetDataTableState(REPO_HYGIENE_LIST_TABLE_ID);
});
