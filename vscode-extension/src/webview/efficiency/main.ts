// Efficiency webview — "am I working more efficiently over time, and why?"
// Renders weekly ratio trends, month-over-month delta cards, a cost-change
// decomposition (volume vs. efficiency vs. model mix), value signals, and a
// combined indexed chart that overlays the ratio series with output.
import { navButtonsHtml } from '../shared/buttonConfig';
import { setHtml } from '../shared/domUtils';
import { createViewStateManager } from '../shared/viewState';
import type { WebviewStateApi } from '../shared/viewState';
import { escapeHtml, formatCompact, formatCost, formatNumber, formatSignedCostCompact, setCompactNumbers, setFormatLocale } from '../shared/formatUtils';
import type { CacheBreakCause } from '../../../../src/cacheBreakage';
import { wireExtensionPointButtons } from '../shared/extensionPoints';
import themeStyles from '../shared/theme.css';
import dataTableStyles from '../shared/dataTable.css';
import styles from './styles.css';
import { getWindowData } from '../../../../src/webview/shared/dataLoader';
import type {
	ComparableModel,
	CostAttribution,
	EfficiencyBucket,
	EfficiencyBucketPoint,
	EfficiencyBucketResolution,
	EfficiencyDelta,
	EfficiencyRange,
	EfficiencyRangeId,
	EfficiencyViewData,
	ModelComparison,
	ModelComparisonMetricId,
	ModelComparisonRow,
	ModelCompareSelection,
	ModelCompareWindowId,
	ModelPeriodMetrics,
	SkillImpact,
	SkillUsageTrends,
} from '../../../../src/efficiencyAnalysis';
import {
	EFFICIENCY_RANGE_OPTIONS,
	buildEfficiencyBuckets,
	buildEfficiencyBucketSeries,
	buildModelBucketSeries,
	buildSkillUsageSeries,
	compareModels,
	computeModelPeriodMetrics,
	computeSkillImpact,
	efficiencyTodayKey,
	filterModelsByVendor,
	filterSessionsByEditor,
	listComparableModels,
	listModelVendors,
	resolveEfficiencyRange,
	resolveModelCompareWindow,
	selectDaysInWindow,
	selectModelDaysForEditor,
	windowHasModelData,
	listEligibleModels,
	reconcileModelSelection,
	valueSignalsEqual,
} from '../../../../src/efficiencyAnalysis';
import {
	activeBuckets,
	activeRange,
	activeResolution,
	activeResolutionOptions,
	canDrillInto,
	defaultScopeState,
	describeScope,
	drillBack,
	drillInto,
	isDrilled,
	normalizeScopeState,
	rangeExceedsBehaviorWindow,
	selectRange,
} from './viewState';
import type { EfficiencyScopeState } from './viewState';
import { localize, localizeFormat } from '../shared/localization';
import { applyWebviewLocale } from '../shared/webviewLocale';
import { registerMessageHandler } from '../shared/messageHandler';
import { createEfficiencyWebviewReadyNotifier, isValueSignalsPayload } from './valueUpdate';
import { renderModelMixTable } from './modelMixTable';
import { fmtValue, renderModelComparisonTable, renderSkillImpactTable } from './efficiencyTables';
import { buildAttributionTooltip } from './attributionText';
import { installSurfaceNavigation } from '../shared/surfaceNavigation';

// Minimal structural types for the dynamically imported Chart.js bundle —
// a `typeof import('chart.js/auto')` type-import trips TS1542 under CJS resolution.
type ChartInstance = { destroy(): void };
type ChartConstructor = new (canvas: HTMLCanvasElement, config: unknown) => ChartInstance;

declare function acquireVsCodeApi<TState = unknown>(): {
	postMessage: (message: unknown) => void;
	setState: (newState: TState) => void;
	getState: () => TState | undefined;
};

const vscode = acquireVsCodeApi();
installSurfaceNavigation(vscode, 'efficiency');
const notifyEfficiencyWebviewReady = createEfficiencyWebviewReadyNotifier(
	(message) => vscode.postMessage(message),
);
// Mutable: the host pushes a fresh Value snapshot when Repository PR data lands after this
// document was rendered (see `valueSignalsUpdated` below), which must survive tab switches.
let data = getWindowData<EfficiencyViewData & { localization?: Record<string, string> }>('__INITIAL_EFFICIENCY__');

// Initialize localization for webview
applyWebviewLocale(data);

let Chart: ChartConstructor | undefined;
const liveCharts: ChartInstance[] = [];

async function loadChartModule(): Promise<void> {
	if (Chart) { return; }
	const mod = await import('chart.js/auto') as { default: unknown };
	Chart = mod.default as ChartConstructor;
}

type TabId = 'trends' | 'skills' | 'deltas' | 'attribution' | 'cache' | 'models' | 'value' | 'combined';
let activeTab: TabId = 'trends';

const TABS: { id: TabId; label: string }[] = [
	{ id: 'trends', label: '📈 Trends' },
	{ id: 'skills', label: '🛠️ Tools & Skills' },
	{ id: 'deltas', label: '🗓️ Month vs Month' },
	{ id: 'attribution', label: '💸 Cost Attribution' },
	{ id: 'cache', label: '⚡ Prompt Cache' },
	{ id: 'models', label: '🤖 Models' },
	{ id: 'value', label: '🎁 Value' },
	{ id: 'combined', label: '🧩 Combined' },
];

/**
 * Tabs to show for this dataset. The Prompt Cache tab only exists when there is
 * cache-breakage data to put in it (Claude Code / Claude Desktop sessions).
 */
function visibleTabs(d: EfficiencyViewData): { id: TabId; label: string }[] {
	return TABS.filter(t => t.id !== 'cache' || d.cacheBreakage);
}


// ── Scope: time preset, resolution, drill-down and tab-scoped filters ──

/**
 * Which tabs carry the scope toolbar, and which filters each may show.
 *
 * Deliberately not universal. Cost Attribution explains a whole population's
 * model-mix cost change, and a mixed-model session would be counted under
 * several categorical filters at once, so filtering it would make its volume
 * term dishonest. Month vs Month compares fixed adjacent calendar periods from
 * global detailed metrics. Value measures PR outcomes, which are not currently
 * attributable to a session, editor or model. Those three get no toolbar rather
 * than a toolbar that cannot tell the truth.
 */
const SCOPE_POLICY: Partial<Record<TabId, { editor: boolean; vendor: boolean; behavioral: boolean }>> = {
	trends: { editor: true, vendor: false, behavioral: true },
	combined: { editor: true, vendor: false, behavioral: true },
	skills: { editor: true, vendor: false, behavioral: true },
	// `behavioral: false` — the Models tab draws from `modelDaily`, which carries
	// a full year, so the session-window caveat would be false there.
	models: { editor: true, vendor: true, behavioral: false },
};

/**
 * Persisted view state. Goes through the shared `createViewStateManager` so a
 * partial update never discards a field this view has not read yet.
 */
interface EfficiencyPersistedState extends Record<string, unknown> {
	activeTab: TabId;
	scope: EfficiencyScopeState;
}

const viewStateManager = createViewStateManager<EfficiencyPersistedState>(
	vscode as WebviewStateApi<EfficiencyPersistedState>,
	{ activeTab: 'trends', scope: defaultScopeState() },
);

let scope: EfficiencyScopeState = defaultScopeState();

function restorePersistedState(): void {
	const saved = viewStateManager.restore();
	scope = normalizeScopeState(saved.scope);
	if (TABS.some(t => t.id === saved.activeTab)) { activeTab = saved.activeTab; }
}

function persistState(): void {
	viewStateManager.patch({ activeTab, scope });
}

/** The reference "now" for range maths — the moment the extension built this payload. */
function payloadNow(d: EfficiencyViewData): Date {
	const parsed = new Date(d.lastUpdated);
	return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

/** Everything the scoped tabs render, recomputed from the compact payload on every scope change. */
interface ScopedData {
	/**
	 * False for a payload that predates the compact daily aggregates. The view
	 * then falls back to the host-computed weekly series and hides the toolbar
	 * rather than offering controls that would silently do nothing.
	 */
	supported: boolean;
	range: EfficiencyRange;
	resolution: EfficiencyBucketResolution;
	buckets: EfficiencyBucket[];
	points: EfficiencyBucketPoint[];
	hasLoc: boolean;
	hasDuration: boolean;
	hasRetry: boolean;
	hasApply: boolean;
	skills: SkillUsageTrends;
	skillImpact: SkillImpact[];
	hasSkills: boolean;
	/** True when the range reaches further back than the session-behaviour window. */
	behaviorGap: boolean;
	/**
	 * True when the range still reaches today, so its last bucket is only
	 * partly filled. A drilled-into historical week or month ends in the past
	 * and is complete — saying otherwise would read as missing data.
	 */
	includesToday: boolean;
	/** Editor this view is scoped to, or undefined for every editor. */
	editor: string | undefined;
}

/** Recomputes every scoped series from the cached aggregates — no host round trip, no log reparse. */
function computeScopedData(d: EfficiencyViewData): ScopedData {
	const now = payloadNow(d);
	const editor = scope.editor || undefined;
	if (!d.dailyVolume) {
		// A payload from before the compact aggregates existed. Chart what the
		// host pre-computed and leave the toolbar off, but still give the Models
		// drift chart a weekly axis to draw on.
		const legacyRange: EfficiencyRange = {
			id: 'custom',
			label: `Last ${d.weekly.length} weeks`,
			startKey: d.weekly[0]?.startKey ?? '',
			endKey: d.weekly.at(-1)?.endKey ?? '',
		};
		return {
			supported: false,
			range: legacyRange,
			resolution: 'weekly',
			buckets: buildEfficiencyBuckets(resolveEfficiencyRange('last12w', now), 'weekly'),
			points: d.weekly,
			hasLoc: d.hasLoc, hasDuration: d.hasDuration, hasRetry: d.hasRetry, hasApply: d.hasApply,
			skills: d.skillTrends, skillImpact: d.skillImpact, hasSkills: d.hasSkills,
			behaviorGap: false,
			includesToday: true,
			editor: undefined,
		};
	}
	const range = activeRange(scope, now);
	const buckets = activeBuckets(scope, now);
	const samples = d.sessionSamples ?? [];
	const inRange = samples.filter(s => s.dayKey >= range.startKey && s.dayKey <= range.endKey);
	const points = buildEfficiencyBucketSeries(d.dailyVolume, samples, buckets, { editor });
	const skills = buildSkillUsageSeries(samples, buckets, { editor });
	return {
		supported: true,
		range,
		resolution: activeResolution(scope, now),
		buckets,
		points,
		hasLoc: points.some(p => p.loc > 0),
		hasDuration: points.some(p => p.activeMinutesPerSession !== null),
		hasRetry: points.some(p => p.retryRate !== null),
		hasApply: points.some(p => p.applyRate !== null),
		skills,
		skillImpact: computeSkillImpact(filterSessionsByEditor(inRange, editor)),
		hasSkills: skills.totalCalls > 0,
		behaviorGap: rangeExceedsBehaviorWindow(scope, now, d.behaviorWindowDays),
		includesToday: range.endKey >= efficiencyTodayKey(now),
		editor,
	};
}

/** Model day rows scoped to the selected editor. */
function scopedModelDaily(d: EfficiencyViewData): typeof d.modelDaily {
	return selectModelDaysForEditor(d.modelDaily, scope.editor || undefined);
}

// ── Scope toolbar ──────────────────────────────────────────────────────

function resolutionLabel(resolution: EfficiencyBucketResolution): string {
	return localize(`efficiency.resolution.${resolution}`);
}

/** Localized name of the active range: a preset's own label, or the drilled-into date span. */
function rangeLabel(s: ScopedData): string {
	return isDrilled(scope) ? s.range.label : localize(`efficiency.range.${scope.rangeId}`);
}

function rangeButtonsHtml(): string {
	const buttons = EFFICIENCY_RANGE_OPTIONS.map(o => {
		const active = !isDrilled(scope) && scope.rangeId === o.id;
		return `<button type="button" class="scope-preset ${active ? 'active' : ''}" data-range="${o.id}" aria-pressed="${active}">${escapeHtml(localize(`efficiency.range.${o.id}`))}</button>`;
	}).join('');
	return `<div class="scope-presets" role="group" aria-label="${escapeHtml(localize('efficiency.scope.timeRangeGroup'))}">${buttons}</div>`;
}

function resolutionSelectHtml(d: EfficiencyViewData): string {
	const now = payloadNow(d);
	const options = [
		{ value: 'auto', label: localizeFormat('efficiency.resolution.auto', resolutionLabel(activeResolution(scope, now)).toLowerCase()) },
		...activeResolutionOptions(scope, now).map(r => ({ value: r, label: resolutionLabel(r) })),
	];
	return selectHtml('eff-resolution', options, scope.resolution);
}

/**
 * Keeps a persisted filter value visible even when it no longer exists in the
 * data — a machine that used to have Claude Code sessions, an editor that has
 * aged out of the window.
 *
 * Without this the `<select>` would fall back to showing its first option
 * ("All editors") while the charts stayed filtered to the missing value, so an
 * empty result would look like it came from the visible selection.
 */
function withStaleValue(options: { value: string; label: string }[], selected: string): { value: string; label: string }[] {
	if (!selected || options.some(o => o.value === selected)) { return options; }
	return [...options, { value: selected, label: localizeFormat('efficiency.scope.noDataFor', selected) }];
}

function editorSelectHtml(d: EfficiencyViewData, s: ScopedData): string {
	// `d.editors` spans the payload's whole year, so an editor last used six
	// months ago would look ordinary while a 30-day scope charts nothing for it.
	// Mark the ones with no volume in the *active* range.
	const inRange = editorsWithDataInRange(d, s);
	const options = withStaleValue(
		[
			{ value: '', label: localize('efficiency.scope.allEditors') },
			...(d.editors ?? []).map(e => ({ value: e, label: inRange.has(e) ? e : localizeFormat('efficiency.scope.noDataFor', e) })),
		],
		scope.editor,
	);
	return selectHtml('eff-editor', options, scope.editor);
}

/** Editors with any token volume inside the range currently being charted. */
function editorsWithDataInRange(d: EfficiencyViewData, s: ScopedData): Set<string> {
	const present = new Set<string>();
	for (const day of d.dailyVolume ?? []) {
		if (day.date < s.range.startKey || day.date > s.range.endKey) { continue; }
		for (const [editor, slice] of Object.entries(day.byEditor ?? {})) {
			if (slice.tokens > 0) { present.add(editor); }
		}
	}
	return present;
}

function vendorSelectHtml(d: EfficiencyViewData): string {
	const options = withStaleValue(
		[{ value: '', label: localize('efficiency.scope.allVendors') }, ...listModelVendors(d.modelDaily).map(v => ({ value: v, label: v }))],
		scope.vendor,
	);
	return selectHtml('eff-vendor', options, scope.vendor);
}

/**
 * The toolbar above a scoped chart: time presets, resolution, the drill-down
 * chip and its Back action, plus whichever categorical filters this tab is
 * allowed to carry. Every control is a real `<button>`/`<select>`, so the whole
 * toolbar is keyboard reachable, and the live region announces the resulting
 * scope to a screen reader after each change.
 */
function renderScopeToolbar(d: EfficiencyViewData, s: ScopedData): string {
	const policy = SCOPE_POLICY[activeTab];
	if (!policy || !s.supported) { return ''; }
	const drill = isDrilled(scope)
		? `<span class="scope-chip">🔍 ${escapeHtml(s.range.label)}<button type="button" id="eff-drill-back" class="scope-back" aria-label="${escapeHtml(localize('efficiency.scope.backAria'))}">${escapeHtml(localize('efficiency.scope.back'))}</button></span>`
		: canDrillInto(s.resolution)
			? `<span class="scope-hint">${escapeHtml(localize(`efficiency.scope.drillHint${s.resolution === 'weekly' ? 'Weekly' : 'Monthly'}`))}</span>`
			: '';
	// The vendor filter only applies on Models; announcing it elsewhere would
	// tell a screen-reader user the chart is scoped in a way it is not.
	const announcement = describeScope(scope, {
		range: rangeLabel(s),
		resolution: resolutionLabel(s.resolution),
		allEditors: localize('efficiency.scope.allEditors'),
		allVendors: localize('efficiency.scope.allVendors'),
		includeVendor: policy.vendor,
	});
	return `
		<div class="scope-toolbar">
			${rangeButtonsHtml()}
			<label class="scope-field">${escapeHtml(localize('efficiency.resolution.label'))} ${resolutionSelectHtml(d)}</label>
			${policy.editor ? `<label class="scope-field">${escapeHtml(localize('efficiency.scope.editorLabel'))} ${editorSelectHtml(d, s)}</label>` : ''}
			${policy.vendor ? `<label class="scope-field">${escapeHtml(localize('efficiency.scope.vendorLabel'))} ${vendorSelectHtml(d)}</label>` : ''}
			${drillSelectHtml(s)}
			${drill}
		</div>
		<p class="scope-announce" role="status" aria-live="polite">${escapeHtml(localizeFormat('efficiency.scope.announce', announcement))}</p>
		${s.behaviorGap && policy.behavioral ? `<p class="scope-caveat">${escapeHtml(localizeFormat('efficiency.scope.behaviorGap', Math.round((d.behaviorWindowDays ?? 84) / 7)))}</p>` : ''}
		${scope.editor ? `<p class="scope-caveat">${escapeHtml(localizeFormat('efficiency.scope.editorScoped', scope.editor))}</p>` : ''}`;
}

/** Shape Chart.js hands the click handler for the element under the cursor. */
type ChartClickElement = { index: number };

/**
 * Turns a click on an aggregated data point into a drill-down into the days it
 * contains. Returns undefined when the series is already daily, so Chart.js is
 * not given a handler that would do nothing.
 */
function drillClickHandler(s: ScopedData): ((event: unknown, elements: ChartClickElement[]) => void) | undefined {
	if (!s.supported || !canDrillInto(s.resolution)) { return undefined; }
	return (_event, elements) => {
		const bucket = elements.length > 0 ? s.buckets[elements[0].index] : undefined;
		if (bucket) { applyScope(drillInto(scope, bucket)); }
	};
}

/**
 * Keyboard/screen-reader equivalent of clicking a data point. A `<canvas>` is
 * not focusable and its points are not in the accessibility tree, so without
 * this the drill-down would be mouse-only.
 */
function drillSelectHtml(s: ScopedData): string {
	if (!canDrillInto(s.resolution) || s.buckets.length === 0) { return ''; }
	const options = [{ value: '', label: localize('efficiency.scope.drillPlaceholder') }, ...s.buckets.map(b => ({ value: b.key, label: b.label }))];
	return `<label class="scope-field">${escapeHtml(localize('efficiency.scope.drillLabel'))} ${selectHtml('eff-drill-pick', options, '')}</label>`;
}

// ── Formatting ─────────────────────────────────────────────────────────

function cssVar(name: string, fallback: string): string {
	const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
	return v || fallback;
}

/**
 * Signed dollar amount for on-bar and summary display. Two decimals normally,
 * four when a non-zero effect would otherwise round away to "$0.00" — the
 * tooltips carry the full-precision value.
 */
function fmtMoney(v: number): string {
	return formatSignedCostCompact(v);
}

/** Uppercases the first letter only — for window labels that read lowercase mid-sentence. */
function capitalizeFirst(s: string): string {
	return s.length > 0 ? s[0].toUpperCase() + s.slice(1) : s;
}

// ── Trend maths ────────────────────────────────────────────────────────

/**
 * Direction of a series over the window: compares the average of the first
 * and second halves (ignoring nulls) — more robust than endpoint deltas on
 * noisy weekly data. Returns percent change, or null with too little data.
 */
function halfOverHalfChange(values: (number | null)[]): number | null {
	const present = values.map((v, i) => ({ v, i })).filter((x): x is { v: number; i: number } => x.v !== null);
	if (present.length < 4) { return null; }
	const mid = Math.floor(present.length / 2);
	const avg = (xs: { v: number }[]) => xs.reduce((s, x) => s + x.v, 0) / xs.length;
	const first = avg(present.slice(0, mid));
	const second = avg(present.slice(mid));
	if (first === 0) { return null; }
	return ((second - first) / Math.abs(first)) * 100;
}

function trendBadge(values: (number | null)[], goodDirection: 'up' | 'down'): string {
	const change = halfOverHalfChange(values);
	if (change === null) { return ''; }
	if (Math.abs(change) < 5) { return `<span class="trend-badge flat">→ steady</span>`; }
	const arrow = change > 0 ? '↑' : '↓';
	const good = (change < 0) === (goodDirection === 'down');
	return `<span class="trend-badge ${good ? 'good' : 'bad'}">${arrow} ${Math.abs(change).toFixed(0)}%</span>`;
}

// ── Verdict ────────────────────────────────────────────────────────────

function computeVerdict(d: EfficiencyViewData): { cls: string; icon: string; text: string } {
	const scored = d.deltas.filter(x => x.improved !== null);
	if (scored.length === 0) {
		return { cls: 'unknown', icon: '🔍', text: 'Not enough data yet to judge an efficiency trend — keep using AI-assisted sessions and check back after a few weeks.' };
	}
	const improved = scored.filter(x => x.improved).length;
	const share = improved / scored.length;
	const detail = `${improved} of ${scored.length} efficiency metrics improved vs. ${escapeHtml(d.deltaWindows.prev)}`;
	if (share >= 0.6) { return { cls: 'improving', icon: '🚀', text: `You are trending more efficient: ${detail}.` }; }
	if (share >= 0.4) { return { cls: 'mixed', icon: '⚖️', text: `Mixed picture: ${detail}. Check the tabs below to see which levers moved.` }; }
	return { cls: 'declining', icon: '🧭', text: `Efficiency dipped: only ${detail}. The Cost Attribution tab shows where the change came from.` };
}

// ── Section renderers ──────────────────────────────────────────────────

type TrendSpec = {
	id: string;
	title: string;
	desc: string;
	goodDirection: 'up' | 'down';
	values: (number | null)[];
	format: (v: number) => string;
	available: boolean;
	unavailableHint: string;
};

function buildTrendSpecs(s: ScopedData): TrendSpec[] {
	const w = s.points;
	return [
		{
			id: 'cost-per-kloc', title: '💰 Cost per 1K lines changed', goodDirection: 'down',
			desc: 'Estimated cost divided by lines of code added + removed. The headline "value per dollar" ratio.',
			values: w.map(x => x.costPerKloc), format: v => `$${v.toFixed(2)}`,
			available: s.hasLoc, unavailableHint: 'No lines-of-code data found in your sessions yet.',
		},
		{
			id: 'tokens-per-session', title: '🎟️ Tokens per session', goodDirection: 'down',
			desc: 'Total tokens divided by sessions. Falling values mean leaner sessions for the same work.',
			values: w.map(x => x.tokensPerSession), format: v => formatCompact(Math.round(v)),
			available: true, unavailableHint: '',
		},
		{
			id: 'turns-per-session', title: '🔄 Turns per session', goodDirection: 'down',
			desc: 'User requests per session. Less back-and-forth to reach a usable result.',
			values: w.map(x => x.turnsPerSession), format: v => v.toFixed(1),
			available: true, unavailableHint: '',
		},
		{
			id: 'active-minutes', title: '⏱️ Active minutes per session', goodDirection: 'down',
			desc: 'Net working time per session, excluding idle gaps. Session length going down.',
			values: w.map(x => x.activeMinutesPerSession), format: v => `${v.toFixed(0)} min`,
			available: s.hasDuration, unavailableHint: 'No session-duration data available for these weeks.',
		},
		{
			id: 'retry-rate', title: '🔁 Edit retry rate', goodDirection: 'down',
			desc: 'Share of edit turns needing a retry. Lower = edits land first time (quality going up).',
			values: w.map(x => x.retryRate === null ? null : x.retryRate * 100), format: v => `${v.toFixed(0)}%`,
			available: s.hasRetry, unavailableHint: 'Not enough edit turns per week to compute retry rates.',
		},
		{
			id: 'apply-rate', title: '✅ Apply rate', goodDirection: 'up',
			desc: 'Share of suggested code blocks you applied. Higher = more directly usable output.',
			values: w.map(x => x.applyRate === null ? null : x.applyRate * 100), format: v => `${v.toFixed(0)}%`,
			available: s.hasApply, unavailableHint: 'No apply-button data in these sessions (agent/CLI sessions apply edits directly).',
		},
		{
			id: 'loc-per-dollar', title: '📦 Lines changed per dollar', goodDirection: 'up',
			desc: 'Output per unit of spend — the inverse view of cost per 1K lines.',
			values: w.map(x => x.locPerDollar), format: v => v.toFixed(0),
			available: s.hasLoc, unavailableHint: 'No lines-of-code data found in your sessions yet.',
		},
	];
}

function renderTrendsTab(d: EfficiencyViewData, s: ScopedData): string {
	const cards = buildTrendSpecs(s).map(spec => {
		const body = spec.available
			? `<div class="chart-wrap"><canvas id="trend-${spec.id}"></canvas></div>`
			: `<div class="trend-empty">${escapeHtml(spec.unavailableHint)}</div>`;
		return `
			<div class="trend-card">
				<h3><span>${spec.title}</span>${spec.available ? trendBadge(spec.values, spec.goodDirection) : ''}</h3>
				<p class="trend-desc">${escapeHtml(spec.desc)}</p>
				${body}
			</div>`;
	}).join('');
	return `
		${renderScopeToolbar(d, s)}
		<p class="eff-section-note">${escapeHtml(trendsIntro(s))}</p>
		<div class="trend-grid">${cards}</div>`;
}

/** Capitalized resolution suffix of the per-resolution localization keys. */
function resolutionKeySuffix(resolution: EfficiencyBucketResolution): string {
	return resolution.charAt(0).toUpperCase() + resolution.slice(1);
}

/** Opening sentence of a scoped chart: what is on the x-axis, and over what window. */
function bucketIntro(s: ScopedData): string {
	const buckets = localizeFormat(`efficiency.trends.buckets${resolutionKeySuffix(s.resolution)}`, s.points.length);
	return localizeFormat('efficiency.trends.bucketIntro', resolutionLabel(s.resolution), rangeLabel(s), buckets);
}

/**
 * The Trends tab's section note. The partial-period sentence is only true while
 * the range still reaches today: a drilled-into past week is finished, and
 * calling its last day partial would send the reader looking for data that was
 * never missing.
 */
function trendsIntro(s: ScopedData): string {
	const parts = [bucketIntro(s), localize('efficiency.trends.badges')];
	if (s.includesToday) { parts.push(localize(`efficiency.trends.partial${resolutionKeySuffix(s.resolution)}`)); }
	return parts.join(' ');
}

function renderDeltasTab(d: EfficiencyViewData): string {
	const cards = d.deltas.map(delta => {
		let change = '<span class="delta-na">not enough data</span>';
		if (delta.deltaPct !== null) {
			const cls = delta.improved === null ? 'flat' : delta.improved ? 'good' : 'bad';
			const arrow = delta.deltaPct > 0 ? '↑' : delta.deltaPct < 0 ? '↓' : '→';
			change = `<span class="delta-change ${cls}">${arrow} ${Math.abs(delta.deltaPct).toFixed(0)}%</span>`;
		}
		return `
			<div class="delta-card">
				<h3>${escapeHtml(delta.label)}</h3>
				<div class="delta-values">
					<span class="delta-cur">${fmtValue(delta.cur, delta.unit)}</span>
					${change}
				</div>
				<div class="delta-prev">was ${fmtValue(delta.prev, delta.unit)} in ${escapeHtml(d.deltaWindows.prev)}</div>
				<p class="delta-desc">${escapeHtml(delta.description)}</p>
			</div>`;
	}).join('');
	return `
		<p class="eff-section-note">${escapeHtml(d.deltaWindows.cur)} compared with ${escapeHtml(d.deltaWindows.prev)}. All metrics are per-session ratios or shares, so a partial month compares fairly against a full one.</p>
		<div class="delta-grid">${cards}</div>`;
}

/**
 * One factor bar. `tooltip` is prebuilt plain text (see `buildAttributionTooltip`)
 * and is escaped here into the row's title attribute.
 */
function attrBar(label: string, detail: string, value: number, maxAbs: number, tooltip: string): string {
	const widthPct = maxAbs > 0 ? Math.min(50, (Math.abs(value) / maxAbs) * 50) : 0;
	const side = value >= 0 ? `left: 50%; width: ${widthPct}%;` : `right: 50%; width: ${widthPct}%;`;
	const cls = value >= 0 ? 'pos' : 'neg';
	return `
		<div class="attr-bar-row" title="${escapeHtml(tooltip)}">
			<div class="attr-bar-label">${escapeHtml(label)}<div class="attr-bar-detail">${escapeHtml(detail)}</div></div>
			<div class="attr-bar-track"><div class="attr-bar-mid"></div><div class="attr-bar-fill ${cls}" style="${side}"></div></div>
			<div class="attr-bar-value">${fmtMoney(value)}<div class="attr-bar-effect">${escapeHtml(localize('efficiency.attribution.costEffect'))}</div></div>
		</div>`;
}

function renderAttributionTab(d: EfficiencyViewData): string {
	const a: CostAttribution | null = d.attribution;
	if (!a) {
		return `<p class="eff-section-note">Not enough data to decompose the cost change — both compared windows need at least one session with token data.</p>`;
	}
	const maxAbs = Math.max(Math.abs(a.volumeEffect), Math.abs(a.efficiencyEffect), Math.abs(a.mixEffect), 0.01);
	const shifts = a.modelShifts.length === 0 ? '' : renderModelMixTable(a.modelShifts, d.attributionWindows);
	return `
		<p class="eff-section-note">The periods are adjacent, not overlapping: ${escapeHtml(capitalizeFirst(d.attributionWindows.prev))} is <b>${escapeHtml(d.attributionWindows.prevRange)}</b>; ${escapeHtml(d.attributionWindows.cur)} is <b>${escapeHtml(d.attributionWindows.curRange)}</b>. Each bar is a <b>what-if dollar amount</b>, not a session count: starting from the earlier cost, the factors are applied in order. Green reduces estimated cost; red increases it.</p>
		<div class="attr-summary">
			<div class="attr-stat"><div class="stat-label">${escapeHtml(capitalizeFirst(d.attributionWindows.prev))}</div><div class="stat-value">${formatCost(a.prev.cost)}</div><div class="stat-sub">${escapeHtml(localizeFormat('efficiency.attribution.periodSub', d.attributionWindows.prevRange, formatNumber(a.prev.sessions), formatCompact(a.prev.tokens)))}</div></div>
			<div class="attr-stat"><div class="stat-label">${escapeHtml(capitalizeFirst(d.attributionWindows.cur))}</div><div class="stat-value">${formatCost(a.cur.cost)}</div><div class="stat-sub">${escapeHtml(localizeFormat('efficiency.attribution.periodSub', d.attributionWindows.curRange, formatNumber(a.cur.sessions), formatCompact(a.cur.tokens)))}</div></div>
			<div class="attr-stat"><div class="stat-label">${escapeHtml(localize('efficiency.attribution.change'))}</div><div class="stat-value">${fmtMoney(a.deltaCost)}</div><div class="stat-sub">${escapeHtml(localizeFormat('efficiency.attribution.blendedRate', formatCost(a.prev.dollarsPerMTokens), formatCost(a.cur.dollarsPerMTokens)))}</div></div>
		</div>
		<div class="attr-bars">
			${attrBar('Volume (session count)', `${formatNumber(a.prev.sessions)} → ${formatNumber(a.cur.sessions)} sessions`, a.volumeEffect, maxAbs, buildAttributionTooltip({ headlineKey: 'efficiency.attribution.tooltip.volume', prev: a.prev.sessions, cur: a.cur.sessions, kind: 'count', effect: a.volumeEffect }))}
			${attrBar('Session size (tokens/session)', `${formatCompact(a.prev.tokensPerSession)} → ${formatCompact(a.cur.tokensPerSession)} tokens/session`, a.efficiencyEffect, maxAbs, buildAttributionTooltip({ headlineKey: 'efficiency.attribution.tooltip.size', prev: a.prev.tokensPerSession, cur: a.cur.tokensPerSession, kind: 'tokens', effect: a.efficiencyEffect }))}
			${attrBar('Model mix ($/token)', `${formatCost(a.prev.dollarsPerMTokens)} → ${formatCost(a.cur.dollarsPerMTokens)} /M tokens`, a.mixEffect, maxAbs, buildAttributionTooltip({ headlineKey: 'efficiency.attribution.tooltip.mix', prev: a.prev.dollarsPerMTokens, cur: a.cur.dollarsPerMTokens, kind: 'rate', effect: a.mixEffect }))}
		</div>
		${shifts}`;
}

function skillImpactCard(impact: SkillImpact): string {
	return `
		<div class="skill-impact-card">
			<h3>🛠️ ${escapeHtml(impact.skill)}</h3>
			<div class="skill-impact-sub">${impact.withSkill.sessions} sessions with · ${impact.withoutSkill.sessions} without · ${impact.totalCalls} invocations</div>
			${renderSkillImpactTable(impact)}
		</div>`;
}

function renderSkillsTab(d: EfficiencyViewData, s: ScopedData): string {
	const toolbar = renderScopeToolbar(d, s);
	if (!s.hasSkills) {
		return `
			${toolbar}
			<p class="eff-section-note">No agent-skill invocations detected in ${escapeHtml(s.range.label.toLowerCase())}${s.editor ? ` for ${escapeHtml(s.editor)}` : ''}. Skills are custom slash-commands and packaged instructions (e.g. <code>/graphify</code>) detected in Claude Code, Claude Desktop, and Copilot CLI session logs. Once you use them, this tab shows usage over time and whether skill-assisted sessions run leaner than the rest.</p>`;
	}
	const impactSection = s.skillImpact.length > 0
		? `<h3 class="skill-section-heading">Do skill-assisted sessions run differently?</h3>
			<p class="eff-section-note">Sessions that invoked each skill compared with all sessions that did not, over the same window. Green means the skill cohort looks leaner. ⚠️ This is correlation, not causation — sessions where you reach for a skill may simply be different kinds of work.</p>
			<div class="skill-impact-grid">${s.skillImpact.map(skillImpactCard).join('')}</div>`
		: `<p class="eff-section-note">No skill has enough sessions yet for a with/without comparison (needs at least 5 sessions on each side).</p>`;
	return `
		${toolbar}
		<p class="eff-section-note">${s.skills.totalCalls} skill invocations across ${s.skills.topSkills.length} skill${s.skills.topSkills.length === 1 ? '' : 's'} over ${escapeHtml(s.range.label.toLowerCase())}. Bars stack invocations per skill; the line is the share of sessions that used any skill.</p>
		<div class="combined-wrap"><canvas id="skills-chart"></canvas></div>
		${impactSection}`;
}

async function drawSkillsChart(s: ScopedData, generation: number): Promise<void> {
	await loadChartModule();
	if (!Chart || !isCurrentRender(generation)) { return; }
	const canvas = document.getElementById('skills-chart') as HTMLCanvasElement | null;
	if (!canvas) { return; }
	const weeks = s.skills.weeks;
	const labels = weeks.map(w => w.label);
	const fg = cssVar('--vscode-descriptionForeground', '#999');
	const grid = cssVar('--vscode-widget-border', 'rgba(128,128,128,0.2)');
	const palette = [
		cssVar('--vscode-charts-blue', '#60a5fa'),
		cssVar('--vscode-charts-purple', '#c37bff'),
		cssVar('--vscode-charts-green', '#4ade80'),
		cssVar('--vscode-charts-yellow', '#fbbf24'),
		cssVar('--vscode-charts-orange', '#ff9f40'),
		cssVar('--vscode-charts-red', '#fb7185'),
	];
	const topSkills = s.skills.topSkills.slice(0, 6);
	const otherSkills = s.skills.topSkills.slice(6);
	const datasets: object[] = topSkills.map((skill, idx) => ({
		type: 'bar' as const,
		label: skill,
		data: weeks.map(w => w.byName[skill] ?? 0),
		backgroundColor: palette[idx % palette.length],
		stack: 'skills',
		yAxisID: 'y',
	}));
	if (otherSkills.length > 0) {
		datasets.push({
			type: 'bar' as const,
			label: 'Other skills',
			data: weeks.map(w => otherSkills.reduce((s, name) => s + (w.byName[name] ?? 0), 0)),
			backgroundColor: 'rgba(150,150,150,0.5)',
			stack: 'skills',
			yAxisID: 'y',
		});
	}
	datasets.push({
		type: 'line' as const,
		label: '% of sessions using a skill',
		data: weeks.map(w => w.skillShare === null ? null : w.skillShare * 100),
		borderColor: fg,
		backgroundColor: fg,
		spanGaps: true,
		tension: 0.25,
		pointRadius: 2,
		yAxisID: 'yShare',
	});
	liveCharts.push(new Chart(canvas, {
		data: { labels, datasets } as never,
		options: {
			responsive: true,
			maintainAspectRatio: false,
			onClick: drillClickHandler(s),
			plugins: { legend: { position: 'bottom', labels: { color: fg, boxWidth: 14 } } },
			scales: {
				x: { stacked: true, ticks: { color: fg, maxRotation: 45, autoSkip: true }, grid: { display: false } },
				y: { stacked: true, beginAtZero: true, title: { display: true, text: 'Skill invocations', color: fg }, ticks: { color: fg }, grid: { color: grid } },
				yShare: { position: 'right' as const, beginAtZero: true, max: 100, title: { display: true, text: '% of sessions', color: fg }, ticks: { color: fg }, grid: { display: false } },
			},
		},
	} as never));
}

function renderValueTab(d: EfficiencyViewData): string {
	const v = d.value;
	const cards: string[] = [];
	const since = v.prsSince ? escapeHtml(new Date(v.prsSince).toLocaleDateString()) : '—';
	if (v.userPrs !== null) {
		cards.push(`
			<div class="value-card"><h3>🚢 Merged PRs</h3>
				<div class="value-big">${v.mergedPrs ?? '—'}</div>
				<div class="value-sub">of ${v.userPrs} you opened since ${since}${v.prsPerWeek !== null ? ` · ${v.prsPerWeek.toFixed(1)}/week merged` : ''}</div>
			</div>`);
		cards.push(`
			<div class="value-card"><h3>💵 Cost per merged PR</h3>
				<div class="value-big">${v.costPerMergedPr !== null ? `$${v.costPerMergedPr.toFixed(2)}` : '—'}</div>
				<div class="value-sub">estimated 30-day AI cost divided by the PRs you actually shipped — the most outcome-shaped efficiency metric available</div>
			</div>`);
	}
	cards.push(`
		<div class="value-card"><h3>✅ Apply rate</h3>
			<div class="value-big">${v.applyRate !== null ? `${(v.applyRate * 100).toFixed(0)}%` : '—'}</div>
			<div class="value-sub">${v.applyRate !== null ? `${v.appliedBlocks} of ${v.totalBlocks} suggested code blocks applied in the last 30 days` : 'No apply-button data (agent and CLI sessions apply edits directly)'}</div>
		</div>`);
	cards.push(`
		<div class="value-card"><h3>📦 Lines changed per dollar</h3>
			<div class="value-big">${v.locPerDollar !== null ? v.locPerDollar.toFixed(0) : '—'}</div>
			<div class="value-sub">${v.locPerDollar !== null ? `${formatCompact(v.linesChanged)} lines over ~$${v.periodCost.toFixed(2)} in the last 30 days` : 'Needs lines-of-code data and non-zero estimated cost'}</div>
		</div>`);
	if (v.aiPrs !== null) {
		cards.push(`
			<div class="value-card"><h3>🤖 Delegated to AI agents</h3>
				<div class="value-big">${v.aiPrs}</div>
				<div class="value-sub">PRs opened by an AI bot account (Copilot coding agent, Claude, Codex). ${v.aiPrs === 0 ? 'Zero is expected when you drive AI locally and open PRs yourself — your work is counted under Merged PRs.' : 'These ran autonomously in the cloud rather than in your editor.'}</div>
			</div>`);
	}
	// The empty state stays explanatory, but the destination it names is one click away:
	// the button asks the host to reveal Usage Analysis *on* the Repository PRs tab, which
	// is what actually fills these cards.
	// `{0}` is the emphasized destination name; the bundle's own text is the only markup
	// interpolated into it, and the destination itself is escaped before emphasis.
	const destination = `<b>${escapeHtml(localize('efficiency.value.prsHintDestination'))}</b>`;
	const hint = v.userPrs === null
		? `<div class="value-hint">
				<span class="value-hint-text">${localizeFormat('efficiency.value.prsHint', destination)}</span>
				<vscode-button id="btn-open-repo-prs" appearance="secondary">${escapeHtml(localize('efficiency.value.openRepositoryPrs'))}</vscode-button>
			</div>`
		: '';
	return `
		<p class="eff-section-note">Efficiency only counts when output holds up. These metrics measure what your AI usage produced, not what it consumed.</p>
		<div class="value-grid">${cards.join('')}</div>
		${hint}`;
}

function renderCombinedTab(d: EfficiencyViewData, s: ScopedData): string {
	return `
		${renderScopeToolbar(d, s)}
		<p class="eff-section-note">Everything on one chart. Ratio lines are <b>indexed to 100</b> at their first measured bucket so different units share one axis — a line falling below 100 means that ratio improved (except apply rate, where up is good). Bars show raw lines-of-code output per bucket: efficiency gains only count if the bars hold up.</p>
		<div class="combined-wrap"><canvas id="combined-chart"></canvas></div>`;
}

// ── Models tab ─────────────────────────────────────────────────────────

/** Metric accessors for the per-model weekly trend chart. */
const MODEL_TREND_METRICS: { id: ModelComparisonMetricId; label: string; unit: EfficiencyDelta['unit']; goodDirection: 'up' | 'down'; pick: (m: ModelPeriodMetrics) => number | null }[] = [
	{ id: 'cost-per-edit-turn', label: 'Cost per edit turn', unit: 'currency', goodDirection: 'down', pick: m => m.costPerEditTurn },
	{ id: 'cost-per-session', label: 'Cost per session', unit: 'currency', goodDirection: 'down', pick: m => m.costPerSession },
	{ id: 'cost-per-kloc', label: 'Cost per 1000 lines', unit: 'currency', goodDirection: 'down', pick: m => m.costPerKloc },
	{ id: 'one-shot-rate', label: 'One-shot edit rate', unit: 'percent', goodDirection: 'up', pick: m => m.oneShotRate },
	{ id: 'retry-rate', label: 'Edit retry rate', unit: 'ratio', goodDirection: 'down', pick: m => m.retryRate },
	{ id: 'tokens-per-edit-turn', label: 'Tokens per edit turn', unit: 'tokens', goodDirection: 'down', pick: m => m.tokensPerEditTurn },
	{ id: 'active-minutes-per-session', label: 'Active minutes per session', unit: 'minutes', goodDirection: 'down', pick: m => m.activeMinutesPerSession },
];

/** Metrics shown on the normalized radar — one axis per dimension of "efficient". */
const RADAR_METRICS: ModelComparisonMetricId[] = [
	'cost-per-edit-turn', 'one-shot-rate', 'retry-rate', 'tokens-per-edit-turn', 'active-minutes-per-session', 'apply-rate',
];

const WINDOW_OPTIONS: { id: ModelCompareWindowId; label: string }[] = [
	{ id: 'last30', label: 'Last 30 days' },
	{ id: 'prev30', label: 'Previous 30 days' },
	{ id: 'last90', label: 'Last 90 days' },
	{ id: 'thisMonth', label: 'This month' },
	{ id: 'lastMonth', label: 'Last month' },
];

type CompareMode = ModelCompareSelection['mode'];

const modelState: ModelCompareSelection & {
	trendMetric: ModelComparisonMetricId;
	initialized: boolean;
} = {
	mode: 'models', modelA: '', modelB: '',
	window: 'last30', windowA: 'lastMonth', windowB: 'thisMonth',
	trendMetric: 'cost-per-edit-turn', initialized: false,
};

/** Which window ids currently have per-model data, in `WINDOW_OPTIONS` order. */
function availableWindowIds(d: EfficiencyViewData, now: Date): ModelCompareWindowId[] {
	return WINDOW_OPTIONS
		.map(w => w.id)
		.filter(id => windowHasModelData(scopedModelDaily(d), resolveModelCompareWindow(id, now)));
}

/**
 * The models the pickers may offer: present in the selected editor's rows, and
 * served by the selected vendor.
 *
 * Vendor here is the model's own provider ({@link listModelVendors}), never the
 * party that bills for the call — a Claude model used through Copilot stays an
 * Anthropic model, and conflating the two would silently change which models
 * the filter hides.
 */
function eligibleModels(d: EfficiencyViewData): ComparableModel[] {
	return listEligibleModels(scopedModelDaily(d), modelState, payloadNow(d), scope.vendor || undefined);
}

/**
 * Re-points a comparison window that the narrowed scope emptied at one that
 * still has data.
 *
 * Without this, picking an editor or vendor whose data does not reach into the
 * selected window leaves the tab in its no-data state even though another
 * window would show a perfectly good comparison — and the window picker renders
 * the culprit as a disabled option, so the cause is not obvious.
 */
function reconcileModelWindows(d: EfficiencyViewData): void {
	const available = availableWindowIds(d, payloadNow(d));
	if (available.length === 0) { return; }
	const fix = (id: ModelCompareWindowId): ModelCompareWindowId => available.includes(id) ? id : available[0];
	modelState.window = fix(modelState.window);
	modelState.windowA = fix(modelState.windowA);
	modelState.windowB = available.includes(modelState.windowB)
		? modelState.windowB
		: (available.find(w => w !== modelState.windowA) ?? available[0]);
}

/** Picks the windows that actually have data on first render; `reconcileModelState` then fills in the models those windows can compare. */
function initModelState(d: EfficiencyViewData): void {
	if (modelState.initialized) { return; }
	modelState.initialized = true;
	const available = availableWindowIds(d, payloadNow(d));
	if (available.length > 0) {
		modelState.window = available.includes('last30') ? 'last30' : available[0];
		modelState.windowA = available[0];
		modelState.windowB = available.length > 1 ? available[1] : available[0];
	}
}

/**
 * Re-points the model pickers at something the active window(s) can compare.
 *
 * Run on every render, because a mode or window change leaves the previous
 * selection behind — a model that only exists outside the new window would
 * otherwise report a missing side for every offered combination.
 */
function reconcileModelState(d: EfficiencyViewData): void {
	// Windows first: they decide which models are eligible at all.
	reconcileModelWindows(d);
	const next = reconcileModelSelection(scopedModelDaily(d), modelState, payloadNow(d), scope.vendor || undefined);
	modelState.modelA = next.modelA;
	modelState.modelB = next.modelB;
}

/** Resolves the current selection into a comparison, or null when a side has no data. */
function buildModelComparison(d: EfficiencyViewData): ModelComparison | null {
	const now = payloadNow(d);
	const scopedDays = scopedModelDaily(d);
	if (modelState.mode === 'periods') {
		const wA = resolveModelCompareWindow(modelState.windowA, now);
		const wB = resolveModelCompareWindow(modelState.windowB, now);
		const a = computeModelPeriodMetrics(selectDaysInWindow(scopedDays, wA), modelState.modelA, wA.label);
		const b = computeModelPeriodMetrics(selectDaysInWindow(scopedDays, wB), modelState.modelA, wB.label);
		return a && b ? compareModels(a, b) : null;
	}
	const w = resolveModelCompareWindow(modelState.window, now);
	const days = selectDaysInWindow(scopedDays, w);
	const a = computeModelPeriodMetrics(days, modelState.modelA, w.label);
	const b = computeModelPeriodMetrics(days, modelState.modelB, w.label);
	return a && b ? compareModels(a, b) : null;
}

function selectHtml(id: string, options: { value: string; label: string; disabled?: boolean }[], selected: string): string {
	const opts = options.map(o =>
		`<option value="${escapeHtml(o.value)}"${o.value === selected ? ' selected' : ''}${o.disabled ? ' disabled' : ''}>${escapeHtml(o.label)}</option>`
	).join('');
	return `<select id="${id}" class="model-select">${opts}</select>`;
}

/**
 * A searchable picker for long model lists. The native `<select>` stays in the DOM
 * (visually hidden) as the single source of truth, so the `change` handler and the
 * headless harness keep working; the button + filter popup only drive it.
 */
function searchableSelectHtml(id: string, options: { value: string; label: string; disabled?: boolean }[], selected: string): string {
	const current = options.find(o => o.value === selected) ?? options[0];
	const items = options.map(o =>
		`<li role="option" class="combo-item${o.value === selected ? ' selected' : ''}${o.disabled ? ' disabled' : ''}" data-value="${escapeHtml(o.value)}" aria-selected="${o.value === selected}"${o.disabled ? ' aria-disabled="true"' : ''}>${escapeHtml(o.label)}</li>`
	).join('');
	return `<div class="model-combo" data-for="${id}">
		<button type="button" class="model-select combo-button" aria-haspopup="listbox" aria-expanded="false">${escapeHtml(current?.label ?? '')}</button>
		<div class="combo-popup" hidden>
			<input type="text" class="combo-search" placeholder="${escapeHtml(localize('efficiency.models.search.placeholder'))}" aria-label="${escapeHtml(localize('efficiency.models.search.placeholder'))}" autocomplete="off" spellcheck="false">
			<ul role="listbox" class="combo-list">${items}</ul>
			<div class="combo-empty" hidden>${escapeHtml(localize('efficiency.models.search.empty'))}</div>
		</div>
		${selectHtml(id, options, selected).replace('class="model-select"', 'class="model-select combo-native" tabindex="-1"')}
	</div>`;
}

/** Wires every searchable picker: toggle, live filter, keyboard selection, outside-click dismissal. */
function wireSearchableSelects(): void {
	document.querySelectorAll<HTMLElement>('.model-combo').forEach(combo => {
		const button = combo.querySelector<HTMLButtonElement>('.combo-button')!;
		const popup = combo.querySelector<HTMLElement>('.combo-popup')!;
		const search = combo.querySelector<HTMLInputElement>('.combo-search')!;
		const empty = combo.querySelector<HTMLElement>('.combo-empty')!;
		const native = combo.querySelector<HTMLSelectElement>('select')!;
		const items = Array.from(combo.querySelectorAll<HTMLElement>('.combo-item'));
		const selectable = (): HTMLElement[] => items.filter(i => !i.hidden && !i.classList.contains('disabled'));
		const setActive = (item: HTMLElement | undefined): void => {
			items.forEach(i => i.classList.toggle('active', i === item));
			item?.scrollIntoView({ block: 'nearest' });
		};
		const filter = (): void => {
			const q = search.value.trim().toLowerCase();
			items.forEach(i => { i.hidden = q !== '' && !(i.textContent ?? '').toLowerCase().includes(q) && !(i.dataset.value ?? '').toLowerCase().includes(q); });
			const visible = selectable();
			empty.hidden = visible.length > 0;
			setActive(visible[0]);
		};
		const close = (): void => {
			popup.hidden = true;
			button.setAttribute('aria-expanded', 'false');
			document.removeEventListener('mousedown', onOutside, true);
		};
		const onOutside = (ev: MouseEvent): void => { if (!combo.contains(ev.target as Node)) { close(); } };
		const open = (): void => {
			popup.hidden = false;
			button.setAttribute('aria-expanded', 'true');
			search.value = '';
			filter();
			setActive(items.find(i => i.classList.contains('selected')) ?? selectable()[0]);
			search.focus();
			document.addEventListener('mousedown', onOutside, true);
		};
		const choose = (item: HTMLElement): void => {
			if (item.classList.contains('disabled')) { return; }
			close();
			native.value = item.dataset.value ?? '';
			native.dispatchEvent(new Event('change', { bubbles: true }));
		};
		button.addEventListener('click', ev => { ev.preventDefault(); if (popup.hidden) { open(); } else { close(); } });
		// Inside a <label>, a click would otherwise be re-dispatched to the button and toggle the popup shut.
		popup.addEventListener('click', ev => ev.preventDefault());
		search.addEventListener('input', filter);
		items.forEach(i => i.addEventListener('click', () => choose(i)));
		combo.addEventListener('keydown', ev => {
			if (popup.hidden) { return; }
			const visible = selectable();
			const idx = visible.findIndex(i => i.classList.contains('active'));
			if (ev.key === 'ArrowDown') { ev.preventDefault(); setActive(visible[Math.min(idx + 1, visible.length - 1)]); }
			else if (ev.key === 'ArrowUp') { ev.preventDefault(); setActive(visible[Math.max(idx - 1, 0)]); }
			else if (ev.key === 'Enter') { ev.preventDefault(); const a = visible[idx]; if (a) { choose(a); } }
			else if (ev.key === 'Escape') { ev.preventDefault(); close(); button.focus(); }
		});
	});
}

/** Dropdown options for the model pickers: only models the active window(s) can actually compare. */
function modelOptions(eligible: ComparableModel[]): { value: string; label: string }[] {
	return eligible.map(m => ({
		value: m.model,
		label: `${m.displayName} (${m.sessions} sessions${m.sampleSufficient ? '' : ', low sample'})`,
	}));
}

/**
 * Model B's options. Model A is filtered out because the two sides must differ:
 * offering it would be a choice reconciliation immediately undoes, bouncing the
 * picker back on the next render. When that leaves nothing, an explicit
 * placeholder stands in — without one the browser falls back to showing the
 * first option, so the picker would claim a self-comparison the tab is not
 * actually rendering.
 */
function modelBOptions(options: { value: string; label: string; disabled?: boolean }[]): typeof options {
	const distinct = options.filter(o => o.value !== modelState.modelA);
	return modelState.modelB === ''
		? [{ value: '', label: localize('efficiency.models.noSecondModel'), disabled: true }, ...distinct]
		: distinct;
}

/** Dropdown options for the window picker: each label carries its concrete date span, and windows with no per-model data yet are disabled so they can't silently be picked. */
function windowOptions(d: EfficiencyViewData, now: Date): { value: string; label: string; disabled?: boolean }[] {
	const scopedDays = scopedModelDaily(d);
	return WINDOW_OPTIONS.map(w => {
		const resolved = resolveModelCompareWindow(w.id, now);
		const hasData = windowHasModelData(scopedDays, resolved);
		const label = `${w.label} (${resolved.rangeLabel})${hasData ? '' : ' — no data'}`;
		return { value: w.id, label, disabled: !hasData };
	});
}

function renderModelControls(d: EfficiencyViewData, eligible: ComparableModel[]): string {
	const models = modelOptions(eligible);
	const windows = windowOptions(d, payloadNow(d));
	const modeSelect = selectHtml('model-mode', [
		{ value: 'models', label: localize('efficiency.models.mode.models') },
		{ value: 'periods', label: localize('efficiency.models.mode.periods') },
	], modelState.mode);
	const caption = (key: string): string => escapeHtml(localize(`efficiency.models.controls.${key}`));
	// Mode and window(s) share the first row; the model pickers get their own row below.
	const body = modelState.mode === 'periods'
		? `
			<label>${caption('baseline')} ${selectHtml('window-a', windows, modelState.windowA)}</label>
			<label>${caption('comparedWith')} ${selectHtml('window-b', windows, modelState.windowB)}</label>
			<div class="model-controls-break"></div>
			<label>${caption('model')} ${searchableSelectHtml('model-a', models, modelState.modelA)}</label>`
		: `
			<label>${caption('window')} ${selectHtml('window', windows, modelState.window)}</label>
			<div class="model-controls-break"></div>
			<label>${caption('modelA')} ${searchableSelectHtml('model-a', models, modelState.modelA)}</label>
			<label>${caption('modelB')} ${searchableSelectHtml('model-b', modelBOptions(models), modelState.modelB)}</label>`;
	return `<div class="model-controls"><label>${caption('mode')} ${modeSelect}</label>${body}</div>`;
}

/** Renders a side's headline volume so the reader can judge the sample for themselves. */
function sideSummary(m: ModelPeriodMetrics, side: 'A' | 'B'): string {
	return `
		<div class="model-side model-side-${side.toLowerCase()}">
			<div class="model-side-tag">${side}</div>
			<div class="model-side-name">${escapeHtml(m.displayName)}</div>
			<div class="model-side-period">${escapeHtml(m.periodLabel)}</div>
			<div class="model-side-stats">${m.sessions} sessions · ${m.editTurns} edit turns · ${formatCompact(m.tokens)} tokens · $${m.cost.toFixed(2)}</div>
		</div>`;
}

function comparisonTableHtml(cmp: ModelComparison): string {
	const modeKey = modelState.mode === 'periods' ? 'efficiency.models.mode.periods' : 'efficiency.models.mode.models';
	return renderModelComparisonTable(cmp, localize(modeKey));
}

function verdictHtml(cmp: ModelComparison): string {
	if (!cmp.verdict) {
		return `<div class="model-verdict tie">⚖️ No metric differs by more than 10% — on this evidence the two sides perform the same.</div>`;
	}
	const { winner, wins } = cmp.verdict;
	if (winner === 'tie') {
		return `<div class="model-verdict tie">⚖️ Honours even: ${wins.a} metrics favour ${escapeHtml(cmp.a.displayName)} (${escapeHtml(cmp.a.periodLabel)}) and ${wins.b} favour ${escapeHtml(cmp.b.displayName)} (${escapeHtml(cmp.b.periodLabel)}).</div>`;
	}
	const side = winner === 'a' ? cmp.a : cmp.b;
	const count = winner === 'a' ? wins.a : wins.b;
	const other = winner === 'a' ? wins.b : wins.a;
	return `<div class="model-verdict ${winner === 'b' ? 'improving' : 'declining'}">🏆 ${escapeHtml(side.displayName)} (${escapeHtml(side.periodLabel)}) wins ${count} of ${count + other} decisive metrics.</div>`;
}

function caveatsHtml(cmp: ModelComparison): string {
	if (cmp.caveats.length === 0) { return ''; }
	return `
		<div class="model-caveats">
			<h3>⚠️ Read with care</h3>
			<ul>${cmp.caveats.map(c => `<li>${escapeHtml(c)}</li>`).join('')}</ul>
		</div>`;
}

/** Stacked task-mix bar, so a reader can see whether the two sides did comparable work. */
function taskMixHtml(cmp: ModelComparison): string {
	const categories = [...new Set([...Object.keys(cmp.a.taskMix), ...Object.keys(cmp.b.taskMix)])].sort();
	if (categories.length === 0) { return ''; }
	const palette = ['--vscode-charts-blue', '--vscode-charts-green', '--vscode-charts-orange', '--vscode-charts-purple', '--vscode-charts-red', '--vscode-charts-yellow'];
	const bar = (m: ModelPeriodMetrics): string => {
		const segments = categories.map((c, i) => {
			const share = m.taskMix[c] ?? 0;
			if (share <= 0) { return ''; }
			return `<div class="task-seg" style="width:${(share * 100).toFixed(1)}%; background:${cssVar(palette[i % palette.length], '#60a5fa')}" title="${escapeHtml(c)}: ${(share * 100).toFixed(0)}%"></div>`;
		}).join('');
		return `<div class="task-mix-row"><div class="task-mix-label">${escapeHtml(m.displayName)} · ${escapeHtml(m.periodLabel)}</div><div class="task-mix-bar">${segments}</div></div>`;
	};
	const legend = categories.map((c, i) =>
		`<span class="task-legend-item"><span class="task-legend-dot" style="background:${cssVar(palette[i % palette.length], '#60a5fa')}"></span>${escapeHtml(c)}</span>`
	).join('');
	return `
		<h3>What kind of work each side did</h3>
		<p class="eff-section-note">Task categories are classified per session and split across that session's models by token share, so this is context, not a score. Very different mixes mean part of any gap belongs to the work, not the model.</p>
		<div class="task-mix">${bar(cmp.a)}${bar(cmp.b)}</div>
		<div class="task-legend">${legend}</div>`;
}

/**
 * Human-readable cause labels and the advice attached to each. The advice is
 * the point of the tab: a break the user cannot act on is just trivia.
 */
const CACHE_CAUSE_INFO: Record<CacheBreakCause, { label: string; icon: string; advice: string }> = {
	'ttl-expiry': {
		label: 'Idle longer than the cache lifetime',
		icon: '⏳',
		advice: 'The conversation sat idle past the cache lifetime, so the whole prompt had to be written again. Wrapping a session up, or coming back to it sooner, avoids this.',
	},
	'model-switch': {
		label: 'Switched model mid-session',
		icon: '🔀',
		advice: 'Each model keeps its own cache, so switching part-way through re-warms the entire conversation. Choosing the model up front is cheaper than switching later.',
	},
	'prefix-invalidated': {
		label: 'Tools or system prompt changed',
		icon: '🧩',
		advice: 'Something above the conversation changed — usually an MCP server or skill starting or stopping mid-session, which invalidates everything cached beneath it.',
	},
	'compaction': {
		label: 'Context compacted',
		icon: '🗜️',
		advice: 'History was rewritten to fit the context window, which necessarily discards the cached prefix. Largely unavoidable once a session runs long.',
	},
};

const CACHE_CAUSES = Object.keys(CACHE_CAUSE_INFO) as CacheBreakCause[];

/** Verdict on a period-level re-write factor. 1.0 means every token written once. */
function cacheVerdict(factor: number): { cls: string; text: string } {
	if (factor <= 1.15) { return { cls: 'improving', text: 'Healthy — your context is written about once per session, which is the best case.' }; }
	if (factor <= 2) { return { cls: 'mixed', text: 'Some re-warming. A few sessions are paying to write context they had already cached.' }; }
	return { cls: 'declining', text: 'Context is being written several times over. The causes below show where it is going.' };
}

const CACHE_INTRO = 'Re-sent conversation history is billed at a discount while it stays cached, and at a premium when it has to be written again. This tab shows the moments the cached prompt was thrown away over the last 30 days, and what caused each one.';

function renderCacheCauseRow(cause: CacheBreakCause, breaks: number, tokens: number, sharePct: number): string {
	const info = CACHE_CAUSE_INFO[cause];
	return `
		<div class="cache-cause-row">
			<div class="cache-cause-head">
				<span class="cache-cause-label">${info.icon} ${escapeHtml(info.label)}</span>
				<span class="cache-cause-count">${breaks}× · ${formatCompact(tokens)} tokens re-written</span>
			</div>
			<div class="cache-cause-track"><div class="cache-cause-fill" style="width: ${sharePct.toFixed(1)}%"></div></div>
			<p class="cache-cause-advice">${escapeHtml(info.advice)}</p>
		</div>`;
}

function renderCacheTab(d: EfficiencyViewData): string {
	const c = d.cacheBreakage;
	if (!c || c.sessionsAnalyzed === 0) {
		return `<p class="eff-section-note">No prompt-cache data in the last 30 days. Only editors that report per-turn cache token counts (Claude Code, Claude Desktop) can be analysed here.</p>`;
	}
	const factor = c.peakContextTokens > 0 ? c.tokensWritten / c.peakContextTokens : 0;
	const totalBreaks = CACHE_CAUSES.reduce((sum, k) => sum + c.counts[k].breaks, 0);
	const totalRewritten = CACHE_CAUSES.reduce((sum, k) => sum + c.counts[k].tokensRewritten, 0);
	const healthy = c.sessionsAnalyzed - c.sessionsWithBreaks;

	if (totalBreaks === 0) {
		return `
			<p class="eff-section-note">${escapeHtml(CACHE_INTRO)}</p>
			<div class="eff-verdict improving"><span class="verdict-icon">✅</span><span class="verdict-text">No cache breaks across ${c.sessionsAnalyzed} session${c.sessionsAnalyzed === 1 ? '' : 's'} in the last 30 days. Nothing to fix.</span></div>`;
	}

	const verdict = cacheVerdict(factor);
	const rows = CACHE_CAUSES
		.filter(k => c.counts[k].breaks > 0)
		.sort((a, b) => c.counts[b].tokensRewritten - c.counts[a].tokensRewritten)
		.map(k => renderCacheCauseRow(
			k,
			c.counts[k].breaks,
			c.counts[k].tokensRewritten,
			totalRewritten > 0 ? (c.counts[k].tokensRewritten / totalRewritten) * 100 : 0,
		)).join('');

	return `
		<p class="eff-section-note">${escapeHtml(CACHE_INTRO)}</p>
		<div class="eff-verdict ${verdict.cls}"><span class="verdict-icon">⚡</span><span class="verdict-text">${escapeHtml(verdict.text)}</span></div>
		<div class="attr-summary">
			<div class="attr-stat"><div class="stat-label">Re-write factor</div><div class="stat-value">${factor.toFixed(2)}×</div><div class="stat-sub">1.00× is ideal · worst session ${c.worstRewriteFactor.toFixed(2)}×</div></div>
			<div class="attr-stat"><div class="stat-label">Cache breaks</div><div class="stat-value">${totalBreaks}</div><div class="stat-sub">${formatCompact(totalRewritten)} tokens re-written</div></div>
			<div class="attr-stat"><div class="stat-label">Sessions affected</div><div class="stat-value">${c.sessionsWithBreaks} of ${c.sessionsAnalyzed}</div><div class="stat-sub">${healthy} session${healthy === 1 ? '' : 's'} with no break at all</div></div>
		</div>
		<div class="cache-causes">${rows}</div>`;
}

/**
 * Explains why the active window(s) cannot form a comparison. The pickers only
 * ever offer eligible models, so reaching here means the window itself is too
 * narrow — not that the current pick is stale.
 */
function noEligibleModelsNote(d: EfficiencyViewData, eligible: ComparableModel[]): string {
	const now = payloadNow(d);
	if (modelState.mode === 'periods') {
		const a = resolveModelCompareWindow(modelState.windowA, now);
		const b = resolveModelCompareWindow(modelState.windowB, now);
		return localizeFormat('efficiency.models.noSharedModel', a.label, a.rangeLabel, b.label, b.rangeLabel);
	}
	const w = resolveModelCompareWindow(modelState.window, now);
	return eligible.length === 1
		? localizeFormat('efficiency.models.noPairInWindow', w.label, w.rangeLabel)
		: localizeFormat('efficiency.models.noModelsInWindow', w.label, w.rangeLabel);
}

function renderModelsTab(d: EfficiencyViewData, s: ScopedData): string {
	initModelState(d);
	const toolbar = renderScopeToolbar(d, s);
	if (d.modelDaily.length === 0) {
		return `<p class="eff-section-note">No per-model efficiency data yet. This tab needs sessions whose logs carry per-turn tool-call detail (Copilot CLI, Claude Code, Copilot Chat and similar). Keep working and check back in a few days.</p>`;
	}
	if (scopedModelDaily(d).length === 0) {
		return `
			${toolbar}
			<p class="eff-section-note">No per-model data for the selected editor. Pick another editor, or “All editors”.</p>`;
	}
	reconcileModelState(d);
	// Computed once per render and threaded through: the pickers, the empty-state
	// note and the comparison all describe the same eligible set.
	const eligible = eligibleModels(d);
	const controls = renderModelControls(d, eligible);
	const cmp = buildModelComparison(d);
	const metricOptions = MODEL_TREND_METRICS.map(m => ({ value: m.id, label: m.label }));
	// The drift chart is driven by the scope toolbar's range, not by the
	// comparison's own window pickers, so it stays useful even when the
	// head-to-head has no data — hiding it would throw away a valid chart
	// because an unrelated selection came up empty.
	const comparison = cmp
		? `
		<p class="eff-section-note">Head-to-head efficiency. Costs use <b>provider/API rates</b>, so this measures the models themselves rather than a billing plan — “model vendor” above is the model's own provider, not who bills for the call. Metrics whose sample was too small show as “—”. Session-level signals (duration, lines changed) are split across a session's models by token share.</p>
		<div class="model-sides">${sideSummary(cmp.a, 'A')}${sideSummary(cmp.b, 'B')}</div>
		${verdictHtml(cmp)}
		${comparisonTableHtml(cmp)}
		${caveatsHtml(cmp)}
		${taskMixHtml(cmp)}
		<h3>Shape of each side</h3>
		<p class="eff-section-note">Each axis is indexed so the better side scores 100. A larger shape is a better all-round profile; a spiky shape means the side wins on some dimensions and loses on others.</p>
		<div class="model-radar-wrap"><canvas id="model-radar"></canvas></div>`
		: `<p class="eff-section-note">${escapeHtml(scope.editor || scope.vendor ? noComparisonReason() : noEligibleModelsNote(d, eligible))}</p>`;
	return `
		${toolbar}
		${controls}
		${comparison}
		<h3>Drift over time</h3>
		<p class="eff-section-note">${escapeHtml(resolutionLabel(s.resolution))} values for each side's model over ${escapeHtml(s.range.label.toLowerCase())}, so a model getting better — or quietly getting worse — is visible. Gaps are buckets where the model was not used. The head-to-head comparison above keeps its own window pickers.</p>
		<div class="model-trend-controls"><label>Metric ${selectHtml('model-trend-metric', metricOptions, modelState.trendMetric)}</label></div>
		<div class="model-trend-wrap"><canvas id="model-trend"></canvas></div>`;
}

/** Why the head-to-head is unavailable, in the terms of whichever selection caused it. */
function noComparisonReason(): string {
	// Zero models and one model are different problems with different fixes, and
	// a vendor that exists across the payload can still be empty for the selected
	// editor — telling that user "only one model has data" would be wrong.
	if (modelState.mode === 'models' && !modelState.modelA) {
		return 'No model has data for this combination of editor and vendor. Clear one of the two filters, or pick a vendor this editor actually used.';
	}
	if (modelState.mode === 'models' && !modelState.modelB) {
		return 'Only one model has data in this scope, so there is nothing to compare it against. Widen the editor or vendor filter to compare two models — the drift chart below still works.';
	}
	const vendor = scope.vendor ? ` under vendor ${scope.vendor}` : '';
	return `No data for one of the two sides in the selected window${vendor}. Pick a different model, a wider window, or clear the vendor filter — the drift chart below still works.`;
}



// ── Chart drawing ──────────────────────────────────────────────────────

/**
 * Normalizes one metric onto a 0–100 radar axis where the better side scores
 * 100. Returns null when either side lacks the metric, so the axis is dropped.
 */
function radarScores(row: ModelComparisonRow): { a: number; b: number } | null {
	if (row.a === null || row.b === null) { return null; }
	const max = Math.max(row.a, row.b);
	const min = Math.min(row.a, row.b);
	if (max === 0) { return { a: 100, b: 100 }; }
	if (row.goodDirection === 'up') {
		return { a: (row.a / max) * 100, b: (row.b / max) * 100 };
	}
	if (row.a === 0 || row.b === 0) { return { a: row.a === min ? 100 : 0, b: row.b === min ? 100 : 0 }; }
	return { a: (min / row.a) * 100, b: (min / row.b) * 100 };
}

function radarAxes(cmp: ModelComparison): { row: ModelComparisonRow; scores: { a: number; b: number } }[] {
	const axes: { row: ModelComparisonRow; scores: { a: number; b: number } }[] = [];
	for (const id of RADAR_METRICS) {
		const row = cmp.rows.find(r => r.id === id);
		if (!row) { continue; }
		const scores = radarScores(row);
		if (scores) { axes.push({ row, scores }); }
	}
	return axes;
}

async function drawModelRadar(cmp: ModelComparison, generation: number): Promise<void> {
	await loadChartModule();
	const canvas = document.getElementById('model-radar') as HTMLCanvasElement | null;
	if (!Chart || !canvas || !isCurrentRender(generation)) { return; }
	const axes = radarAxes(cmp);
	if (axes.length < 3) {
		setHtml(canvas.parentElement as HTMLElement, `<p class="eff-section-note">Not enough shared metrics between the two sides to draw a shape.</p>`);
		return;
	}
	const fg = cssVar('--vscode-descriptionForeground', '#999');
	const grid = cssVar('--vscode-widget-border', 'rgba(128,128,128,0.2)');
	const colorA = cssVar('--vscode-charts-blue', '#60a5fa');
	const colorB = cssVar('--vscode-charts-orange', '#ff9f40');
	liveCharts.push(new Chart(canvas, {
		type: 'radar',
		data: {
			labels: axes.map(x => x.row.label),
			datasets: [
				{ label: `${cmp.a.displayName} · ${cmp.a.periodLabel}`, data: axes.map(x => x.scores.a), borderColor: colorA, backgroundColor: 'rgba(96,165,250,0.20)', pointBackgroundColor: colorA },
				{ label: `${cmp.b.displayName} · ${cmp.b.periodLabel}`, data: axes.map(x => x.scores.b), borderColor: colorB, backgroundColor: 'rgba(255,159,64,0.20)', pointBackgroundColor: colorB },
			],
		},
		options: {
			responsive: true,
			maintainAspectRatio: false,
			plugins: {
				legend: { position: 'bottom', labels: { color: fg, boxWidth: 14 } },
				tooltip: {
					callbacks: {
						label: (ctx: { datasetIndex: number; dataIndex: number; parsed: { r: number } }) => {
							const axis = axes[ctx.dataIndex];
							const raw = ctx.datasetIndex === 0 ? axis.row.a : axis.row.b;
							return `${fmtValue(raw, axis.row.unit)} (score ${Math.round(ctx.parsed.r)})`;
						},
					},
				},
			},
			scales: {
				r: {
					suggestedMin: 0, suggestedMax: 100,
					angleLines: { color: grid }, grid: { color: grid },
					pointLabels: { color: fg }, ticks: { display: false },
				},
			},
		},
	} as never));
}

/** The models whose weekly series belong on the trend chart for the current mode. */
function trendModels(): string[] {
	const wanted = modelState.mode === 'periods'
		? [modelState.modelA]
		: [modelState.modelA, modelState.modelB];
	return wanted.filter((m, i, arr) => m !== '' && arr.indexOf(m) === i);
}

async function drawModelTrend(d: EfficiencyViewData, s: ScopedData, generation: number): Promise<void> {
	await loadChartModule();
	const canvas = document.getElementById('model-trend') as HTMLCanvasElement | null;
	if (!Chart || !canvas || !isCurrentRender(generation)) { return; }
	const spec = MODEL_TREND_METRICS.find(m => m.id === modelState.trendMetric) ?? MODEL_TREND_METRICS[0];
	const models = trendModels();
	const colors = [cssVar('--vscode-charts-blue', '#60a5fa'), cssVar('--vscode-charts-orange', '#ff9f40')];
	const scopedDays = scopedModelDaily(d);
	const seriesList = models.map(m => buildModelBucketSeries(scopedDays, m, s.buckets));
	const labels = seriesList[0]?.map(p => p.label) ?? [];
	const fg = cssVar('--vscode-descriptionForeground', '#999');
	const grid = cssVar('--vscode-widget-border', 'rgba(128,128,128,0.2)');
	liveCharts.push(new Chart(canvas, {
		type: 'line',
		data: {
			labels,
			datasets: seriesList.map((series, i) => ({
				label: series.find(p => p.metrics)?.metrics?.displayName ?? models[i],
				data: series.map(p => (p.metrics ? spec.pick(p.metrics) : null)),
				borderColor: colors[i % colors.length],
				backgroundColor: colors[i % colors.length],
				spanGaps: true,
				tension: 0.25,
				pointRadius: 2.5,
			})),
		},
		options: {
			responsive: true,
			maintainAspectRatio: false,
			onClick: drillClickHandler(s),
			plugins: {
				legend: { position: 'bottom', labels: { color: fg, boxWidth: 14 } },
				tooltip: { callbacks: { label: (ctx: { parsed: { y: number | null } }) => ctx.parsed.y === null ? 'no data' : fmtValue(ctx.parsed.y, spec.unit) } },
			},
			scales: {
				x: { ticks: { color: fg, maxRotation: 45, autoSkip: true, maxTicksLimit: 8 }, grid: { display: false } },
				y: { beginAtZero: true, ticks: { color: fg, maxTicksLimit: 5 }, grid: { color: grid } },
			},
		},
	} as never));
}

async function drawModelCharts(d: EfficiencyViewData, s: ScopedData, generation: number): Promise<void> {
	const cmp = buildModelComparison(d);
	// Only the radar depends on the comparison; the drift chart is independent.
	if (cmp) {
		await drawModelRadar(cmp, generation);
		if (!isCurrentRender(generation)) { return; }
	}
	await drawModelTrend(d, s, generation);
}

function destroyCharts(): void {
	for (const c of liveCharts.splice(0)) { c.destroy(); }
}

/**
 * Bumped by every render. Each async draw captures the value it started under
 * and bails if a newer render has since begun.
 *
 * Without this, a draw that is still awaiting the dynamic Chart.js import when
 * the user changes scope or tab resumes *after* `destroyCharts()` has run, and
 * builds a chart from the stale payload onto the current canvas — a duplicate
 * or wrong-data chart that the next `destroyCharts()` cannot pre-empt.
 */
let renderGeneration = 0;

/** True while `generation` is still the render the page is showing. */
function isCurrentRender(generation: number): boolean {
	return generation === renderGeneration;
}

async function drawTrendCharts(s: ScopedData, generation: number): Promise<void> {
	await loadChartModule();
	if (!Chart || !isCurrentRender(generation)) { return; }
	const labels = s.points.map(p => p.label);
	const fg = cssVar('--vscode-descriptionForeground', '#999');
	const grid = cssVar('--vscode-widget-border', 'rgba(128,128,128,0.2)');
	const onClick = drillClickHandler(s);
	for (const spec of buildTrendSpecs(s)) {
		const canvas = document.getElementById(`trend-${spec.id}`) as HTMLCanvasElement | null;
		if (!canvas) { continue; }
		const good = cssVar('--vscode-charts-blue', '#60a5fa');
		liveCharts.push(new Chart(canvas, {
			type: 'line',
			data: {
				labels,
				datasets: [{
					label: spec.title.replace(/^\S+\s/, ''),
					data: spec.values as number[],
					borderColor: good,
					backgroundColor: good,
					spanGaps: true,
					tension: 0.25,
					pointRadius: 2.5,
				}],
			},
			options: {
				responsive: true,
				maintainAspectRatio: false,
				onClick,
				plugins: {
					legend: { display: false },
					tooltip: { callbacks: { label: (ctx: { parsed: { y: number | null } }) => ctx.parsed.y === null ? 'no data' : spec.format(ctx.parsed.y) } },
				},
				scales: {
					x: { ticks: { color: fg, maxRotation: 45, autoSkip: true, maxTicksLimit: 8 }, grid: { display: false } },
					y: { beginAtZero: true, ticks: { color: fg, maxTicksLimit: 5 }, grid: { color: grid } },
				},
			},
		}));
	}
}

/** Indexes a series to 100 at its first non-null value. */
function indexTo100(values: (number | null)[]): (number | null)[] {
	const base = values.find(v => v !== null && v !== 0);
	if (base === undefined || base === null) { return values.map(() => null); }
	return values.map(v => (v === null ? null : (v / base) * 100));
}

async function drawCombinedChart(s: ScopedData, generation: number): Promise<void> {
	await loadChartModule();
	if (!Chart || !isCurrentRender(generation)) { return; }
	const canvas = document.getElementById('combined-chart') as HTMLCanvasElement | null;
	if (!canvas) { return; }
	const labels = s.points.map(p => p.label);
	const fg = cssVar('--vscode-descriptionForeground', '#999');
	const grid = cssVar('--vscode-widget-border', 'rgba(128,128,128,0.2)');
	const lineDefs: { label: string; values: (number | null)[]; color: string; show: boolean }[] = [
		{ label: 'Cost per 1K lines (index)', values: indexTo100(s.points.map(p => p.costPerKloc)), color: cssVar('--vscode-charts-red', '#fb7185'), show: s.hasLoc },
		{ label: 'Tokens per session (index)', values: indexTo100(s.points.map(p => p.tokensPerSession)), color: cssVar('--vscode-charts-blue', '#60a5fa'), show: true },
		{ label: 'Turns per session (index)', values: indexTo100(s.points.map(p => p.turnsPerSession)), color: cssVar('--vscode-charts-purple', '#c37bff'), show: true },
		{ label: 'Active min per session (index)', values: indexTo100(s.points.map(p => p.activeMinutesPerSession)), color: cssVar('--vscode-charts-yellow', '#fbbf24'), show: s.hasDuration },
		{ label: 'Retry rate (index)', values: indexTo100(s.points.map(p => p.retryRate)), color: cssVar('--vscode-charts-orange', '#ff9f40'), show: s.hasRetry },
	];
	const datasets: object[] = lineDefs.filter(l => l.show).map(l => ({
		type: 'line' as const,
		label: l.label,
		data: l.values,
		borderColor: l.color,
		backgroundColor: l.color,
		spanGaps: true,
		tension: 0.25,
		pointRadius: 2,
		yAxisID: 'y',
	}));
	if (s.hasLoc) {
		datasets.push({
			type: 'bar' as const,
			label: 'Lines changed (output)',
			data: s.points.map(p => p.loc),
			backgroundColor: 'rgba(74, 222, 128, 0.35)',
			borderColor: cssVar('--vscode-charts-green', '#4ade80'),
			borderWidth: 1,
			yAxisID: 'yLoc',
		});
	}
	liveCharts.push(new Chart(canvas, {
		data: { labels, datasets } as never,
		options: {
			responsive: true,
			maintainAspectRatio: false,
			onClick: drillClickHandler(s),
			plugins: {
				legend: { position: 'bottom', labels: { color: fg, boxWidth: 14 } },
			},
			scales: {
				x: { ticks: { color: fg, maxRotation: 45, autoSkip: true }, grid: { display: false } },
				y: {
					position: 'left',
					title: { display: true, text: 'Index (first bucket = 100)', color: fg },
					ticks: { color: fg },
					grid: { color: grid },
				},
				...(s.hasLoc ? {
					yLoc: {
						position: 'right' as const,
						beginAtZero: true,
						title: { display: true, text: 'Lines changed', color: fg },
						ticks: { color: fg },
						grid: { display: false },
					},
				} : {}),
			},
		},
	} as never));
}

// ── Main render ────────────────────────────────────────────────────────

function renderActiveTab(d: EfficiencyViewData, s: ScopedData): string {
	switch (activeTab) {
		case 'trends': return renderTrendsTab(d, s);
		case 'skills': return renderSkillsTab(d, s);
		case 'deltas': return renderDeltasTab(d);
		case 'attribution': return renderAttributionTab(d);
		case 'cache': return renderCacheTab(d);
		case 'models': return renderModelsTab(d, s);
		case 'value': return renderValueTab(d);
		case 'combined': return renderCombinedTab(d, s);
	}
}

function render(): void {
	const root = document.getElementById('root');
	if (!root || !data) { return; }
	setCompactNumbers(data.compactNumbers !== false);
	const generation = ++renderGeneration;
	setFormatLocale(data.locale);
	destroyCharts();
	// Snap back to a real tab if the selected one is no longer shown — e.g. the
	// Prompt Cache tab after cache data disappeared — so the content and the
	// highlighted tab button never disagree.
	if (!visibleTabs(data).some(t => t.id === activeTab)) { activeTab = 'trends'; }
	const scoped = computeScopedData(data);
	const verdict = computeVerdict(data);
	setHtml(root, `
		<style>${themeStyles}</style><style>${dataTableStyles}</style>
		<style>${styles}</style>
		<div class="efficiency-root">
			<div class="button-row">${navButtonsHtml('btn-efficiency', !!data.backendConfigured)}</div>
			<div class="eff-header"><h1>⚡ Efficiency</h1></div>
			<p class="eff-subtitle">Are you working more efficiently with AI over time — and is it coming from using AI differently, cheaper models, or leaner sessions? Last updated ${escapeHtml(new Date(data.lastUpdated).toLocaleString())}.</p>
			<div class="eff-verdict ${verdict.cls}"><span class="verdict-icon">${verdict.icon}</span><span class="verdict-text">${verdict.text}</span></div>
			<div class="eff-tabs">
				${visibleTabs(data).map(t => `<button class="eff-tab ${t.id === activeTab ? 'active' : ''}" data-tab="${t.id}">${t.label}</button>`).join('')}
			</div>
			<div id="eff-tab-content">${renderActiveTab(data, scoped)}</div>
			<p class="caveat">⚠️ Honest caveats: costs are estimates from token counts and public rates; lines of code is a weak value proxy (refactors and generated boilerplate distort it); shorter sessions only count as efficiency when output (lines, applied blocks, PRs) holds or rises. Every trend here should be read alongside its value counterpart.</p>
		</div>
	`);
	wireEvents();
	if (activeTab === 'trends') { void drawTrendCharts(scoped, generation); }
	if (activeTab === 'skills' && scoped.hasSkills) { void drawSkillsChart(scoped, generation); }
	if (activeTab === 'combined') { void drawCombinedChart(scoped, generation); }
	if (activeTab === 'models') { void drawModelCharts(data, scoped, generation); }
}

/** Applies a scope transition: persist it and redraw, skipping a no-op change. */
function applyScope(next: EfficiencyScopeState): void {
	if (next === scope) { return; }
	scope = next;
	persistState();
	render();
}

/**
 * Wires the scope toolbar. Every path goes through {@link applyScope}, so the
 * persisted state and the rendered charts cannot disagree.
 */
function wireScopeToolbar(): void {
	document.querySelectorAll<HTMLButtonElement>('.scope-preset').forEach(btn => {
		btn.addEventListener('click', () => {
			const id = btn.dataset.range as EfficiencyRangeId | undefined;
			if (id) { applyScope(selectRange(scope, id)); }
		});
	});
	document.getElementById('eff-resolution')?.addEventListener('change', ev => {
		applyScope({ ...scope, resolution: (ev.target as HTMLSelectElement).value as EfficiencyScopeState['resolution'] });
	});
	document.getElementById('eff-editor')?.addEventListener('change', ev => {
		applyScope({ ...scope, editor: (ev.target as HTMLSelectElement).value });
	});
	document.getElementById('eff-vendor')?.addEventListener('change', ev => {
		applyScope({ ...scope, vendor: (ev.target as HTMLSelectElement).value });
	});
	document.getElementById('eff-drill-back')?.addEventListener('click', () => { applyScope(drillBack(scope)); });
	document.getElementById('eff-drill-pick')?.addEventListener('change', ev => {
		const key = (ev.target as HTMLSelectElement).value;
		if (!key || !data) { return; }
		const bucket = computeScopedData(data).buckets.find(b => b.key === key);
		if (bucket) { applyScope(drillInto(scope, bucket)); }
	});
}

/** Wires the Models tab selects; each change updates state and re-renders. */
function wireModelControls(): void {
	wireSearchableSelects();
	const bind = (id: string, apply: (value: string) => void): void => {
		document.getElementById(id)?.addEventListener('change', ev => {
			apply((ev.target as HTMLSelectElement).value);
			persistState();
			render();
		});
	};
	bind('model-mode', v => { modelState.mode = v as CompareMode; });
	bind('model-a', v => { modelState.modelA = v; });
	bind('model-b', v => { modelState.modelB = v; });
	bind('window', v => { modelState.window = v as ModelCompareWindowId; });
	bind('window-a', v => { modelState.windowA = v as ModelCompareWindowId; });
	bind('window-b', v => { modelState.windowB = v as ModelCompareWindowId; });
	bind('model-trend-metric', v => { modelState.trendMetric = v as ModelComparisonMetricId; });
}

function wireEvents(): void {
	document.querySelectorAll<HTMLButtonElement>('.eff-tab').forEach(btn => {
		btn.addEventListener('click', () => {
			activeTab = btn.dataset.tab as TabId;
			// Report the subview so the what's-new announcer can skip tabs the user
			// already found for themselves. Fire-and-forget.
			vscode.postMessage({ command: 'viewTabOpened', view: 'efficiency', tab: activeTab });
			persistState();
			render();
		});
	});
	wireScopeToolbar();
	wireModelControls();
	document.getElementById('btn-refresh')?.addEventListener('click', () => { vscode.postMessage({ command: 'refresh' }); });
	document.getElementById('btn-details')?.addEventListener('click', () => { vscode.postMessage({ command: 'showDetails' }); });
	document.getElementById('btn-chart')?.addEventListener('click', () => { vscode.postMessage({ command: 'showChart' }); });
	document.getElementById('btn-usage')?.addEventListener('click', () => { vscode.postMessage({ command: 'showUsageAnalysis' }); });
	document.getElementById('btn-maturity')?.addEventListener('click', () => { vscode.postMessage({ command: 'showMaturity' }); });
	document.getElementById('btn-environmental')?.addEventListener('click', () => { vscode.postMessage({ command: 'showEnvironmental' }); });
	document.getElementById('btn-diagnostics')?.addEventListener('click', () => { vscode.postMessage({ command: 'showDiagnostics' }); });
	document.getElementById('btn-dashboard')?.addEventListener('click', () => { vscode.postMessage({ command: 'showDashboard' }); });
	// Value tab empty state: reveal Usage Analysis already on the Repository PRs tab.
	document.getElementById('btn-open-repo-prs')?.addEventListener('click', () => { vscode.postMessage({ command: 'showUsageAnalysisRepoPrs' }); });
	wireExtensionPointButtons(vscode);
}

// ── Host messages ──────────────────────────────────────────────────────

/**
 * Applies a Value snapshot pushed by the host after Repository PR data loaded.
 *
 * Deliberately *not* a full re-render: the selected tab, the Models-tab controls and the live
 * Chart.js instances all live in this document and a re-render would tear them down. When Value
 * is the active tab only its fragment is replaced; otherwise the new state is simply retained
 * and picked up by the next tab switch.
 */
function applyValueSignals(next: EfficiencyViewData['value']): void {
	if (!data || valueSignalsEqual(data.value, next)) { return; }
	data = { ...data, value: next };
	if (activeTab !== 'value') { return; }
	// Before the first render there is no `#eff-tab-content` yet; `setHtml` no-ops on a missing
	// element, and the state assigned above is what that render then picks up.
	setHtml(document.getElementById('eff-tab-content'), renderValueTab(data));
}

registerMessageHandler<{ command?: string; value?: unknown }>((message) => {
	// Repository PR results are the only host push this view consumes. Cloud-agent task loads
	// publish their own message and must not touch Value: `aiPrs` counts bot-authored pull
	// requests, not cloud-agent tasks.
	if (message?.command !== 'valueSignalsUpdated' || !isValueSignalsPayload(message.value)) { return; }
	applyValueSignals(message.value);
});
notifyEfficiencyWebviewReady('listener-registered');

async function bootstrap(): Promise<void> {
	await import('@vscode-elements/elements/dist/vscode-button/index.js');
	if (!data) {
		const root = document.getElementById('root');
		if (root) { root.textContent = 'No data available.'; }
		return;
	}
	restorePersistedState();
	render();
	// The first announcement above necessarily happens before anything is rendered, so a replay
	// it triggered found no `#eff-tab-content` to update. Announce again now that there is one.
	notifyEfficiencyWebviewReady('content-rendered');
}

void bootstrap();
