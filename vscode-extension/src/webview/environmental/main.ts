// Environmental Impact webview
import { el, createButton } from '../shared/domUtils';
import { BUTTONS } from '../shared/buttonConfig';
import { formatFixed, formatNumber } from '../shared/formatUtils';
// CSS imported as text via esbuild
import themeStyles from '../shared/theme.css';
import styles from './styles.css';

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
};

declare function acquireVsCodeApi<TState = unknown>(): {
	postMessage: (message: any) => void;
	setState: (newState: TState) => void;
	getState: () => TState | undefined;
};

type VSCodeApi = ReturnType<typeof acquireVsCodeApi>;

declare global {
	interface Window {
		__INITIAL_ENVIRONMENTAL__?: EnvironmentalStats;
	}
}

const vscode: VSCodeApi = acquireVsCodeApi();
const initialData = window.__INITIAL_ENVIRONMENTAL__;

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
	const root = document.getElementById('root');
	if (!root) { return; }

	const projectedCo2 = calculateProjection(stats.last30Days.co2);
	const projectedWater = calculateProjection(stats.last30Days.waterUsage);
	const projectedTrees = calculateProjection(stats.last30Days.treesEquivalent);
	const projectedTokens = Math.round(calculateProjection(stats.last30Days.tokens));

	const lastUpdated = new Date(stats.lastUpdated);

	root.replaceChildren();

	const themeStyle = document.createElement('style');
	themeStyle.textContent = themeStyles;
	const style = document.createElement('style');
	style.textContent = styles;

	const container = el('div', 'container');
	const header = el('div', 'header');
	const title = el('div', 'title', '🌿 Environmental Impact');

	const buttonRow = el('div', 'button-row');
	buttonRow.append(
		createButton(BUTTONS['btn-refresh']),
		createButton(BUTTONS['btn-details']),
		createButton(BUTTONS['btn-chart']),
		createButton(BUTTONS['btn-usage']),
		createButton(BUTTONS['btn-diagnostics']),
		createButton(BUTTONS['btn-maturity'])
	);
	if (stats.backendConfigured) {
		buttonRow.append(createButton(BUTTONS['btn-dashboard']));
	}
	header.append(title, buttonRow);

	const footer = el('div', 'footer', `Last updated: ${lastUpdated.toLocaleString()} · Updates every 5 minutes`);
	const sections = el('div', 'sections');

	sections.append(buildImpactCards(stats, projectedTokens, projectedCo2, projectedWater, projectedTrees));
	sections.append(buildEstimatesSection());

	container.append(header, sections, footer);
	root.append(themeStyle, style, container);

	wireButtons();
}

function buildImpactCards(
	stats: EnvironmentalStats,
	projectedTokens: number,
	projectedCo2: number,
	projectedWater: number,
	projectedTrees: number
): HTMLElement {
	const section = el('div', 'section');
	const heading = el('h3');
	heading.textContent = '🌍 Impact at a Glance';
	section.append(heading);

	const intro = el('p', 'section-intro');
	intro.textContent = 'All figures are estimates based on average data center energy and water consumption figures. Analogies use European averages. Treat these as order-of-magnitude indicators, not precise measurements.';
	section.append(intro);

	const periods: Array<[string, string, AnalogyItem[] | null]>[] = [
		// Tokens card: 4 periods, no analogies
		[
			['📅 Today', formatNumber(stats.today.tokens), null],
			['📈 Last 30 Days', formatNumber(stats.last30Days.tokens), null],
			['📆 Previous Month', formatNumber(stats.lastMonth.tokens), null],
			['🌍 Projected Year', formatNumber(projectedTokens), null],
		],
		// CO₂ card
		[
			['📅 Today', `${smartFixed(stats.today.co2)} g`, co2AnalogyItems(stats.today.co2)],
			['📈 Last 30 Days', `${smartFixed(stats.last30Days.co2)} g`, co2AnalogyItems(stats.last30Days.co2)],
			['📆 Previous Month', `${smartFixed(stats.lastMonth.co2)} g`, co2AnalogyItems(stats.lastMonth.co2)],
			['🌍 Projected Year', `${smartFixed(projectedCo2)} g`, co2AnalogyItems(projectedCo2)],
		],
		// Water card
		[
			['📅 Today', `${smartFixed(stats.today.waterUsage)} L`, waterAnalogyItems(stats.today.waterUsage)],
			['📈 Last 30 Days', `${smartFixed(stats.last30Days.waterUsage)} L`, waterAnalogyItems(stats.last30Days.waterUsage)],
			['📆 Previous Month', `${smartFixed(stats.lastMonth.waterUsage)} L`, waterAnalogyItems(stats.lastMonth.waterUsage)],
			['🌍 Projected Year', `${smartFixed(projectedWater)} L`, waterAnalogyItems(projectedWater)],
		],
		// Trees card
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

	periods.forEach((periodCols, i) => {
		const card = el('div', 'metric-card');

		const cardHeader = el('div', 'metric-card-header');
		const iconEl = el('span', 'metric-card-icon', metricHeaders[i].icon);
		iconEl.style.color = metricHeaders[i].color;
		const labelEl = el('span', 'metric-card-label', metricHeaders[i].label);
		cardHeader.append(iconEl, labelEl);
		card.append(cardHeader);

		const grid = el('div', 'analogy-grid');
		periodCols.forEach(([periodLabel, primaryValue, analogies]) => {
			const col = el('div', 'analogy-col');
			col.append(el('div', 'analogy-col-header', periodLabel));
			col.append(el('div', 'metric-primary-value', primaryValue));
			if (analogies) {
				analogies.forEach(item => {
					const itemEl = el('div', 'analogy-item');
					const itemIcon = el('span', 'analogy-icon', item.icon);
					const itemText = document.createElement('span');
					itemText.textContent = item.text;
					itemEl.append(itemIcon, itemText);
					col.append(itemEl);
				});
			}
			grid.append(col);
		});
		card.append(grid);
		cards.append(card);
	});

	section.append(cards);
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
		'Estimated CO₂ is based on ~0.2 g CO₂e per 1,000 tokens (average data center energy mix and PUE).',
		'Estimated water usage is based on ~0.3 L per 1,000 tokens (data center cooling estimates).',
		'Tree equivalent represents the fraction of a single mature tree\'s annual CO₂ absorption (~21 kg/year).',
		'CO₂ analogies: petrol car ≈ 120 g/km · intercity train ≈ 41 g/km · economy flight ≈ 180 g/km (ICAO avg.) · smartphone charge ≈ 8 g · LED bulb ≈ 3 g/hr (10 W, EU grid) · kettle boil ≈ 20 g.',
		'Water analogies: shower ≈ 8 L/min · washing machine ≈ 50 L · standard bathtub ≈ 150 L · dishwasher ≈ 12 L · mug of tea ≈ 250 mL · daily drinking water ≈ 2 L/person.',
		'All analogies are order-of-magnitude estimates. Actual values depend on your region\'s energy mix and device efficiency.'
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
	document.getElementById('btn-refresh')?.addEventListener('click', () => vscode.postMessage({ command: 'refresh' }));
	document.getElementById('btn-details')?.addEventListener('click', () => vscode.postMessage({ command: 'showDetails' }));
	document.getElementById('btn-chart')?.addEventListener('click', () => vscode.postMessage({ command: 'showChart' }));
	document.getElementById('btn-usage')?.addEventListener('click', () => vscode.postMessage({ command: 'showUsageAnalysis' }));
	document.getElementById('btn-diagnostics')?.addEventListener('click', () => vscode.postMessage({ command: 'showDiagnostics' }));
	document.getElementById('btn-maturity')?.addEventListener('click', () => vscode.postMessage({ command: 'showMaturity' }));
	document.getElementById('btn-dashboard')?.addEventListener('click', () => vscode.postMessage({ command: 'showDashboard' }));
}

window.addEventListener('message', (event: MessageEvent) => {
	const message = event.data;
	if (message.command === 'updateStats') {
		render(message.data as EnvironmentalStats);
	}
});

async function bootstrap(): Promise<void> {
	const { provideVSCodeDesignSystem, vsCodeButton } = await import('@vscode/webview-ui-toolkit');
	provideVSCodeDesignSystem().register(vsCodeButton());

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
