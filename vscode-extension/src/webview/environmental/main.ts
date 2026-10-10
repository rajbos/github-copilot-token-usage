// Environmental Impact webview
import { el, createButton, iconHeading } from '../shared/domUtils';
import { getNavButtons } from '../shared/buttonConfig';
import { formatFixed, formatNumber, formatCompact, setCompactNumbers } from '../shared/formatUtils';
import { wireExtensionPointButtons } from '../shared/extensionPoints';
// CSS imported as text via esbuild
import themeStyles from '../shared/theme.css';
import dataTableStyles from '../shared/dataTable.css';
import styles from './styles.css';
import { getWindowData } from '../../../../src/webview/shared/dataLoader';
import { registerMessageHandler } from '../shared/messageHandler';
import { localize } from '../shared/localization';
import { applyWebviewLocale } from '../shared/webviewLocale';
import { installSurfaceNavigation } from '../shared/surfaceNavigation';

// --- Analogy constants ---
/** Average EU petrol car CO₂ emissions per km (grams) */
const CO2_GRAMS_PER_CAR_KM = 120;
/** CO₂ emitted for one full kettle boil (2 L, EU average grid) (grams) */
const CO2_GRAMS_PER_KETTLE_BOIL = 20;
/** CO₂ emitted per km on EU intercity rail (grams) */
const CO2_GRAMS_PER_TRAIN_KM = 41;
/** CO₂ emitted per km flying economy short-haul (grams, ICAO average per passenger) */
const CO2_GRAMS_PER_FLIGHT_KM = 180;
/** Approximate CO₂ to charge a smartphone once on EU average grid (grams) */
const CO2_GRAMS_PER_PHONE_CHARGE = 8;
/** CO₂ to run a 10 W LED bulb for one hour on EU average grid (grams) */
const CO2_GRAMS_PER_LED_HOUR = 3;
/** Water used per minute in a typical shower (liters) */
const WATER_LITERS_PER_SHOWER_MINUTE = 8;
/** Water per modern washing machine load (liters) */
const WATER_LITERS_PER_WASHER_LOAD = 50;
/** Water per mug of tea or coffee (liters) */
const WATER_LITERS_PER_MUG = 0.25;
/** Water in a standard bathtub fill (liters) */
const WATER_LITERS_PER_BATHTUB = 150;
/** Water per modern dishwasher cycle (liters) */
const WATER_LITERS_PER_DISHWASHER = 12;
/** Daily drinking water per person (liters) */
const WATER_LITERS_DAILY_DRINKING = 2;

type PeriodStats = {
	tokens: number;
	co2: number;
	treesEquivalent: number;
	waterUsage: number;
};

type EnvironmentalStats = {
	today: PeriodStats;
	month: PeriodStats;
	lastMonth: PeriodStats;
	last30Days: PeriodStats;
	lastUpdated: string | Date;
	backendConfigured?: boolean;
	compactNumbers?: boolean;
};

declare function acquireVsCodeApi<TState = unknown>(): {
	postMessage: (message: any) => void;
	setState: (newState: TState) => void;
	getState: () => TState | undefined;
};

type VSCodeApi = ReturnType<typeof acquireVsCodeApi>;

const vscode: VSCodeApi = acquireVsCodeApi();
installSurfaceNavigation(vscode, 'environmental');
const initialData = getWindowData<EnvironmentalStats & { localization?: Record<string, string> }>('__INITIAL_ENVIRONMENTAL__');

// Initialize localization for webview
applyWebviewLocale(initialData);

function calculateProjection(last30DaysValue: number): number {
	return (last30DaysValue / 30) * 365.25;
}

/** Adaptive precision: <0.001 → 6dp, <1 → 4dp, ≤100 → 2dp, ≤1000 → 1dp, >1000 → 0dp */
function smartFixed(value: number): string {
	if (value < 0.001) { return formatFixed(value, 6); }
	if (value < 1) { return formatFixed(value, 4); }
	if (value <= 100) { return formatFixed(value, 2); }
	if (value <= 1000) { return formatFixed(value, 1); }
	return formatFixed(Math.round(value), 0);
}

/** Format CO₂ in grams, switching to kg notation when ≥ 1 000 g */
function formatCo2Grams(grams: number): string {
	if (grams >= 1000) {
		return `${smartFixed(grams / 1000)} kg`;
	}
	return `${smartFixed(grams)} g`;
}

type AnalogyItem = { icon: string; text: string };

const co2AnalogyItems = (grams: number): AnalogyItem[] => [
	{ icon: '🚗', text: `${smartFixed(grams / CO2_GRAMS_PER_CAR_KM)} km driving (EU petrol car)` },
	{ icon: '🚂', text: `${smartFixed(grams / CO2_GRAMS_PER_TRAIN_KM)} km by train (EU intercity)` },
	{ icon: '✈️', text: `${smartFixed(grams / CO2_GRAMS_PER_FLIGHT_KM)} km flying (economy, short-haul)` },
	{ icon: '🫖', text: `${smartFixed(grams / CO2_GRAMS_PER_KETTLE_BOIL)} kettle boils` },
	{ icon: '📱', text: `${smartFixed(grams / CO2_GRAMS_PER_PHONE_CHARGE)} smartphone charges` },
	{ icon: '💡', text: `${smartFixed(grams / CO2_GRAMS_PER_LED_HOUR)} hours of LED lighting (10 W)` },
];

const waterAnalogyItems = (liters: number): AnalogyItem[] => [
	{ icon: '☕', text: `${smartFixed(liters / WATER_LITERS_PER_MUG)} mugs of tea/coffee` },
	{ icon: '🚿', text: `${smartFixed(liters / WATER_LITERS_PER_SHOWER_MINUTE)} shower minutes` },
	{ icon: '👕', text: `${smartFixed(liters / WATER_LITERS_PER_WASHER_LOAD)} washing machine loads` },
	{ icon: '🛁', text: `${smartFixed(liters / WATER_LITERS_PER_BATHTUB)} standard bathtubs` },
	{ icon: '🍽️', text: `${smartFixed(liters / WATER_LITERS_PER_DISHWASHER)} dishwasher cycles` },
	{ icon: '💧', text: `${smartFixed(liters / WATER_LITERS_DAILY_DRINKING)} days of drinking water` },
];

const treeAnalogyItems = (fraction: number): AnalogyItem[] => {
	const daysAbsorbed = fraction * 365.25;
	if (fraction >= 1) {
		return [
			{ icon: '🌳', text: `${smartFixed(fraction)} × a tree's full annual CO₂ absorption` },
			{ icon: '🌲', text: `Plant ${Math.ceil(fraction)} trees to fully offset this per year` },
		];
	}
	return [
		{ icon: '🌳', text: `${smartFixed(fraction * 100)} % of one tree's annual absorption` },
		{ icon: '📅', text: `1 tree absorbs this CO₂ in about ${smartFixed(daysAbsorbed)} days` },
	];
};

function render(stats: EnvironmentalStats): void {
	setCompactNumbers(stats.compactNumbers !== false);
	const root = document.getElementById('root');
	if (!root) { return; }

	const projectedCo2 = calculateProjection(stats.last30Days.co2);
	const projectedWater = calculateProjection(stats.last30Days.waterUsage);
	const projectedTrees = calculateProjection(stats.last30Days.treesEquivalent);
	const projectedTokens = Math.round(calculateProjection(stats.last30Days.tokens));

	const lastUpdated = new Date(stats.lastUpdated);

	root.replaceChildren();

	const themeStyle = document.createElement('style');
	themeStyle.textContent = `${themeStyles}\n${dataTableStyles}`;
	const style = document.createElement('style');
	style.textContent = styles;

	const container = el('div', 'container');
	const header = el('div', 'header');
	const title = el('div', 'title', '🌿 Environmental Impact');

	const buttonRow = el('div', 'button-row');
	buttonRow.append(...getNavButtons('btn-environmental', !!stats.backendConfigured).map(config => createButton(config)));
	header.append(title, buttonRow);

	const footer = el('div', 'footer', `Last updated: ${lastUpdated.toLocaleString()} · Updates every 5 minutes`);
	const sections = el('div', 'sections');

	sections.append(buildImpactCards(stats, projectedTokens, projectedCo2, projectedWater, projectedTrees));
	sections.append(buildEstimatesSection());

	container.append(header, sections, footer);
	root.append(themeStyle, style, container);

	wireButtons();
}

function buildAnalogyColumn(periodLabel: string, primaryValue: string, analogies: AnalogyItem[] | null): HTMLElement {
	const col = el('div', 'analogy-col');
	col.append(el('div', 'analogy-col-header', periodLabel));
	col.append(el('div', 'metric-primary-value', primaryValue));
	if (analogies) {
		for (const item of analogies) {
			const itemEl = el('div', 'analogy-item');
			itemEl.append(el('span', 'analogy-icon', item.icon));
			const itemText = document.createElement('span');
			itemText.textContent = item.text;
			itemEl.append(itemText);
			col.append(itemEl);
		}
	}
	return col;
}

function buildMetricCard(periodCols: Array<[string, string, AnalogyItem[] | null]>, header: { icon: string; label: string; color: string }): HTMLElement {
	const card = el('div', 'metric-card');
	const cardHeader = el('div', 'metric-card-header');
	const iconEl = el('span', 'metric-card-icon', header.icon);
	iconEl.style.color = header.color;
	cardHeader.append(iconEl, el('span', 'metric-card-label', header.label));
	card.append(cardHeader);
	const grid = el('div', 'analogy-grid');
	for (const [periodLabel, primaryValue, analogies] of periodCols) {
		grid.append(buildAnalogyColumn(periodLabel, primaryValue, analogies));
	}
	card.append(grid);
	return card;
}

function buildImpactCards(
	stats: EnvironmentalStats,
	projectedTokens: number,
	projectedCo2: number,
	projectedWater: number,
	projectedTrees: number
): HTMLElement {
	const section = el('div', 'section');
	section.id = 'section-impact';
	const heading = iconHeading('h3', 'globe', 'Impact at a Glance');
	section.append(heading);

	const intro = el('p', 'section-intro');
	intro.textContent = localize('environmental.intro');
	section.append(intro);

	const periods: Array<[string, string, AnalogyItem[] | null]>[] = [
		[
			['📅 Today', formatCompact(stats.today.tokens), null],
			['📈 Last 30 Days', formatCompact(stats.last30Days.tokens), null],
			['📆 Previous Month', formatCompact(stats.lastMonth.tokens), null],
			['🌍 Projected Year', formatCompact(projectedTokens), null],
		],
		[
			['📅 Today', formatCo2Grams(stats.today.co2), co2AnalogyItems(stats.today.co2)],
			['📈 Last 30 Days', formatCo2Grams(stats.last30Days.co2), co2AnalogyItems(stats.last30Days.co2)],
			['📆 Previous Month', formatCo2Grams(stats.lastMonth.co2), co2AnalogyItems(stats.lastMonth.co2)],
			['🌍 Projected Year', formatCo2Grams(projectedCo2), co2AnalogyItems(projectedCo2)],
		],
		[
			['📅 Today', `${smartFixed(stats.today.waterUsage)} L`, waterAnalogyItems(stats.today.waterUsage)],
			['📈 Last 30 Days', `${smartFixed(stats.last30Days.waterUsage)} L`, waterAnalogyItems(stats.last30Days.waterUsage)],
			['📆 Previous Month', `${smartFixed(stats.lastMonth.waterUsage)} L`, waterAnalogyItems(stats.lastMonth.waterUsage)],
			['🌍 Projected Year', `${smartFixed(projectedWater)} L`, waterAnalogyItems(projectedWater)],
		],
		[
			['📅 Today', `${smartFixed(stats.today.treesEquivalent)} 🌳`, treeAnalogyItems(stats.today.treesEquivalent)],
			['📈 Last 30 Days', `${smartFixed(stats.last30Days.treesEquivalent)} 🌳`, treeAnalogyItems(stats.last30Days.treesEquivalent)],
			['📆 Previous Month', `${smartFixed(stats.lastMonth.treesEquivalent)} 🌳`, treeAnalogyItems(stats.lastMonth.treesEquivalent)],
			['🌍 Projected Year', `${smartFixed(projectedTrees)} 🌳`, treeAnalogyItems(projectedTrees)],
		],
	];

	const metricHeaders: Array<{ icon: string; label: string; color: string }> = [
		{ icon: '🟣', label: 'Tokens (total)', color: '#c37bff' },
		{ icon: '🌱', label: 'Estimated CO₂', color: '#7fe36f' },
		{ icon: '💧', label: 'Estimated Water', color: '#6fc3ff' },
		{ icon: '🌳', label: 'Tree equivalent', color: '#9de67f' },
	];

	const cards = el('div', 'metric-cards');
	periods.forEach((periodCols, i) => cards.append(buildMetricCard(periodCols, metricHeaders[i])));
	section.append(cards);
	return section;
}

function buildEstimatesSection(): HTMLElement {
	const section = el('div', 'section');
	section.id = 'section-methodology';
	const heading = iconHeading('h3', 'lightbulb', localize('environmental.methodology.heading'));
	section.append(heading);

	const notes = document.createElement('ul');
	notes.className = 'notes';

	const items = [
		localize('environmental.methodology.cost'),
		localize('environmental.methodology.co2Paper'),
		localize('environmental.methodology.co2Weights'),
		localize('environmental.methodology.modelScaling'),
		localize('environmental.methodology.water'),
		localize('environmental.methodology.tree'),
		localize('environmental.methodology.co2Analogies'),
		localize('environmental.methodology.waterAnalogies'),
		localize('environmental.methodology.caveat'),
	];

	items.forEach(text => {
		const li = document.createElement('li');
		li.textContent = text;
		notes.append(li);
	});
	notes.append(buildSourcesItem());

	section.append(notes);
	return section;
}

/**
 * Links to the methodology sources. The host maps the id to a fixed URL, so the
 * webview never asks it to open an arbitrary address.
 */
function buildSourcesItem(): HTMLElement {
	const li = document.createElement('li');
	li.append(`${localize('environmental.methodology.sources')} `);
	const links: Array<[string, string]> = [
		['paper', localize('environmental.methodology.paperLink')],
		['neuland', localize('environmental.methodology.neulandLink')],
	];
	links.forEach(([source, label], i) => {
		if (i > 0) { li.append(' · '); }
		const a = document.createElement('a');
		a.href = '#';
		a.textContent = label;
		a.addEventListener('click', (event) => {
			event.preventDefault();
			vscode.postMessage({ command: 'openMethodologySource', source });
		});
		li.append(a);
	});
	return li;
}

function wireButtons(): void {
	document.getElementById('btn-refresh')?.addEventListener('click', () => vscode.postMessage({ command: 'refresh' }));
	document.getElementById('btn-details')?.addEventListener('click', () => vscode.postMessage({ command: 'showDetails' }));
	document.getElementById('btn-chart')?.addEventListener('click', () => vscode.postMessage({ command: 'showChart' }));
	document.getElementById('btn-usage')?.addEventListener('click', () => vscode.postMessage({ command: 'showUsageAnalysis' }));
	document.getElementById('btn-diagnostics')?.addEventListener('click', () => vscode.postMessage({ command: 'showDiagnostics' }));
	document.getElementById('btn-maturity')?.addEventListener('click', () => vscode.postMessage({ command: 'showMaturity' }));
	document.getElementById('btn-dashboard')?.addEventListener('click', () => vscode.postMessage({ command: 'showDashboard' }));
	document.getElementById('btn-efficiency')?.addEventListener('click', () => vscode.postMessage({ command: 'showEfficiency' }));
	wireExtensionPointButtons(vscode);
}

registerMessageHandler<{ command: string; data?: EnvironmentalStats }>((message) => {
	if (message.command === 'updateStats') {
		render(message.data as EnvironmentalStats);
	}
});

async function bootstrap(): Promise<void> {
	await import('@vscode-elements/elements/dist/vscode-button/index.js');

	if (initialData) {
		render(initialData);
	} else {
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

bootstrap();
