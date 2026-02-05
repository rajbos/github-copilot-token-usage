// Import shared utilities
import { getModelDisplayName } from '../shared/modelUtils';
import { getEditorIcon, getCharsPerToken, formatFixed, formatPercent, formatNumber, formatCost } from '../shared/formatUtils';
import { el, createButton } from '../shared/domUtils';
import { BUTTONS } from '../shared/buttonConfig';
// Token estimators loaded from JSON
// @ts-ignore
import tokenEstimatorsJson from '../../tokenEstimators.json';

type ModelUsage = Record<string, { inputTokens: number; outputTokens: number }>;
type EditorUsage = Record<string, { tokens: number; sessions: number }>;

type PeriodStats = {
	tokens: number;
	sessions: number;
	avgInteractionsPerSession: number;
	avgTokensPerSession: number;
	modelUsage: ModelUsage;
	editorUsage: EditorUsage;
	co2: number;
	treesEquivalent: number;
	waterUsage: number;
	estimatedCost: number;
};

type DetailedStats = {
	today: PeriodStats;
	month: PeriodStats;
	lastMonth: PeriodStats;
	last30Days: PeriodStats;
	lastUpdated: string | Date;
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

function calculateProjection(last30DaysValue: number): number {
	// Project annual value based on last 30 days average
	// This gives better predictions at the beginning of the month
	const daysInYear = 365.25; // Average days per year (accounting for leap year cycle)
	return (last30DaysValue / 30) * daysInYear;
}

function render(stats: DetailedStats): void {
	const root = document.getElementById('root');
	if (!root) { return; }

	const projectedTokens = Math.round(calculateProjection(stats.last30Days.tokens));
	const projectedSessions = Math.round(calculateProjection(stats.last30Days.sessions));
	const projectedCo2 = calculateProjection(stats.last30Days.co2);
	const projectedWater = calculateProjection(stats.last30Days.waterUsage);
	const projectedCost = calculateProjection(stats.last30Days.estimatedCost);
	const projectedTrees = calculateProjection(stats.last30Days.treesEquivalent);

	renderShell(root, stats, {
		projectedTokens,
		projectedSessions,
		projectedCo2,
		projectedWater,
		projectedCost,
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
		projectedTrees: number;
	}
): void {
	const lastUpdated = new Date(stats.lastUpdated);

	root.replaceChildren();

	const style = document.createElement('style');
	style.textContent = `
		:root {
			color: #e7e7e7;
			background: #1e1e1e;
			font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
		}
		body { margin: 0; background: #0e0e0f; }
		.container { padding: 16px; display: flex; flex-direction: column; gap: 14px; max-width: 1200px; margin: 0 auto; }
		.header { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding-bottom: 4px; }
		.title { display: flex; align-items: center; gap: 8px; font-size: 16px; font-weight: 700; color: #fff; }
		.button-row { display: flex; flex-wrap: wrap; gap: 8px; }
		.sections { display: flex; flex-direction: column; gap: 16px; }
		.section { background: linear-gradient(135deg, #1b1b1e 0%, #1f1f22 100%); border: 1px solid #2e2e34; border-radius: 10px; padding: 12px; box-shadow: 0 4px 10px rgba(0, 0, 0, 0.28); }
		.section h3 { margin: 0 0 10px 0; font-size: 14px; display: flex; align-items: center; gap: 6px; color: #ffffff; letter-spacing: 0.2px; }
		.stats-table { width: 100%; border-collapse: collapse; table-layout: fixed; background: #1b1b1e; border: 1px solid #2a2a30; border-radius: 8px; overflow: hidden; }
		.stats-table thead { background: #242429; }
		.stats-table th, .stats-table td { padding: 10px 12px; border-bottom: 1px solid #2d2d33; vertical-align: middle; }
		.stats-table th { text-align: left; color: #d0d0d0; font-weight: 700; font-size: 12px; letter-spacing: 0.1px; }
		.stats-table td { color: #f0f0f0; font-size: 12px; }
		.stats-table th.align-right, .stats-table td.align-right { text-align: right; }
		.stats-table tbody tr:nth-child(even) { background: #18181b; }
		.metric-label { display: inline-flex; align-items: center; gap: 6px; font-weight: 600; }
		.period-header { display: flex; align-items: center; gap: 4px; color: #c8c8c8; }
		.align-right .period-header { justify-content: flex-end; }
		.value-right { text-align: right; }
		.muted { color: #a0a0a0; font-size: 11px; margin-top: 4px; }
		.notes { margin: 4px 0 0 0; padding-left: 16px; color: #c8c8c8; }
		.notes li { margin: 4px 0; line-height: 1.4; }
		.footer { color: #a0a0a0; font-size: 11px; margin-top: 6px; }
	`;

	const container = el('div', 'container');
	const header = el('div', 'header');
	const title = el('div', 'title', '🤖 Copilot Token Usage');
	const buttonRow = el('div', 'button-row');

	buttonRow.append(
		createButton(BUTTONS['btn-refresh']),
		createButton(BUTTONS['btn-chart']),
		createButton(BUTTONS['btn-usage']),
		createButton(BUTTONS['btn-diagnostics'])
	);

	header.append(title, buttonRow);

	const footer = el('div', 'footer', `Last updated: ${lastUpdated.toLocaleString()} · Updates every 5 minutes`);

	const sections = el('div', 'sections');
	sections.append(buildMetricsSection(stats, projections));

	const editorSection = buildEditorUsageSection(stats);
	if (editorSection) {
		sections.append(editorSection);
	}

	const modelSection = buildModelUsageSection(stats);
	if (modelSection) {
		sections.append(modelSection);
	}

	sections.append(buildEstimatesSection());

	container.append(header, sections, footer);
	root.append(style, container);
}

function buildMetricsSection(
	stats: DetailedStats,
	projections: {
		projectedTokens: number;
		projectedSessions: number;
		projectedCo2: number;
		projectedWater: number;
		projectedCost: number;
		projectedTrees: number;
	}
): HTMLElement {
	const section = el('div', 'section');
	const heading = el('h3');
	heading.textContent = '🤖 Copilot Token Usage';
	section.append(heading);

	const table = document.createElement('table');
	table.className = 'stats-table';

	const thead = document.createElement('thead');
	const headerRow = document.createElement('tr');
	const headers = [
		{ icon: '📊', text: 'Metric' },
		{ icon: '📅', text: 'Today' },
		{ icon: '📈', text: 'This Month' },
		{ icon: '📆', text: 'Last Month' },
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
	const rows: Array<{ label: string; icon: string; color?: string; today: string; month: string; lastMonth: string; projected: string }> = [
		{ label: 'Tokens', icon: '🟣', color: '#c37bff', today: formatNumber(stats.today.tokens), month: formatNumber(stats.month.tokens), lastMonth: formatNumber(stats.lastMonth.tokens), projected: formatNumber(projections.projectedTokens) },
		{ label: 'Estimated cost', icon: '🪙', color: '#ffd166', today: formatCost(stats.today.estimatedCost), month: formatCost(stats.month.estimatedCost), lastMonth: formatCost(stats.lastMonth.estimatedCost), projected: formatCost(projections.projectedCost) },
		{ label: 'Sessions', icon: '📅', color: '#66aaff', today: formatNumber(stats.today.sessions), month: formatNumber(stats.month.sessions), lastMonth: formatNumber(stats.lastMonth.sessions), projected: formatNumber(projections.projectedSessions) },
		{ label: 'Average interactions/session', icon: '💬', color: '#8ce0ff', today: formatNumber(stats.today.avgInteractionsPerSession), month: formatNumber(stats.month.avgInteractionsPerSession), lastMonth: formatNumber(stats.lastMonth.avgInteractionsPerSession), projected: '—' },
		{ label: 'Average tokens/session', icon: '🔢', color: '#7ce38b', today: formatNumber(stats.today.avgTokensPerSession), month: formatNumber(stats.month.avgTokensPerSession), lastMonth: formatNumber(stats.lastMonth.avgTokensPerSession), projected: '—' },
		{ label: 'Estimated CO₂ (g)', icon: '🌱', color: '#7fe36f', today: `${formatFixed(stats.today.co2, 2)} g`, month: `${formatFixed(stats.month.co2, 2)} g`, lastMonth: `${formatFixed(stats.lastMonth.co2, 2)} g`, projected: `${formatFixed(projections.projectedCo2, 2)} g` },
		{ label: 'Estimated water (L)', icon: '💧', color: '#6fc3ff', today: `${formatFixed(stats.today.waterUsage, 3)} L`, month: `${formatFixed(stats.month.waterUsage, 3)} L`, lastMonth: `${formatFixed(stats.lastMonth.waterUsage, 3)} L`, projected: `${formatFixed(projections.projectedWater, 3)} L` },
		{ label: 'Tree equivalent (yr)', icon: '🌳', color: '#9de67f', today: stats.today.treesEquivalent.toFixed(6), month: stats.month.treesEquivalent.toFixed(6), lastMonth: stats.lastMonth.treesEquivalent.toFixed(6), projected: projections.projectedTrees.toFixed(4) }
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
		labelWrapper.append(iconSpan, textSpan);
		labelTd.append(labelWrapper);

		const todayTd = document.createElement('td');
		todayTd.className = 'value-right align-right';
		todayTd.textContent = row.today;

		const monthTd = document.createElement('td');
		monthTd.className = 'value-right align-right';
		monthTd.textContent = row.month;

		const lastMonthTd = document.createElement('td');
		lastMonthTd.className = 'value-right align-right';
		lastMonthTd.textContent = row.lastMonth;

		const projTd = document.createElement('td');
		projTd.className = 'value-right align-right';
		projTd.textContent = row.projected;

		tr.append(labelTd, todayTd, monthTd, lastMonthTd, projTd);
		tbody.append(tr);
	});

	table.append(tbody);
	section.append(table);
	return section;
}

function buildEditorUsageSection(stats: DetailedStats): HTMLElement | null {
	const allEditors = new Set([
		...Object.keys(stats.today.editorUsage),
		...Object.keys(stats.month.editorUsage),
		...Object.keys(stats.lastMonth.editorUsage)
	]);

	if (allEditors.size === 0) {
		return null;
	}

	const todayTotal = Object.values(stats.today.editorUsage).reduce((sum, e) => sum + e.tokens, 0);
	const monthTotal = Object.values(stats.month.editorUsage).reduce((sum, e) => sum + e.tokens, 0);
	const lastMonthTotal = Object.values(stats.lastMonth.editorUsage).reduce((sum, e) => sum + e.tokens, 0);

	const section = el('div', 'section');
	const heading = el('h3');
	heading.textContent = '💻 Usage by Editor';
	section.append(heading);

	const table = document.createElement('table');
	table.className = 'stats-table';

	const thead = document.createElement('thead');
	const headerRow = document.createElement('tr');
	const headers = [
		{ icon: '📝', text: 'Editor' },
		{ icon: '📅', text: 'Today' },
		{ icon: '📈', text: 'This Month' },
		{ icon: '📆', text: 'Last Month' },
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

	Array.from(allEditors).sort().forEach(editor => {
		const todayUsage = stats.today.editorUsage[editor] || { tokens: 0, sessions: 0 };
		const monthUsage = stats.month.editorUsage[editor] || { tokens: 0, sessions: 0 };
		const lastMonthUsage = stats.lastMonth.editorUsage[editor] || { tokens: 0, sessions: 0 };
		const last30DaysUsage = stats.last30Days.editorUsage[editor] || { tokens: 0, sessions: 0 };
		const todayPercent = todayTotal > 0 ? (todayUsage.tokens / todayTotal) * 100 : 0;
		const monthPercent = monthTotal > 0 ? (monthUsage.tokens / monthTotal) * 100 : 0;
		const lastMonthPercent = lastMonthTotal > 0 ? (lastMonthUsage.tokens / lastMonthTotal) * 100 : 0;
		const projectedTokens = Math.round(calculateProjection(last30DaysUsage.tokens));
		const projectedSessions = Math.round(calculateProjection(last30DaysUsage.sessions));

		const tr = document.createElement('tr');
		const labelTd = document.createElement('td');
		const labelWrapper = document.createElement('span');
		labelWrapper.className = 'metric-label';
		labelWrapper.textContent = `${getEditorIcon(editor)} ${editor}`;
		labelTd.append(labelWrapper);

		const todayTd = document.createElement('td');
		todayTd.className = 'value-right align-right';
		todayTd.textContent = formatNumber(todayUsage.tokens);
		const todaySub = el('div', 'muted', `${formatPercent(todayPercent)} · ${todayUsage.sessions} sessions`);
		todayTd.append(todaySub);

		const monthTd = document.createElement('td');
		monthTd.className = 'value-right align-right';
		monthTd.textContent = formatNumber(monthUsage.tokens);
		const monthSub = el('div', 'muted', `${formatPercent(monthPercent)} · ${monthUsage.sessions} sessions`);
		monthTd.append(monthSub);

		const lastMonthTd = document.createElement('td');
		lastMonthTd.className = 'value-right align-right';
		lastMonthTd.textContent = formatNumber(lastMonthUsage.tokens);
		const lastMonthSub = el('div', 'muted', `${formatPercent(lastMonthPercent)} · ${lastMonthUsage.sessions} sessions`);
		lastMonthTd.append(lastMonthSub);

		const projTd = document.createElement('td');
		projTd.className = 'value-right align-right';
		projTd.textContent = formatNumber(projectedTokens);
		const projSub = el('div', 'muted', `${projectedSessions} sessions`);
		projTd.append(projSub);

		tr.append(labelTd, todayTd, monthTd, lastMonthTd, projTd);
		tbody.append(tr);
	});

	table.append(tbody);
	section.append(table);
	return section;
}

function buildModelUsageSection(stats: DetailedStats): HTMLElement | null {
	const allModels = new Set([
		...Object.keys(stats.today.modelUsage),
		...Object.keys(stats.month.modelUsage),
		...Object.keys(stats.lastMonth.modelUsage)
	]);

	if (allModels.size === 0) {
		return null;
	}

	const section = el('div', 'section');
	const heading = el('h3');
	heading.textContent = '🎯 Model Usage (Tokens)';
	section.append(heading);

	const table = document.createElement('table');
	table.className = 'stats-table';

	const thead = document.createElement('thead');
	const headerRow = document.createElement('tr');
	const headers = [
		{ icon: '🧠', text: 'Model' },
		{ icon: '📅', text: 'Today' },
		{ icon: '📈', text: 'This Month' },
		{ icon: '📆', text: 'Last Month' },
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

	Array.from(allModels).forEach(model => {
		const todayUsage = stats.today.modelUsage[model] || { inputTokens: 0, outputTokens: 0 };
		const monthUsage = stats.month.modelUsage[model] || { inputTokens: 0, outputTokens: 0 };
		const lastMonthUsage = stats.lastMonth.modelUsage[model] || { inputTokens: 0, outputTokens: 0 };
		const last30DaysUsage = stats.last30Days.modelUsage[model] || { inputTokens: 0, outputTokens: 0 };
		const todayTotal = todayUsage.inputTokens + todayUsage.outputTokens;
		const monthTotal = monthUsage.inputTokens + monthUsage.outputTokens;
		const lastMonthTotal = lastMonthUsage.inputTokens + lastMonthUsage.outputTokens;
		const last30DaysTotal = last30DaysUsage.inputTokens + last30DaysUsage.outputTokens;
		const projected = Math.round(calculateProjection(last30DaysTotal));
		const todayInputPct = todayTotal > 0 ? (todayUsage.inputTokens / todayTotal) * 100 : 0;
		const todayOutputPct = todayTotal > 0 ? (todayUsage.outputTokens / todayTotal) * 100 : 0;
		const monthInputPct = monthTotal > 0 ? (monthUsage.inputTokens / monthTotal) * 100 : 0;
		const monthOutputPct = monthTotal > 0 ? (monthUsage.outputTokens / monthTotal) * 100 : 0;
		const lastMonthInputPct = lastMonthTotal > 0 ? (lastMonthUsage.inputTokens / lastMonthTotal) * 100 : 0;
		const lastMonthOutputPct = lastMonthTotal > 0 ? (lastMonthUsage.outputTokens / lastMonthTotal) * 100 : 0;
		const charsPerToken = getCharsPerToken(model);

		const tr = document.createElement('tr');
		const labelTd = document.createElement('td');
		const labelWrapper = document.createElement('span');
		labelWrapper.className = 'metric-label';
		labelWrapper.innerHTML = `${getModelDisplayName(model)} <span style="color:#9aa0a6;font-size:11px; font-weight:500;">(~${charsPerToken.toFixed(1)} chars/tk)</span>`;
		labelTd.append(labelWrapper);

		const todayTd = document.createElement('td');
		todayTd.className = 'value-right align-right';
		todayTd.textContent = formatNumber(todayTotal);
		const todaySub = el('div', 'muted', `↑${formatPercent(todayInputPct)} ↓${formatPercent(todayOutputPct)}`);
		todayTd.append(todaySub);

		const monthTd = document.createElement('td');
		monthTd.className = 'value-right align-right';
		monthTd.textContent = formatNumber(monthTotal);
		const monthSub = el('div', 'muted', `↑${formatPercent(monthInputPct)} ↓${formatPercent(monthOutputPct)}`);
		monthTd.append(monthSub);

		const lastMonthTd = document.createElement('td');
		lastMonthTd.className = 'value-right align-right';
		lastMonthTd.textContent = formatNumber(lastMonthTotal);
		const lastMonthSub = el('div', 'muted', `↑${formatPercent(lastMonthInputPct)} ↓${formatPercent(lastMonthOutputPct)}`);
		lastMonthTd.append(lastMonthSub);

		const projTd = document.createElement('td');
		projTd.className = 'value-right align-right';
		projTd.textContent = formatNumber(projected);

		tr.append(labelTd, todayTd, monthTd, lastMonthTd, projTd);
		tbody.append(tr);
	});

	table.append(tbody);
	section.append(table);
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

void bootstrap();
