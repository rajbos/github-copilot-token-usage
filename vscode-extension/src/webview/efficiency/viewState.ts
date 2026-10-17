// Efficiency view scope state — the time preset, resolution, drill-down stack
// and categorical filters shared by the tabs that are allowed to carry them.
//
// Kept out of main.ts (and free of DOM access) so the state transitions that
// decide what the charts show — drill in, drill back, switch preset, narrow to
// an editor — are unit-testable without a browser.
import {
	DEFAULT_EFFICIENCY_RANGE_ID,
	EFFICIENCY_RANGE_OPTIONS,
	availableResolutions,
	buildEfficiencyBuckets,
	drillRangeForBucket,
	resolveBucketResolution,
	resolveEfficiencyRange,
} from '../../../../src/efficiencyAnalysis';
import type {
	EfficiencyBucket,
	EfficiencyBucketResolution,
	EfficiencyRange,
	EfficiencyRangeId,
	EfficiencyResolution,
} from '../../../../src/efficiencyAnalysis';

/**
 * The user's current scope. Persisted verbatim through the webview state API,
 * so every field has to survive a round trip through JSON and an older shape
 * has to degrade to the defaults rather than to `undefined`.
 */
export interface EfficiencyScopeState {
	/** Selected time preset. Ignored while a drill-down is active. */
	rangeId: EfficiencyRangeId;
	/** Selected bucket width, or `auto` to derive it from the range span. */
	resolution: EfficiencyResolution;
	/** Editor display name to scope to; empty string means every editor. */
	editor: string;
	/** Underlying model vendor to narrow the Models tab to; empty means every vendor. */
	vendor: string;
	/** Drill-down stack, outermost first. The last entry is the active range. */
	drill: DrillStep[];
}

/**
 * One level of the drill-down stack.
 *
 * Carries the resolution that was selected *before* the drill so Back can put
 * it back. Without it an explicit choice is silently downgraded to `auto` on
 * the way out — pick Weekly on the 30-day range, drill into a week, press
 * Back, and the chart returns as Auto/daily rather than the Weekly the user
 * asked for.
 */
export interface DrillStep {
	range: EfficiencyRange;
	/** The resolution in effect before this drill level was entered. */
	from: EfficiencyResolution;
}

/** How deep a drill-down chain may go before the Back trail stops being useful. */
const MAX_DRILL_DEPTH = 4;

export function defaultScopeState(): EfficiencyScopeState {
	return { rangeId: DEFAULT_EFFICIENCY_RANGE_ID, resolution: 'auto', editor: '', vendor: '', drill: [] };
}

const RANGE_IDS = new Set<string>(EFFICIENCY_RANGE_OPTIONS.map(o => o.id));
const RESOLUTIONS = new Set<string>(['auto', 'daily', 'weekly', 'monthly']);

function isRange(value: unknown): value is EfficiencyRange {
	if (typeof value !== 'object' || value === null) { return false; }
	const r = value as Partial<EfficiencyRange>;
	return typeof r.startKey === 'string' && typeof r.endKey === 'string'
		&& typeof r.label === 'string' && r.startKey <= r.endKey;
}

/**
 * Accepts either a {@link DrillStep} or a bare range — the shape this stack
 * had before it carried the pre-drill resolution. A legacy entry restores to
 * `auto`, which is what it used to do anyway.
 */
function toDrillStep(value: unknown): DrillStep | null {
	if (isRange(value)) { return { range: { ...value, id: 'custom' }, from: 'auto' }; }
	if (typeof value !== 'object' || value === null) { return null; }
	const step = value as Partial<DrillStep>;
	if (!isRange(step.range)) { return null; }
	return {
		range: { ...step.range, id: 'custom' },
		from: typeof step.from === 'string' && RESOLUTIONS.has(step.from) ? step.from as EfficiencyResolution : 'auto',
	};
}

/**
 * Coerces a persisted (possibly older, possibly absent) state blob into a valid
 * scope. Anything unrecognised falls back to the default rather than being
 * carried forward, so a stale field can never select a range that no longer exists.
 */
export function normalizeScopeState(raw: unknown): EfficiencyScopeState {
	const base = defaultScopeState();
	if (typeof raw !== 'object' || raw === null) { return base; }
	const r = raw as Partial<EfficiencyScopeState>;
	return {
		rangeId: typeof r.rangeId === 'string' && RANGE_IDS.has(r.rangeId) ? r.rangeId as EfficiencyRangeId : base.rangeId,
		resolution: typeof r.resolution === 'string' && RESOLUTIONS.has(r.resolution) ? r.resolution as EfficiencyResolution : base.resolution,
		editor: typeof r.editor === 'string' ? r.editor : base.editor,
		vendor: typeof r.vendor === 'string' ? r.vendor : base.vendor,
		drill: Array.isArray(r.drill)
			? r.drill.map(toDrillStep).filter((d): d is DrillStep => d !== null).slice(0, MAX_DRILL_DEPTH)
			: base.drill,
	};
}

/** True while the view is looking at a drilled-into range rather than a preset. */
export function isDrilled(state: EfficiencyScopeState): boolean {
	return state.drill.length > 0;
}

/** The range currently being charted: the deepest drill-down, else the preset. */
export function activeRange(state: EfficiencyScopeState, now: Date): EfficiencyRange {
	return state.drill.at(-1)?.range ?? resolveEfficiencyRange(state.rangeId, now);
}

/** The concrete bucket width for the active range. */
export function activeResolution(state: EfficiencyScopeState, now: Date): EfficiencyBucketResolution {
	return resolveBucketResolution(state.resolution, activeRange(state, now));
}

/** The buckets currently on the x-axis. */
export function activeBuckets(state: EfficiencyScopeState, now: Date): EfficiencyBucket[] {
	const range = activeRange(state, now);
	return buildEfficiencyBuckets(range, resolveBucketResolution(state.resolution, range));
}

/** The resolutions the resolution picker may offer for the active range. */
export function activeResolutionOptions(state: EfficiencyScopeState, now: Date): EfficiencyBucketResolution[] {
	return availableResolutions(activeRange(state, now));
}

/** Only aggregated buckets contain days to drill into; a daily point is already the floor. */
export function canDrillInto(resolution: EfficiencyBucketResolution): boolean {
	return resolution !== 'daily';
}

/**
 * Pushes the days behind one bucket onto the drill stack and switches to daily
 * resolution. A daily bucket (or a stack at its depth limit) is returned
 * unchanged, so a click that cannot drill is inert rather than misleading.
 */
export function drillInto(state: EfficiencyScopeState, bucket: EfficiencyBucket): EfficiencyScopeState {
	if (!canDrillInto(bucket.resolution) || state.drill.length >= MAX_DRILL_DEPTH) { return state; }
	return {
		...state,
		resolution: 'daily',
		drill: [...state.drill, { range: drillRangeForBucket(bucket), from: state.resolution }],
	};
}

/**
 * Pops one level off the drill stack, restoring both the preceding range and
 * the resolution that was in effect before that level was entered — so an
 * explicit Weekly or Monthly choice survives a round trip through a drill-down.
 */
export function drillBack(state: EfficiencyScopeState): EfficiencyScopeState {
	const popped = state.drill.at(-1);
	if (!popped) { return state; }
	return { ...state, drill: state.drill.slice(0, -1), resolution: popped.from };
}

/** Selecting a preset leaves any drill-down behind — the preset *is* the new scope. */
export function selectRange(state: EfficiencyScopeState, rangeId: EfficiencyRangeId): EfficiencyScopeState {
	return { ...state, rangeId, resolution: 'auto', drill: [] };
}

/**
 * Localized pieces the scope announcement is assembled from. Passed in rather
 * than looked up here so this module stays free of the webview's localization
 * singleton (and stays unit-testable without it).
 */
export interface ScopeDescriptionLabels {
	/** Localized name of the active range, e.g. "12 weeks". */
	range: string;
	/** Localized bucket width, e.g. "Weekly". */
	resolution: string;
	/** Localized "all editors", used when no editor filter is active. */
	allEditors: string;
	/** Localized "all vendors", used when no vendor filter is active. */
	allVendors: string;
	/**
	 * Whether the vendor filter applies to the chart being announced. It is a
	 * Models-only filter, so including it elsewhere would describe a scope the
	 * chart does not actually have.
	 */
	includeVendor?: boolean;
}

/**
 * Human, screen-reader-friendly description of what is currently charted.
 *
 * Mirrors every control in the toolbar — including the Model vendor filter,
 * which otherwise would change the charts without announcing anything.
 */
export function describeScope(state: EfficiencyScopeState, labels: ScopeDescriptionLabels): string {
	const parts = [labels.range, labels.resolution, state.editor || labels.allEditors];
	if (labels.includeVendor !== false) { parts.push(state.vendor || labels.allVendors); }
	return parts.join(', ');
}

/** True when the range reaches further back than the behavioural session window. */
export function rangeExceedsBehaviorWindow(state: EfficiencyScopeState, now: Date, behaviorWindowDays: number | undefined): boolean {
	if (!behaviorWindowDays || behaviorWindowDays <= 0) { return false; }
	const cutoff = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (behaviorWindowDays - 1));
	const cutoffKey = `${cutoff.getFullYear()}-${String(cutoff.getMonth() + 1).padStart(2, '0')}-${String(cutoff.getDate()).padStart(2, '0')}`;
	return activeRange(state, now).startKey < cutoffKey;
}
