// Import shared utilities
import { getModelDisplayName } from '../shared/modelUtils';
import { getEditorIcon, getCharsPerToken, formatFixed, formatPercent, formatNumber, formatCost, formatCompact, setCompactNumbers } from '../shared/formatUtils';
import { el, createButton } from '../shared/domUtils';
import { BUTTONS } from '../shared/buttonConfig';
// Token estimators loaded from JSON
// @ts-ignore
import tokenEstimatorsJson from '../../tokenEstimators.json';
// CSS imported as text via esbuild
import themeStyles from '../shared/theme.css';
import styles from './styles.css';

type ModelUsage = Record<string, { inputTokens: number; outputTokens: number }>;
type EditorUsage = Record<string, { tokens: number; sessions: number }>;
type TableSortKey = 'name' | 'today' | 'last30Days' | 'lastMonth' | 'projected';
type SortDir = 'asc' | 'desc';

type PeriodStats = {
	tokens: number;
	thinkingTokens: number;
	estimatedTokens: number;
	actualTokens: number;
	sessions: number;
	avgInteractionsPerSession: number;
	avgTokensPerSession: number;
	modelUsage: ModelUsage;
	editorUsage: EditorUsage;
	co2: number;
	treesEquivalent: number;
	waterUsage: number;
	estimatedCost: number;
	estimatedCostCopilot?: number;
};

type DetailedStats = {
	today: PeriodStats;
	month: PeriodStats;
	lastMonth: PeriodStats;
	last30Days: PeriodStats;
	lastUpdated: string | Date;
	backendConfigured?: boolean;
	compactNumbers?: boolean;
	copilotPlan?: {
		planId: string;
		planName: string;
		monthlyAiCreditsUsd: number;
		monthlyPremiumRequests: number | null;
	};
	sortSettings?: {
		editor?: { key?: string; dir?: string };
		model?: { key?: string; dir?: string };
		modelOtherExpanded?: boolean;
	};
};

// VS Code injects this in the webview environment
declare function acquireVsCodeApi<TState = unknown>(): {
	postMessage: (message: any) => void;
	setState: (newState: TState) => void;
	getState: () => TState | undefined;
};

type VSCodeApi = ReturnType<typeof acquireVsCodeApi>;

declare global {
	interface Window {
		__INITIAL_DETAILS__?: DetailedStats;
		Chart?: any;
	}
}

const vscode: VSCodeApi = acquireVsCodeApi();
const initialData = window.__INITIAL_DETAILS__;
console.log('[CopilotTokenTracker] details webview loaded');
console.log('[CopilotTokenTracker] window.__INITIAL_DETAILS__:', window.__INITIAL_DETAILS__);
console.log('[CopilotTokenTracker] initialData:', initialData);

const _initSort = initialData?.sortSettings;
let editorSortKey: TableSortKey = (_initSort?.editor?.key as TableSortKey) ?? 'name';
let editorSortDir: SortDir = (_initSort?.editor?.dir as SortDir) ?? 'asc';
let modelSortKey: TableSortKey = (_initSort?.model?.key as TableSortKey) ?? 'name';
let modelSortDir: SortDir = (_initSort?.model?.dir as SortDir) ?? 'asc';
let modelOtherExpanded: boolean = (_initSort?.modelOtherExpanded) ?? false;

function calculateProjection(last30DaysValue: number): number {
	// Project annual value based on last 30 days average
	// This gives better predictions at the beginning of the month
	const daysInYear = 365.25; // Average days per year (accounting for leap year cycle)
	return (last30DaysValue / 30) * daysInYear;
}

function render(stats: DetailedStats): void {
	setCompactNumbers(stats.compactNumbers !== false);
	const root = document.getElementById('root');
	if (!root) { return; }

	const projectedTokens = Math.round(calculateProjection(stats.last30Days.tokens));
	const projectedSessions = Math.round(calculateProjection(stats.last30Days.sessions));
	const projectedCo2 = calculateProjection(stats.last30Days.co2);
	const projectedWater = calculateProjection(stats.last30Days.waterUsage);
	const projectedCost = calculateProjection(stats.last30Days.estimatedCost);
	const projectedCostCopilot = calculateProjection(stats.last30Days.estimatedCostCopilot ?? 0);
	const projectedTrees = calculateProjection(stats.last30Days.treesEquivalent);

	renderShell(root, stats, {
		projectedTokens,
		projectedSessions,
		projectedCo2,
		projectedWater,
		projectedCost,
		projectedCostCopilot,
		projectedTrees
	});

	wireButtons();
}

function renderShell(
	root: HTMLElement,
	stats: DetailedStats,
	projections: {
		projectedTokens: number;
		projectedSessions: number;
		projectedCo2: number;
		projectedWater: number;
		projectedCost: number;
		projectedCostCopilot?: number;
		projectedTrees: number;
	}
): void {
	const lastUpdated = new Date(stats.lastUpdated);

	root.replaceChildren();

	// Inject theme styles first, then component styles
	const themeStyle = document.createElement('style');
	themeStyle.textContent = themeStyles;
	
	const style = document.createElement('style');
	style.textContent = styles;

	const container = el('div', 'container');
	const header = el('div', 'header');
	const title = el('div', 'title', 'AI Engineering Fluency');
	const buttonRow = el('div', 'button-row');

	buttonRow.append(
		createButton(BUTTONS['btn-refresh']),
		createButton(BUTTONS['btn-chart']),
		createButton(BUTTONS['btn-usage']),
		createButton(BUTTONS['btn-environmental']),
		createButton(BUTTONS['btn-diagnostics']),
		createButton(BUTTONS['btn-maturity'])
	);
	if (stats.backendConfigured) {
		buttonRow.append(createButton(BUTTONS['btn-dashboard']));
	}

	header.append(title, buttonRow);

	const footer = el('div', 'footer', `Last updated: ${lastUpdated.toLocaleString()} · Updates every 5 minutes`);

	const sections = el('div', 'sections');

	const isEmptyState = (stats.today.tokens ?? 0) === 0 && (stats.last30Days.tokens ?? 0) === 0 && (stats.lastMonth.tokens ?? 0) === 0;
	if (isEmptyState) {
		sections.append(buildEmptyStateSection());
	}

	sections.append(buildMetricsSection(stats, projections));

	const editorSection = buildEditorUsageSection(stats);
	if (editorSection) {
		sections.append(editorSection);
	}

	const modelSection = buildModelUsageSection(stats);
	if (modelSection) {
		sections.append(modelSection);
	}

	container.append(header, sections, footer);
	root.append(themeStyle, style, container);
}

function buildMetricsSection(
	stats: DetailedStats,
	projections: {
		projectedTokens: number;
		projectedSessions: number;
		projectedCo2: number;
		projectedWater: number;
		projectedCost: number;
		projectedCostCopilot?: number;
		projectedTrees: number;
	}
): HTMLElement {
	const section = el('div', 'section');
	const heading = el('h3');
	heading.textContent = 'AI Engineering Fluency';
	section.append(heading);

	const table = document.createElement('table');
	table.className = 'stats-table';

	const thead = document.createElement('thead');
	const headerRow = document.createElement('tr');
	const headers = [
		{ icon: '📊', text: 'Metric' },
		{ icon: '📅', text: 'Today' },
		{ icon: '📈', text: 'Last 30 Days' },
		{ icon: '📆', text: 'Previous Month' },
		{ icon: '🌍', text: 'Projected Year' }
	];
	headers.forEach((h, idx) => {
		const th = document.createElement('th');
		// Only the first column is left-aligned; others get 'align-right' for right alignment
		th.className = idx === 0 ? '' : 'align-right';
		const wrap = el('div', 'period-header');
		wrap.textContent = `${h.icon} ${h.text}`;
		th.append(wrap);
		headerRow.append(th);
	});
	thead.append(headerRow);
	table.append(thead);

	const tbody = document.createElement('tbody');
	const rows: Array<{ label: string; labelTooltip?: string; icon: string; color?: string; today: string; last30Days: string; lastMonth: string; projected: string }> = [
		{ label: 'Tokens (total)', icon: '🟣', color: '#c37bff', today: formatCompact(stats.today.tokens), last30Days: formatCompact(stats.last30Days.tokens), lastMonth: formatCompact(stats.lastMonth.tokens), projected: formatCompact(projections.projectedTokens) },
		{ label: 'Tokens (user estimated)', icon: '📝', color: '#b39ddb', today: formatCompact(stats.today.estimatedTokens), last30Days: formatCompact(stats.last30Days.estimatedTokens), lastMonth: formatCompact(stats.lastMonth.estimatedTokens), projected: '—' },
		{ label: 'Service overhead %', icon: '☁️', color: '#90a4ae', today: (stats.today.actualTokens || 0) > 0 ? formatPercent(((stats.today.tokens - stats.today.estimatedTokens) / stats.today.tokens) * 100) : '—', last30Days: (stats.last30Days.actualTokens || 0) > 0 ? formatPercent(((stats.last30Days.tokens - stats.last30Days.estimatedTokens) / stats.last30Days.tokens) * 100) : '—', lastMonth: (stats.lastMonth.actualTokens || 0) > 0 ? formatPercent(((stats.lastMonth.tokens - stats.lastMonth.estimatedTokens) / stats.lastMonth.tokens) * 100) : '—', projected: '—' },
		{ label: 'Thinking tokens', icon: '🧠', color: '#a78bfa', today: formatCompact(stats.today.thinkingTokens || 0), last30Days: formatCompact(stats.last30Days.thinkingTokens || 0), lastMonth: formatCompact(stats.lastMonth.thinkingTokens || 0), projected: '—' },
		{
			label: 'Estimated cost (est.)',
			labelTooltip: 'Based on public provider API rates — for comparison only. This is not what you are billed.',
			icon: '🪙', color: '#ffd166',
			today: formatCost(stats.today.estimatedCost), last30Days: formatCost(stats.last30Days.estimatedCost), lastMonth: formatCost(stats.lastMonth.estimatedCost), projected: formatCost(projections.projectedCost)
		},
		{
			label: 'Estimated cost (TBB)',
			labelTooltip: 'Based on GitHub Copilot AI Credit rates (1 credit = $0.01) — this is what Copilot will bill you. TBB = To Be Billed.',
			icon: '🟢', color: '#7ce38b',
			today: formatCost(stats.today.estimatedCostCopilot ?? 0), last30Days: formatCost(stats.last30Days.estimatedCostCopilot ?? 0), lastMonth: formatCost(stats.lastMonth.estimatedCostCopilot ?? 0), projected: formatCost(projections.projectedCostCopilot ?? 0)
		},
		...(stats.copilotPlan ? (() => {
			const credits = stats.copilotPlan.monthlyAiCreditsUsd > 0 ? `$${stats.copilotPlan.monthlyAiCreditsUsd} credits/month` : 'no credits';
			return [{
				label: `${stats.copilotPlan.planName} (${credits})`,
				labelTooltip: `Your active GitHub Copilot subscription plan (ID: ${stats.copilotPlan.planId}). Included AI credits cover token-based billing (1 AI credit = $0.01).`,
				icon: '🏷️', color: '#60a5fa',
				today: '—', last30Days: '—', lastMonth: '—', projected: '—'
			}];
		})() : []),
		{ label: 'Sessions', icon: '📅', color: '#66aaff', today: formatNumber(stats.today.sessions), last30Days: formatNumber(stats.last30Days.sessions), lastMonth: formatNumber(stats.lastMonth.sessions), projected: formatNumber(projections.projectedSessions) },
		{ label: 'Average interactions/session', icon: '💬', color: '#8ce0ff', today: formatNumber(stats.today.avgInteractionsPerSession), last30Days: formatNumber(stats.last30Days.avgInteractionsPerSession), lastMonth: formatNumber(stats.lastMonth.avgInteractionsPerSession), projected: '—' },
		{ label: 'Average tokens/session', icon: '🔢', color: '#7ce38b', today: formatCompact(stats.today.avgTokensPerSession), last30Days: formatCompact(stats.last30Days.avgTokensPerSession), lastMonth: formatCompact(stats.lastMonth.avgTokensPerSession), projected: '—' }
	];

	rows.forEach(row => {
		const tr = document.createElement('tr');
		const labelTd = document.createElement('td');
		const labelWrapper = document.createElement('span');
		labelWrapper.className = 'metric-label';
		const iconSpan = document.createElement('span');
		iconSpan.textContent = row.icon;
		if (row.color) { iconSpan.style.color = row.color; }
		const textSpan = document.createElement('span');
		textSpan.textContent = row.label;
		if (row.labelTooltip) {
			labelWrapper.title = row.labelTooltip;
			labelWrapper.style.cursor = 'help';
			const hintSpan = document.createElement('span');
			hintSpan.textContent = ' ℹ️';
			hintSpan.style.cssText = 'font-size:0.75em; opacity:0.6;';
			textSpan.append(hintSpan);
		}
		labelWrapper.append(iconSpan, textSpan);
		labelTd.append(labelWrapper);

		const todayTd = document.createElement('td');
		todayTd.className = 'value-right align-right';
		todayTd.textContent = row.today;

		const last30DaysTd = document.createElement('td');
		last30DaysTd.className = 'value-right align-right';
		last30DaysTd.textContent = row.last30Days;

		const lastMonthTd = document.createElement('td');
		lastMonthTd.className = 'value-right align-right';
		lastMonthTd.textContent = row.lastMonth;

		const projTd = document.createElement('td');
		projTd.className = 'value-right align-right';
		projTd.textContent = row.projected;

		tr.append(labelTd, todayTd, last30DaysTd, lastMonthTd, projTd);
		tbody.append(tr);
	});

	table.append(tbody);
	section.append(table);
	return section;
}

function getSortIndicator(colKey: TableSortKey, activeKey: TableSortKey, dir: SortDir): string {
	if (colKey !== activeKey) { return ' ↕'; }
	return dir === 'asc' ? ' ↑' : ' ↓';
}

function saveSortSettings(): void {
	vscode.postMessage({
		command: 'saveSortSettings',
		settings: {
			editor: { key: editorSortKey, dir: editorSortDir },
			model: { key: modelSortKey, dir: modelSortDir },
			modelOtherExpanded
		}
	});
}

function buildEditorTbody(stats: DetailedStats, allEditors: string[]): HTMLTableSectionElement {
	const todayTotal = Object.values(stats.today.editorUsage).reduce((sum, e) => sum + e.tokens, 0);
	const last30DaysTotal = Object.values(stats.last30Days.editorUsage).reduce((sum, e) => sum + e.tokens, 0);
	const lastMonthTotal = Object.values(stats.lastMonth.editorUsage).reduce((sum, e) => sum + e.tokens, 0);

	type EditorItem = {
		editor: string;
		todayUsage: { tokens: number; sessions: number };
		last30DaysUsage: { tokens: number; sessions: number };
		lastMonthUsage: { tokens: number; sessions: number };
		projectedTokens: number;
		projectedSessions: number;
	};

	const items: EditorItem[] = allEditors.map(editor => {
		const todayUsage = stats.today.editorUsage[editor] || { tokens: 0, sessions: 0 };
		const last30DaysUsage = stats.last30Days.editorUsage[editor] || { tokens: 0, sessions: 0 };
		const lastMonthUsage = stats.lastMonth.editorUsage[editor] || { tokens: 0, sessions: 0 };
		return {
			editor,
			todayUsage,
			last30DaysUsage,
			lastMonthUsage,
			projectedTokens: Math.round(calculateProjection(last30DaysUsage.tokens)),
			projectedSessions: Math.round(calculateProjection(last30DaysUsage.sessions))
		};
	});

	items.sort((a, b) => {
		let cmp: number;
		switch (editorSortKey) {
			case 'name': cmp = a.editor.localeCompare(b.editor); break;
			case 'today': cmp = a.todayUsage.tokens - b.todayUsage.tokens; break;
			case 'last30Days': cmp = a.last30DaysUsage.tokens - b.last30DaysUsage.tokens; break;
			case 'lastMonth': cmp = a.lastMonthUsage.tokens - b.lastMonthUsage.tokens; break;
			case 'projected': cmp = a.projectedTokens - b.projectedTokens; break;
			default: cmp = 0;
		}
		return editorSortDir === 'asc' ? cmp : -cmp;
	});

	const tbody = document.createElement('tbody');

	items.forEach(({ editor, todayUsage, last30DaysUsage, lastMonthUsage, projectedTokens, projectedSessions }) => {
		const todayPercent = todayTotal > 0 ? (todayUsage.tokens / todayTotal) * 100 : 0;
		const last30DaysPercent = last30DaysTotal > 0 ? (last30DaysUsage.tokens / last30DaysTotal) * 100 : 0;
		const lastMonthPercent = lastMonthTotal > 0 ? (lastMonthUsage.tokens / lastMonthTotal) * 100 : 0;

		const tr = document.createElement('tr');
		// JetBrains JSONL only persists user messages and assistant text — no
		// API token counts, no thinking tokens. Surface that caveat as a row
		// tooltip so users don't compare these numbers apples-to-apples with
		// editors that report actual usage.
		if (editor === 'JetBrains') {
			tr.title = 'JetBrains: only user messages + assistant text are persisted, so token counts here are estimates of those alone. Actual API counts and thinking tokens are not available.';
		}
		const labelTd = document.createElement('td');
		const labelWrapper = document.createElement('span');
		labelWrapper.className = 'metric-label';
		labelWrapper.textContent = `${getEditorIcon(editor)} ${editor}`;
		if (editor === 'JetBrains') {
			labelWrapper.textContent = `${labelWrapper.textContent} ⓘ`;
		}
		labelTd.append(labelWrapper);

		const todayTd = document.createElement('td');
		todayTd.className = 'value-right align-right';
		todayTd.textContent = formatCompact(todayUsage.tokens);
		const todaySub = el('div', 'muted', `${formatPercent(todayPercent)} · ${todayUsage.sessions} sessions`);
		todayTd.append(todaySub);

		const last30DaysTd = document.createElement('td');
		last30DaysTd.className = 'value-right align-right';
		last30DaysTd.textContent = formatCompact(last30DaysUsage.tokens);
		const last30DaysSub = el('div', 'muted', `${formatPercent(last30DaysPercent)} · ${last30DaysUsage.sessions} sessions`);
		last30DaysTd.append(last30DaysSub);

		const lastMonthTd = document.createElement('td');
		lastMonthTd.className = 'value-right align-right';
		lastMonthTd.textContent = formatCompact(lastMonthUsage.tokens);
		const lastMonthSub = el('div', 'muted', `${formatPercent(lastMonthPercent)} · ${lastMonthUsage.sessions} sessions`);
		lastMonthTd.append(lastMonthSub);

		const projTd = document.createElement('td');
		projTd.className = 'value-right align-right';
		projTd.textContent = formatCompact(projectedTokens);
		const projSub = el('div', 'muted', `${projectedSessions} sessions`);
		projTd.append(projSub);

		tr.append(labelTd, todayTd, last30DaysTd, lastMonthTd, projTd);
		tbody.append(tr);
	});

	return tbody;
}

function buildEditorUsageSection(stats: DetailedStats): HTMLElement | null {
	const allEditors = new Set([
		...Object.keys(stats.today.editorUsage),
		...Object.keys(stats.last30Days.editorUsage),
		...Object.keys(stats.lastMonth.editorUsage)
	]);

	if (allEditors.size === 0) {
		return null;
	}

	const section = el('div', 'section');
	const heading = el('h3');
	heading.textContent = '💻 Usage by Editor';
	section.append(heading);

	const table = document.createElement('table');
	table.className = 'stats-table';

	const thead = document.createElement('thead');
	const headerRow = document.createElement('tr');
	const editorColHeaders: Array<{ icon: string; text: string; key: TableSortKey }> = [
		{ icon: '📝', text: 'Editor', key: 'name' },
		{ icon: '📅', text: 'Today', key: 'today' },
		{ icon: '📈', text: 'Last 30 Days', key: 'last30Days' },
		{ icon: '📆', text: 'Previous Month', key: 'lastMonth' },
		{ icon: '🌍', text: 'Projected Year', key: 'projected' }
	];
	const editorHeaderWraps: HTMLElement[] = [];
	editorColHeaders.forEach((h, idx) => {
		const th = document.createElement('th');
		th.className = idx === 0 ? '' : 'align-right';
		th.style.cursor = 'pointer';
		th.style.userSelect = 'none';
		th.title = `Sort by ${h.text}`;
		const wrap = el('div', 'period-header');
		wrap.textContent = `${h.icon} ${h.text}${getSortIndicator(h.key, editorSortKey, editorSortDir)}`;
		th.append(wrap);
		editorHeaderWraps.push(wrap);
		th.addEventListener('click', () => {
			if (editorSortKey === h.key) {
				editorSortDir = editorSortDir === 'asc' ? 'desc' : 'asc';
			} else {
				editorSortKey = h.key;
				editorSortDir = h.key === 'name' ? 'asc' : 'desc';
			}
			editorHeaderWraps.forEach((w, i) => {
				w.textContent = `${editorColHeaders[i].icon} ${editorColHeaders[i].text}${getSortIndicator(editorColHeaders[i].key, editorSortKey, editorSortDir)}`;
			});
			const newTbody = buildEditorTbody(stats, Array.from(allEditors));
			const oldTbody = table.querySelector('tbody');
			if (oldTbody) { table.replaceChild(newTbody, oldTbody); } else { table.append(newTbody); }
			saveSortSettings();
		});
		headerRow.append(th);
	});
	thead.append(headerRow);
	table.append(thead);
	table.append(buildEditorTbody(stats, Array.from(allEditors)));
	section.append(table);
	return section;
}

const TOP_N_MODELS = 5;

function buildModelTbody(stats: DetailedStats, topModels: string[], otherModels: string[], onToggleOther: () => void): HTMLTableSectionElement {
	type ModelItem = {
		model: string;
		todayTotal: number;
		todayInputPct: number;
		todayOutputPct: number;
		last30DaysTotal: number;
		last30DaysInputPct: number;
		last30DaysOutputPct: number;
		lastMonthTotal: number;
		lastMonthInputPct: number;
		lastMonthOutputPct: number;
		projected: number;
		charsPerToken: number;
	};

	function toModelItem(model: string): ModelItem {
		const todayUsage = stats.today.modelUsage[model] || { inputTokens: 0, outputTokens: 0 };
		const last30DaysUsage = stats.last30Days.modelUsage[model] || { inputTokens: 0, outputTokens: 0 };
		const lastMonthUsage = stats.lastMonth.modelUsage[model] || { inputTokens: 0, outputTokens: 0 };
		const todayTotal = todayUsage.inputTokens + todayUsage.outputTokens;
		const last30DaysTotal = last30DaysUsage.inputTokens + last30DaysUsage.outputTokens;
		const lastMonthTotal = lastMonthUsage.inputTokens + lastMonthUsage.outputTokens;
		return {
			model,
			todayTotal,
			todayInputPct: todayTotal > 0 ? (todayUsage.inputTokens / todayTotal) * 100 : 0,
			todayOutputPct: todayTotal > 0 ? (todayUsage.outputTokens / todayTotal) * 100 : 0,
			last30DaysTotal,
			last30DaysInputPct: last30DaysTotal > 0 ? (last30DaysUsage.inputTokens / last30DaysTotal) * 100 : 0,
			last30DaysOutputPct: last30DaysTotal > 0 ? (last30DaysUsage.outputTokens / last30DaysTotal) * 100 : 0,
			lastMonthTotal,
			lastMonthInputPct: lastMonthTotal > 0 ? (lastMonthUsage.inputTokens / lastMonthTotal) * 100 : 0,
			lastMonthOutputPct: lastMonthTotal > 0 ? (lastMonthUsage.outputTokens / lastMonthTotal) * 100 : 0,
			projected: Math.round(calculateProjection(last30DaysTotal)),
			charsPerToken: getCharsPerToken(model)
		};
	}

	function sortItems(items: ModelItem[]): void {
		items.sort((a, b) => {
			let cmp: number;
			switch (modelSortKey) {
				case 'name': cmp = a.model.localeCompare(b.model); break;
				case 'today': cmp = a.todayTotal - b.todayTotal; break;
				case 'last30Days': cmp = a.last30DaysTotal - b.last30DaysTotal; break;
				case 'lastMonth': cmp = a.lastMonthTotal - b.lastMonthTotal; break;
				case 'projected': cmp = a.projected - b.projected; break;
				default: cmp = 0;
			}
			return modelSortDir === 'asc' ? cmp : -cmp;
		});
	}

	function buildModelRow(item: ModelItem, isOtherChild: boolean): HTMLTableRowElement {
		const tr = document.createElement('tr');
		if (isOtherChild) {
			tr.style.opacity = '0.85';
		}
		const labelTd = document.createElement('td');
		const labelWrapper = document.createElement('span');
		labelWrapper.className = 'metric-label';
		const indent = isOtherChild ? '<span style="display:inline-block;width:12px"></span>' : '';
		labelWrapper.innerHTML = `${indent}${getModelDisplayName(item.model)} <span style="color:#9aa0a6;font-size:11px; font-weight:500;">(~${item.charsPerToken.toFixed(1)} chars/tk)</span>`;
		labelTd.append(labelWrapper);

		const todayTd = document.createElement('td');
		todayTd.className = 'value-right align-right';
		todayTd.textContent = formatCompact(item.todayTotal);
		const todaySub = el('div', 'muted', `↑${formatPercent(item.todayInputPct)} ↓${formatPercent(item.todayOutputPct)}`);
		todayTd.append(todaySub);

		const last30DaysTd = document.createElement('td');
		last30DaysTd.className = 'value-right align-right';
		last30DaysTd.textContent = formatCompact(item.last30DaysTotal);
		const last30DaysSub = el('div', 'muted', `↑${formatPercent(item.last30DaysInputPct)} ↓${formatPercent(item.last30DaysOutputPct)}`);
		last30DaysTd.append(last30DaysSub);

		const lastMonthTd = document.createElement('td');
		lastMonthTd.className = 'value-right align-right';
		lastMonthTd.textContent = formatCompact(item.lastMonthTotal);
		const lastMonthSub = el('div', 'muted', `↑${formatPercent(item.lastMonthInputPct)} ↓${formatPercent(item.lastMonthOutputPct)}`);
		lastMonthTd.append(lastMonthSub);

		const projTd = document.createElement('td');
		projTd.className = 'value-right align-right';
		projTd.textContent = formatCompact(item.projected);

		tr.append(labelTd, todayTd, last30DaysTd, lastMonthTd, projTd);
		return tr;
	}

	const topItems = topModels.map(toModelItem);
	sortItems(topItems);

	const tbody = document.createElement('tbody');
	topItems.forEach(item => tbody.append(buildModelRow(item, false)));

	// "Other" group — only rendered when there are more than TOP_N_MODELS models
	if (otherModels.length > 0) {
		// Aggregate summed stats across all periods for the "Other" group
		const sumUsage = (period: 'today' | 'last30Days' | 'lastMonth') =>
			otherModels.reduce(
				(acc, m) => {
					const u = stats[period].modelUsage[m] || { inputTokens: 0, outputTokens: 0 };
					return { inputTokens: acc.inputTokens + u.inputTokens, outputTokens: acc.outputTokens + u.outputTokens };
				},
				{ inputTokens: 0, outputTokens: 0 }
			);
		const otherToday = sumUsage('today');
		const otherLast30 = sumUsage('last30Days');
		const otherLastMonth = sumUsage('lastMonth');
		const otherTodayTotal = otherToday.inputTokens + otherToday.outputTokens;
		const otherLast30Total = otherLast30.inputTokens + otherLast30.outputTokens;
		const otherLastMonthTotal = otherLastMonth.inputTokens + otherLastMonth.outputTokens;
		const otherProjected = Math.round(calculateProjection(otherLast30Total));

		const pct = (part: number, total: number) => (total > 0 ? (part / total) * 100 : 0);

		// "Other" summary row
		const otherTr = document.createElement('tr');
		otherTr.style.cursor = 'pointer';
		otherTr.style.background = 'var(--list-hover-bg)';
		otherTr.title = modelOtherExpanded ? 'Collapse other models' : 'Expand other models';

		const otherLabelTd = document.createElement('td');
		const otherLabelWrapper = document.createElement('span');
		otherLabelWrapper.className = 'metric-label';
		const toggleIcon = modelOtherExpanded ? '▲' : '▼';
		otherLabelWrapper.innerHTML = `<span style="color:var(--text-secondary);font-weight:600;">📦 Other (${otherModels.length} model${otherModels.length !== 1 ? 's' : ''})</span> <span style="font-size:10px;color:var(--text-muted)">${toggleIcon}</span>`;
		otherLabelTd.append(otherLabelWrapper);

		const otherTodayTd = document.createElement('td');
		otherTodayTd.className = 'value-right align-right';
		otherTodayTd.textContent = formatCompact(otherTodayTotal);
		if (otherTodayTotal > 0) {
			otherTodayTd.append(el('div', 'muted', `↑${formatPercent(pct(otherToday.inputTokens, otherTodayTotal))} ↓${formatPercent(pct(otherToday.outputTokens, otherTodayTotal))}`));
		}

		const otherLast30Td = document.createElement('td');
		otherLast30Td.className = 'value-right align-right';
		otherLast30Td.textContent = formatCompact(otherLast30Total);
		if (otherLast30Total > 0) {
			otherLast30Td.append(el('div', 'muted', `↑${formatPercent(pct(otherLast30.inputTokens, otherLast30Total))} ↓${formatPercent(pct(otherLast30.outputTokens, otherLast30Total))}`));
		}

		const otherLastMonthTd = document.createElement('td');
		otherLastMonthTd.className = 'value-right align-right';
		otherLastMonthTd.textContent = formatCompact(otherLastMonthTotal);
		if (otherLastMonthTotal > 0) {
			otherLastMonthTd.append(el('div', 'muted', `↑${formatPercent(pct(otherLastMonth.inputTokens, otherLastMonthTotal))} ↓${formatPercent(pct(otherLastMonth.outputTokens, otherLastMonthTotal))}`));
		}

		const otherProjTd = document.createElement('td');
		otherProjTd.className = 'value-right align-right';
		otherProjTd.textContent = formatCompact(otherProjected);

		otherTr.append(otherLabelTd, otherTodayTd, otherLast30Td, otherLastMonthTd, otherProjTd);
		otherTr.addEventListener('click', () => {
			modelOtherExpanded = !modelOtherExpanded;
			saveSortSettings();
			onToggleOther();
		});
		tbody.append(otherTr);

		// When expanded, show individual "other" model rows beneath the summary row
		if (modelOtherExpanded) {
			const otherItems = otherModels.map(toModelItem);
			sortItems(otherItems);
			otherItems.forEach(item => tbody.append(buildModelRow(item, true)));
		}
	}

	return tbody;
}

function buildModelUsageSection(stats: DetailedStats): HTMLElement | null {
	const allModels = new Set([
		...Object.keys(stats.today.modelUsage),
		...Object.keys(stats.last30Days.modelUsage),
		...Object.keys(stats.lastMonth.modelUsage)
	]);

	if (allModels.size === 0) {
		return null;
	}

	// Determine top N models by last30Days usage; the rest go into the "Other" group
	const sortedByLast30Days = Array.from(allModels).sort((a, b) => {
		const aUsage = stats.last30Days.modelUsage[a] || { inputTokens: 0, outputTokens: 0 };
		const bUsage = stats.last30Days.modelUsage[b] || { inputTokens: 0, outputTokens: 0 };
		return (bUsage.inputTokens + bUsage.outputTokens) - (aUsage.inputTokens + aUsage.outputTokens);
	});
	const topModels = sortedByLast30Days.slice(0, TOP_N_MODELS);
	const otherModels = sortedByLast30Days.slice(TOP_N_MODELS);

	const section = el('div', 'section');
	const heading = el('h3');
	heading.textContent = '🎯 Model Usage (Tokens)';
	section.append(heading);

	const table = document.createElement('table');
	table.className = 'stats-table';

	const thead = document.createElement('thead');
	const headerRow = document.createElement('tr');
	const modelColHeaders: Array<{ icon: string; text: string; key: TableSortKey }> = [
		{ icon: '🧠', text: 'Model', key: 'name' },
		{ icon: '📅', text: 'Today', key: 'today' },
		{ icon: '📈', text: 'Last 30 Days', key: 'last30Days' },
		{ icon: '📆', text: 'Previous Month', key: 'lastMonth' },
		{ icon: '🌍', text: 'Projected Year', key: 'projected' }
	];
	const modelHeaderWraps: HTMLElement[] = [];

	function rebuildTbody(): void {
		const newTbody = buildModelTbody(stats, topModels, otherModels, rebuildTbody);
		const oldTbody = table.querySelector('tbody');
		if (oldTbody) { table.replaceChild(newTbody, oldTbody); } else { table.append(newTbody); }
	}

	modelColHeaders.forEach((h, idx) => {
		const th = document.createElement('th');
		th.className = idx === 0 ? '' : 'align-right';
		th.style.cursor = 'pointer';
		th.style.userSelect = 'none';
		th.title = `Sort by ${h.text}`;
		const wrap = el('div', 'period-header');
		wrap.textContent = `${h.icon} ${h.text}${getSortIndicator(h.key, modelSortKey, modelSortDir)}`;
		th.append(wrap);
		modelHeaderWraps.push(wrap);
		th.addEventListener('click', () => {
			if (modelSortKey === h.key) {
				modelSortDir = modelSortDir === 'asc' ? 'desc' : 'asc';
			} else {
				modelSortKey = h.key;
				modelSortDir = h.key === 'name' ? 'asc' : 'desc';
			}
			modelHeaderWraps.forEach((w, i) => {
				w.textContent = `${modelColHeaders[i].icon} ${modelColHeaders[i].text}${getSortIndicator(modelColHeaders[i].key, modelSortKey, modelSortDir)}`;
			});
			rebuildTbody();
			saveSortSettings();
		});
		headerRow.append(th);
	});
	thead.append(headerRow);
	table.append(thead);
	rebuildTbody();
	section.append(table);
	return section;
}

function buildEmptyStateSection(): HTMLElement {
	const section = el('div', 'section');
	const inner = el('div', 'empty-state');

	const title = el('div', 'empty-state-title', '👋 Welcome to AI Engineering Fluency');

	const desc = el('p', 'empty-state-description',
		'This extension tracks AI token usage by reading session log files stored locally by supported tools. No token data has been found yet.'
	);

	const toolsLabel = document.createElement('p');
	toolsLabel.className = 'empty-state-description';
	const toolsLabelStrong = document.createElement('strong');
	toolsLabelStrong.textContent = 'Supported tools & editors:';
	toolsLabel.append(toolsLabelStrong);

	const toolsList = document.createElement('ul');
	toolsList.className = 'empty-state-steps';
	const toolsTexts = [
		'💙 VS Code / VS Code Insiders / VSCodium — GitHub Copilot Chat extension',
		'⚡ Cursor, 🌊 Windsurf — built-in AI chat',
		'🖥️ Visual Studio 2022+ — GitHub Copilot Chat extension',
		'🟢 OpenCode, 🦀 Crush — terminal-based coding agents',
		'🤖 Claude Code — Anthropic\'s CLI coding agent',
		'💎 Gemini CLI — Google\'s CLI coding agent',
		'💻 Copilot CLI — GitHub Copilot in the terminal',
	];
	toolsTexts.forEach(text => {
		const li = document.createElement('li');
		li.textContent = text;
		toolsList.append(li);
	});

	const stepsLabel = document.createElement('p');
	stepsLabel.className = 'empty-state-description';
	const stepsLabelStrong = document.createElement('strong');
	stepsLabelStrong.textContent = 'To get started:';
	stepsLabel.append(stepsLabelStrong);

	const steps = document.createElement('ol');
	steps.className = 'empty-state-steps';
	const stepTexts = [
		'Use any of the supported tools or editors listed above to interact with an AI model.',
		'For GitHub Copilot in VS Code: open the Copilot Chat panel (Ctrl+Alt+I / Cmd+Alt+I) and start a conversation.',
		'For terminal agents (Claude Code, Gemini CLI, OpenCode, Copilot CLI): run a coding session in your terminal.',
		'Click the 🔄 Refresh button above to reload the stats after your first session.',
	];
	stepTexts.forEach(text => {
		const li = document.createElement('li');
		li.textContent = text;
		steps.append(li);
	});

	const note = el('div', 'empty-state-note',
		'💡 If you have been using one of the supported tools but still see no data, open the Diagnostics panel (🔍 Diagnostics button above) to verify that session files are being discovered correctly.'
	);

	inner.append(title, desc, toolsLabel, toolsList, stepsLabel, steps, note);
	section.append(inner);
	return section;
}

function buildEstimatesSection(): HTMLElement {
	const section = el('div', 'section');
	const heading = el('h3');
	heading.textContent = '💡 Calculation & Estimates';
	section.append(heading);

	const notes = document.createElement('ul');
	notes.className = 'notes';

	const items = [
		'Cost estimate uses public API pricing with input/output token counts; GitHub Copilot billing may differ from direct API usage.',
		'Estimated CO₂ is based on ~0.2 g CO₂e per 1,000 tokens.',
		'Estimated water usage is based on ~0.3 L per 1,000 tokens.',
		'Tree equivalent represents the fraction of a single mature tree\'s annual CO₂ absorption (~21 kg/year).'
	];

	items.forEach(text => {
		const li = document.createElement('li');
		li.textContent = text;
		notes.append(li);
	});

	section.append(notes);
	return section;
}

function wireButtons(): void {
	const refresh = document.getElementById('btn-refresh');
	const chart = document.getElementById('btn-chart');
	const usage = document.getElementById('btn-usage');
	const diagnostics = document.getElementById('btn-diagnostics');

	refresh?.addEventListener('click', () => vscode.postMessage({ command: 'refresh' }));
	chart?.addEventListener('click', () => vscode.postMessage({ command: 'showChart' }));
	usage?.addEventListener('click', () => vscode.postMessage({ command: 'showUsageAnalysis' }));
	diagnostics?.addEventListener('click', () => vscode.postMessage({ command: 'showDiagnostics' }));

	const maturity = document.getElementById('btn-maturity');
	maturity?.addEventListener('click', () => vscode.postMessage({ command: 'showMaturity' }));
	
	const dashboard = document.getElementById('btn-dashboard');
	dashboard?.addEventListener('click', () => vscode.postMessage({ command: 'showDashboard' }));

	const environmental = document.getElementById('btn-environmental');
	environmental?.addEventListener('click', () => vscode.postMessage({ command: 'showEnvironmental' }));
}

async function bootstrap(): Promise<void> {
	console.log('[CopilotTokenTracker] bootstrap called');
	const { provideVSCodeDesignSystem, vsCodeButton, vsCodeBadge } = await import('@vscode/webview-ui-toolkit');
	provideVSCodeDesignSystem().register(vsCodeButton(), vsCodeBadge());

	if (initialData) {
		console.log('[CopilotTokenTracker] Rendering details with initialData:', initialData);
		render(initialData);
	} else {
		console.warn('[CopilotTokenTracker] No initialData found, rendering fallback.');
		const root = document.getElementById('root');
		if (root) {
			root.textContent = '';
			const fallback = document.createElement('div');
			fallback.style.padding = '16px';
			fallback.style.color = '#e7e7e7';
			fallback.textContent = 'No data available.';
			root.append(fallback);
		}
	}
}

// Listen for background stat updates from the extension
window.addEventListener('message', (event: MessageEvent) => {
	const message = event.data;
	if (message.command === 'updateStats') {
		render(message.data as DetailedStats);
	}
});

void bootstrap();
