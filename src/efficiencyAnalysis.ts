import type { ApplyButtonUsage, DailyModelEfficiency, DailyTokenStats, ModelUsage, UsageAnalysisPeriod } from './types';
import type { CacheBreakagePeriodStats } from './cacheBreakage';
import { getModelDisplayName } from './webview/shared/modelUtils';
import { getModelBillingProvider } from './chartDataBuilder';
import { createEmptyDailyModelEfficiencyEntry, mergeDailyModelEfficiency } from './modelEfficiency';

/**
 * Efficiency analysis — pure computations behind the "Efficiency" view.
 *
 * Answers the question "am I working more efficiently over time, and why?"
 * by deriving ratio series (cost per line of code, tokens per session, …),
 * a month-over-month cost decomposition (volume vs. efficiency vs. model mix),
 * period delta cards, and outcome-shaped value signals.
 *
 * This module is intentionally pure (no VS Code API dependencies) so it can be
 * unit-tested with mocked data, following the chartDataBuilder.ts pattern.
 */

// ---------------------------------------------------------------------------
// Shared deps
// ---------------------------------------------------------------------------

export interface EfficiencyDeps {
	/** Estimate USD cost for the given model usage. */
	calculateEstimatedCost: (modelUsage: ModelUsage, pricingSource: 'provider' | 'copilot') => number;
	/** Current date/time. Defaults to `new Date()` when omitted; injectable for testing. */
	now?: Date;
}

function fmtKey(d: Date): string {
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function getMondayOfWeek(d: Date): Date {
	const copy = new Date(d);
	copy.setHours(0, 0, 0, 0);
	const day = copy.getDay();
	copy.setDate(copy.getDate() - (day === 0 ? 6 : day - 1));
	return copy;
}

function fmtWeekLabel(monday: Date): string {
	const sunday = new Date(monday);
	sunday.setDate(monday.getDate() + 6);
	if (monday.getMonth() === sunday.getMonth()) {
		return `${monday.toLocaleDateString('en-US', { month: 'short' })} ${monday.getDate()}–${sunday.getDate()}`;
	}
	return `${monday.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}–${sunday.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
}

// ---------------------------------------------------------------------------
// Weekly efficiency trends
// ---------------------------------------------------------------------------

/**
 * Per-session inputs for the session-derived weekly series (duration, retries,
 * apply rate). Each session is attributed entirely to the week of its last
 * activity day — sessions rarely span week boundaries, and the trend view
 * cares about direction, not day-perfect attribution.
 */
export interface EfficiencySessionInput {
	/** Local day key (YYYY-MM-DD) of the session's last activity. */
	dayKey: string;
	/** Net active duration in ms (excluding idle gaps); absent when not derivable. */
	activeDurationMs?: number;
	/** Edit turns across all models in this session (from modelEfficiency counters). */
	editTurns?: number;
	/** Edit retries across all models in this session. */
	retries?: number;
	/** Apply-button uses in this session. */
	applies?: number;
	/** Code blocks shown in this session. */
	codeBlocks?: number;
	/** User-request turns in this session (interactions). */
	interactions?: number;
	/** Estimated total tokens for this session. */
	totalTokens?: number;
	/** Agent-skill invocation counts by skill name (e.g. { graphify: 2 }); absent when none detected. */
	skillCalls?: { [skillName: string]: number };
	/**
	 * Editor/agent display name this session ran in (e.g. "VS Code", "Claude Code").
	 * Absent for sessions whose editor could not be determined — those are counted
	 * in the unfiltered totals but excluded from every editor-scoped view.
	 */
	editor?: string;
}

/**
 * One bucket of derived efficiency ratios. Ratio fields are null when the
 * denominator is 0 (or below a sample floor), never 0 — a gap is not a zero.
 */
export interface EfficiencyBucketPoint {
	/** First day of the bucket, YYYY-MM-DD. */
	bucketKey: string;
	/** Inclusive first day aggregated into this bucket. */
	startKey: string;
	/** Inclusive last day aggregated into this bucket. */
	endKey: string;
	/** Bucket width this point was aggregated at. */
	resolution: EfficiencyBucketResolution;
	/** Human label, e.g. "Jun 2–8". */
	label: string;
	sessions: number;
	tokens: number;
	/** Estimated cost in USD (Copilot AI-Credit pricing, matching the Chart view's cost series). */
	cost: number;
	/** Lines added + removed. */
	loc: number;
	interactions: number;
	tokensPerSession: number | null;
	/** Interactions (turns) per session. */
	turnsPerSession: number | null;
	/** Estimated cost per 1000 lines of code changed. */
	costPerKloc: number | null;
	locPerDollar: number | null;
	/** Average net active minutes per session (only sessions carrying duration data). */
	activeMinutesPerSession: number | null;
	/** Edit retries / edit turns across the bucket's sessions. */
	retryRate: number | null;
	/** Applied code blocks / shown code blocks across the bucket's sessions. */
	applyRate: number | null;
	/** Number of sessions that carried duration data (denominator of activeMinutesPerSession). */
	durationSessions: number;
	/** Total edit turns backing retryRate. */
	editTurns: number;
}

/**
 * A weekly point — {@link EfficiencyBucketPoint} plus the original `weekKey`
 * field the view and its fixtures have always read.
 */
export interface EfficiencyWeekPoint extends EfficiencyBucketPoint {
	/** Monday of the week, YYYY-MM-DD. Same value as `bucketKey`. */
	weekKey: string;
}

const DEFAULT_TREND_WEEKS = 12;
/** Minimum edit turns in a bucket before its retry rate is considered meaningful. */
const MIN_EDIT_TURNS_PER_WEEK = 5;

// ---------------------------------------------------------------------------
// Semantic zoom: time ranges, resolutions and buckets
// ---------------------------------------------------------------------------

/** Selectable time presets for the Efficiency charts. */
export type EfficiencyRangeId = 'last30d' | 'last12w' | 'last6m' | 'last1y';

/** Concrete bucket widths a series can be aggregated at. */
export type EfficiencyBucketResolution = 'daily' | 'weekly' | 'monthly';

/** Resolution as selected in the UI; `auto` derives the width from the range span. */
export type EfficiencyResolution = 'auto' | EfficiencyBucketResolution;

/** An inclusive day-key range, either a preset or a drill-down selection. */
export interface EfficiencyRange {
	/** The preset this came from, or `custom` after a drill-down. */
	id: EfficiencyRangeId | 'custom';
	/** Human label, e.g. "Last 12 weeks" or "Jun 2 – Jun 8". */
	label: string;
	/** Inclusive first day, YYYY-MM-DD. */
	startKey: string;
	/** Inclusive last day, YYYY-MM-DD. */
	endKey: string;
}

export const EFFICIENCY_RANGE_OPTIONS: { id: EfficiencyRangeId; label: string }[] = [
	{ id: 'last30d', label: '30 days' },
	{ id: 'last12w', label: '12 weeks' },
	{ id: 'last6m', label: '6 months' },
	{ id: 'last1y', label: '1 year' },
];

/** The preset the view opens on — the window the weekly trends have always used. */
export const DEFAULT_EFFICIENCY_RANGE_ID: EfficiencyRangeId = 'last12w';

/** Longest range the payload carries daily aggregates for. */
export const EFFICIENCY_MAX_RANGE_DAYS = 365;

function parseDayKey(key: string): Date {
	return new Date(`${key}T00:00:00`);
}

function startOfDay(d: Date): Date {
	return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function firstOfMonth(d: Date): Date {
	return new Date(d.getFullYear(), d.getMonth(), 1);
}

/** Inclusive day count spanned by a range (a single day spans 1). */
export function efficiencyRangeSpanDays(range: EfficiencyRange): number {
	const start = parseDayKey(range.startKey).getTime();
	const end = parseDayKey(range.endKey).getTime();
	if (Number.isNaN(start) || Number.isNaN(end) || end < start) { return 0; }
	return Math.round((end - start) / 86_400_000) + 1;
}

/**
 * Resolves a preset into concrete inclusive day bounds relative to `now`.
 *
 * Preset starts are snapped to the natural bucket boundary they will be read
 * at — Monday for the 12-week window, the first of the month for the 6-month
 * and 1-year windows — so every bucket except the current one is whole. The
 * current (partial) period is deliberately retained.
 */
export function resolveEfficiencyRange(id: EfficiencyRangeId, now: Date): EfficiencyRange {
	const end = startOfDay(now);
	const build = (label: string, start: Date): EfficiencyRange =>
		({ id, label, startKey: fmtKey(start), endKey: fmtKey(end) });
	switch (id) {
		case 'last30d': {
			const start = new Date(end);
			start.setDate(end.getDate() - 29);
			return build('Last 30 days', start);
		}
		case 'last12w': {
			const start = getMondayOfWeek(end);
			start.setDate(start.getDate() - (DEFAULT_TREND_WEEKS - 1) * 7);
			return build('Last 12 weeks', start);
		}
		case 'last6m':
			return build('Last 6 months', new Date(end.getFullYear(), end.getMonth() - 5, 1));
		case 'last1y':
			return build('Last 12 months', new Date(end.getFullYear(), end.getMonth() - 11, 1));
	}
}

/**
 * The day key `now` falls on — the last day every preset range reaches.
 *
 * A range whose `endKey` is below this one ends in the past, so none of its
 * buckets is still filling up.
 */
export function efficiencyTodayKey(now: Date): string {
	return fmtKey(startOfDay(now));
}

/**
 * Inclusive day span as prose: `Jul 15, 2026`, `Jul 1–15, 2026`,
 * `Jun 29 – Jul 5, 2026`, `Dec 29, 2025 – Jan 4, 2026`.
 */
function fmtSpanLabel(start: Date, end: Date): string {
	const startYear = start.getFullYear();
	const endYear = end.getFullYear();
	if (fmtKey(start) === fmtKey(end)) { return `${fmtDayLabel(start)}, ${endYear}`; }
	if (startYear !== endYear) { return `${fmtDayLabel(start)}, ${startYear} – ${fmtDayLabel(end)}, ${endYear}`; }
	if (start.getMonth() === end.getMonth()) {
		return `${start.toLocaleDateString('en-US', { month: 'short' })} ${start.getDate()}–${end.getDate()}, ${endYear}`;
	}
	return `${fmtDayLabel(start)} – ${fmtDayLabel(end)}, ${endYear}`;
}

/**
 * A drill-down range: the days contained in one weekly or monthly bucket.
 *
 * The label is built from the bucket's own bounds rather than reused from it.
 * A bucket's display label names the period it belongs to (`Jul 2026`,
 * `Jul 13–19`), which is not the same thing as the days it actually holds: the
 * trailing bucket of any range is clipped to today, so drilling into the
 * current month showed a chip reading `Jul 2026` over a chart of Jul 1 to Jul
 * 15 — and the range chip is the one place the exact span is disclosed.
 */
export function drillRangeForBucket(bucket: EfficiencyBucket): EfficiencyRange {
	return {
		id: 'custom',
		label: fmtSpanLabel(parseDayKey(bucket.startKey), parseDayKey(bucket.endKey)),
		startKey: bucket.startKey,
		endKey: bucket.endKey,
	};
}

/**
 * Resolutions that make sense for a range. Daily is withheld beyond four months
 * (hundreds of noisy points), weekly below a week, monthly below two months —
 * each would present a resolution the data cannot honestly carry.
 */
export function availableResolutions(range: EfficiencyRange): EfficiencyBucketResolution[] {
	const days = efficiencyRangeSpanDays(range);
	const out: EfficiencyBucketResolution[] = [];
	if (days <= 120) { out.push('daily'); }
	if (days >= 7) { out.push('weekly'); }
	if (days >= 60) { out.push('monthly'); }
	return out.length > 0 ? out : ['daily'];
}

/** Turns the UI's resolution choice into a concrete bucket width. */
export function resolveBucketResolution(resolution: EfficiencyResolution, range: EfficiencyRange): EfficiencyBucketResolution {
	if (resolution !== 'auto' && availableResolutions(range).includes(resolution)) { return resolution; }
	const days = efficiencyRangeSpanDays(range);
	if (days <= 31) { return 'daily'; }
	if (days <= 200) { return 'weekly'; }
	return 'monthly';
}

/** One bucket of the x-axis: its key, label and the inclusive days it covers. */
export interface EfficiencyBucket {
	/** First day of the bucket, YYYY-MM-DD — also the point's `bucketKey`. */
	key: string;
	label: string;
	startKey: string;
	endKey: string;
	resolution: EfficiencyBucketResolution;
}

function fmtDayLabel(d: Date): string {
	return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function fmtMonthLabel(d: Date): string {
	return d.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
}

/**
 * Lays out the buckets covering `range` at `resolution`.
 *
 * Weekly and monthly buckets snap *outward* to their natural boundary, so a
 * bucket is never a silent fragment of a week or month; the trailing bucket is
 * clipped to the range end, which is how the current (partial) period survives.
 */
export function buildEfficiencyBuckets(range: EfficiencyRange, resolution: EfficiencyBucketResolution): EfficiencyBucket[] {
	const rangeStart = parseDayKey(range.startKey);
	const rangeEnd = parseDayKey(range.endKey);
	if (Number.isNaN(rangeStart.getTime()) || Number.isNaN(rangeEnd.getTime()) || rangeEnd < rangeStart) { return []; }
	const buckets: EfficiencyBucket[] = [];
	const step = (d: Date): Date => {
		const next = new Date(d);
		if (resolution === 'daily') { next.setDate(d.getDate() + 1); }
		else if (resolution === 'weekly') { next.setDate(d.getDate() + 7); }
		else { next.setMonth(d.getMonth() + 1, 1); }
		return next;
	};
	let cursor = resolution === 'weekly' ? getMondayOfWeek(rangeStart)
		: resolution === 'monthly' ? firstOfMonth(rangeStart)
			: startOfDay(rangeStart);
	// A year of daily buckets is 365 iterations; the guard is against a malformed range.
	while (cursor <= rangeEnd && buckets.length <= EFFICIENCY_MAX_RANGE_DAYS + 1) {
		const next = step(cursor);
		const naturalEnd = new Date(next);
		naturalEnd.setDate(next.getDate() - 1);
		const end = naturalEnd > rangeEnd ? rangeEnd : naturalEnd;
		buckets.push({
			key: fmtKey(cursor),
			label: resolution === 'daily' ? fmtDayLabel(cursor) : resolution === 'weekly' ? fmtWeekLabel(cursor) : fmtMonthLabel(cursor),
			startKey: fmtKey(cursor),
			endKey: fmtKey(end),
			resolution,
		});
		cursor = next;
	}
	return buckets;
}

// ---------------------------------------------------------------------------
// Compact daily volume aggregates (the payload behind filtered series)
// ---------------------------------------------------------------------------

/** The volume numbers one day (or one day-and-editor) contributes to a bucket. */
export interface EfficiencyVolumeSlice {
	tokens: number;
	sessions: number;
	interactions: number;
	/** Lines added + removed. */
	loc: number;
	/** Estimated cost in USD on the Copilot AI-Credit basis. */
	cost: number;
}

/**
 * One day of volume aggregates, with an optional per-editor split.
 *
 * The day totals are the numbers the unfiltered series has always used and are
 * kept verbatim, so turning the editor filter off reproduces the original
 * values exactly rather than re-deriving them from the split.
 */
export interface EfficiencyDailyVolume extends EfficiencyVolumeSlice {
	/** Local day key, YYYY-MM-DD. */
	date: string;
	/** Per-editor split of the same day. Editors absent here are unattributed. */
	byEditor?: { [editor: string]: EfficiencyVolumeSlice };
}

function emptyVolumeSlice(): EfficiencyVolumeSlice {
	return { tokens: 0, sessions: 0, interactions: 0, loc: 0, cost: 0 };
}

function addVolumeSlice(target: EfficiencyVolumeSlice, source: EfficiencyVolumeSlice): void {
	target.tokens += source.tokens;
	target.sessions += source.sessions;
	target.interactions += source.interactions;
	target.loc += source.loc;
	target.cost += source.cost;
}

/**
 * Projects daily stats onto the compact volume shape shipped to the webview:
 * five numbers per day, plus the same five per editor when the day carries an
 * editor breakdown. No prompts, paths, titles or repository names.
 */
export function toEfficiencyDailyVolume(dailyStats: DailyTokenStats[], deps: EfficiencyDeps): EfficiencyDailyVolume[] {
	return dailyStats.map(day => {
		const entry: EfficiencyDailyVolume = {
			date: day.date,
			tokens: day.tokens,
			sessions: day.sessions,
			interactions: day.interactions,
			loc: (day.linesAdded ?? 0) + (day.linesRemoved ?? 0),
			cost: deps.calculateEstimatedCost(day.modelUsage, 'copilot'),
		};
		const editors = Object.keys(day.editorUsage ?? {});
		if (editors.length > 0) {
			const byEditor: { [editor: string]: EfficiencyVolumeSlice } = {};
			for (const editor of editors) {
				const usage = day.editorUsage[editor];
				byEditor[editor] = {
					tokens: usage.tokens,
					sessions: usage.sessions,
					interactions: usage.interactions ?? 0,
					loc: (usage.linesAdded ?? 0) + (usage.linesRemoved ?? 0),
					cost: deps.calculateEstimatedCost(day.editorModelUsage?.[editor] ?? {}, 'copilot'),
				};
			}
			entry.byEditor = byEditor;
		}
		return entry;
	});
}

/**
 * The label the editor detectors fall back to when a session's editor cannot
 * be identified from its path. It is a sentinel, not an editor.
 */
export const UNKNOWN_EDITOR = 'Unknown';

/**
 * Selectable editor display names present in the payload, most-used first.
 *
 * The `Unknown` sentinel is deliberately omitted: those sessions are counted in
 * the unfiltered totals and excluded from every editor scope, which is what the
 * toolbar tells the user. Offering it as a scope would make that promise false.
 */
export function listEfficiencyEditors(volume: EfficiencyDailyVolume[]): string[] {
	const tokensByEditor = new Map<string, number>();
	for (const day of volume) {
		for (const [editor, slice] of Object.entries(day.byEditor ?? {})) {
			if (editor === UNKNOWN_EDITOR) { continue; }
			tokensByEditor.set(editor, (tokensByEditor.get(editor) ?? 0) + slice.tokens);
		}
	}
	return Array.from(tokensByEditor.entries()).sort((a, b) => b[1] - a[1]).map(([editor]) => editor);
}

/** The sessions belonging to `editor`, or all of them when no editor is selected. */
export function filterSessionsByEditor(sessions: EfficiencySessionInput[], editor?: string): EfficiencySessionInput[] {
	return editor ? sessions.filter(s => s.editor === editor) : sessions;
}

// ---------------------------------------------------------------------------
// Bucketed efficiency series
// ---------------------------------------------------------------------------

type BucketAccum = {
	bucket: EfficiencyBucket;
	volume: EfficiencyVolumeSlice;
	activeDurationMs: number;
	durationSessions: number;
	editTurns: number;
	retries: number;
	applies: number;
	codeBlocks: number;
};

function emptyBucketAccum(bucket: EfficiencyBucket): BucketAccum {
	return { bucket, volume: emptyVolumeSlice(), activeDurationMs: 0, durationSessions: 0, editTurns: 0, retries: 0, applies: 0, codeBlocks: 0 };
}

function ratio(numerator: number, denominator: number): number | null {
	return denominator > 0 ? numerator / denominator : null;
}

function foldSessionIntoBucket(bucket: BucketAccum, s: EfficiencySessionInput): void {
	if (s.activeDurationMs !== undefined && s.activeDurationMs > 0) {
		bucket.activeDurationMs += s.activeDurationMs;
		bucket.durationSessions += 1;
	}
	bucket.editTurns += s.editTurns ?? 0;
	bucket.retries += s.retries ?? 0;
	bucket.applies += s.applies ?? 0;
	bucket.codeBlocks += s.codeBlocks ?? 0;
}

/**
 * Indexes buckets by day key so a day lands in its bucket in one lookup.
 * Buckets never overlap, so the mapping is unambiguous.
 */
function indexBucketsByDay(buckets: EfficiencyBucket[]): Map<string, number> {
	const index = new Map<string, number>();
	buckets.forEach((bucket, i) => {
		const cursor = parseDayKey(bucket.startKey);
		const end = parseDayKey(bucket.endKey);
		while (cursor <= end) {
			index.set(fmtKey(cursor), i);
			cursor.setDate(cursor.getDate() + 1);
		}
	});
	return index;
}

/** Options for {@link buildEfficiencyBucketSeries}. */
export interface EfficiencySeriesOptions {
	/** Restrict to one editor's sessions; omit for every editor. */
	editor?: string;
}

/**
 * Aggregates the compact daily volume and the per-session behavioural inputs
 * into one point per bucket.
 *
 * Volume ratios (tokens/session, turns/session, cost/KLOC) come from the daily
 * aggregates; behavioural ratios (active minutes, retry rate, apply rate) come
 * from the per-session inputs, each attributed entirely to the bucket
 * containing its last activity day.
 */
export function buildEfficiencyBucketSeries(
	volume: EfficiencyDailyVolume[],
	sessions: EfficiencySessionInput[],
	buckets: EfficiencyBucket[],
	options: EfficiencySeriesOptions = {},
): EfficiencyBucketPoint[] {
	const accums = buckets.map(emptyBucketAccum);
	const byDay = indexBucketsByDay(buckets);

	for (const day of volume) {
		const index = byDay.get(day.date);
		if (index === undefined) { continue; }
		const slice = options.editor ? day.byEditor?.[options.editor] : day;
		if (slice) { addVolumeSlice(accums[index].volume, slice); }
	}

	for (const s of filterSessionsByEditor(sessions, options.editor)) {
		const index = byDay.get(s.dayKey);
		if (index !== undefined) { foldSessionIntoBucket(accums[index], s); }
	}

	return accums.map(a => {
		const v = a.volume;
		return {
			bucketKey: a.bucket.key,
			startKey: a.bucket.startKey,
			endKey: a.bucket.endKey,
			resolution: a.bucket.resolution,
			label: a.bucket.label,
			sessions: v.sessions,
			tokens: v.tokens,
			cost: v.cost,
			loc: v.loc,
			interactions: v.interactions,
			tokensPerSession: ratio(v.tokens, v.sessions),
			turnsPerSession: ratio(v.interactions, v.sessions),
			costPerKloc: v.loc > 0 ? v.cost / (v.loc / 1000) : null,
			locPerDollar: v.cost > 0 ? v.loc / v.cost : null,
			activeMinutesPerSession: a.durationSessions > 0 ? (a.activeDurationMs / a.durationSessions) / 60_000 : null,
			retryRate: a.editTurns >= MIN_EDIT_TURNS_PER_WEEK ? a.retries / a.editTurns : null,
			applyRate: ratio(a.applies, a.codeBlocks),
			durationSessions: a.durationSessions,
			editTurns: a.editTurns,
		};
	});
}

/**
 * Builds the weekly efficiency-ratio series for the trailing `weeksBack` weeks
 * (including the current, partial week) — the view's default, unfiltered scope.
 *
 * A thin wrapper over {@link buildEfficiencyBucketSeries} so the host-computed
 * default and the webview's filtered recomputation can never drift apart.
 */
export function buildEfficiencyTrends(
	dailyStats: DailyTokenStats[],
	sessions: EfficiencySessionInput[],
	deps: EfficiencyDeps,
	weeksBack: number = DEFAULT_TREND_WEEKS,
): EfficiencyWeekPoint[] {
	const now = deps.now ?? new Date();
	const start = getMondayOfWeek(now);
	start.setDate(start.getDate() - (weeksBack - 1) * 7);
	const range: EfficiencyRange = { id: 'custom', label: `Last ${weeksBack} weeks`, startKey: fmtKey(start), endKey: fmtKey(startOfDay(now)) };
	const buckets = buildEfficiencyBuckets(range, 'weekly');
	return buildEfficiencyBucketSeries(toEfficiencyDailyVolume(dailyStats, deps), sessions, buckets)
		.map(point => ({ ...point, weekKey: point.bucketKey }));
}

// ---------------------------------------------------------------------------
// Cost attribution (volume vs. efficiency vs. model mix)
// ---------------------------------------------------------------------------

/** Aggregate figures for one side (period) of the cost decomposition. */
export interface CostAttributionSide {
	cost: number;
	sessions: number;
	tokens: number;
	tokensPerSession: number;
	/** Blended price: USD per million tokens across the period's model mix. */
	dollarsPerMTokens: number;
}

/**
 * One model's share of tokens in the two compared periods.
 *
 * Deliberately canonical: the raw `model` id and numeric shares only. Friendly
 * names are resolved in the webview by `getModelDisplayName()`, which reads the
 * pricing JSON from `window.__MODEL_PRICING__` — a global that does not exist in
 * the extension host, so resolving here would serialize raw ids anyway.
 */
export interface ModelMixShift {
	/** Canonical model identifier, exactly as it appears in the session data. */
	model: string;
	/** Share of period tokens, 0..1. */
	prevShare: number;
	curShare: number;
	deltaShare: number;
	prevTokens: number;
	curTokens: number;
}

/**
 * Decomposition of the cost change between two periods, using
 * cost = sessions × tokens/session × $/token and sequential (prior-base)
 * substitution so the three effects sum exactly to deltaCost:
 *
 * - volumeEffect:     you used AI more or less (session count changed)
 * - efficiencyEffect: each session consumed more or fewer tokens
 * - mixEffect:        the blended $/token changed (cheaper/pricier model mix)
 */
export interface CostAttribution {
	prev: CostAttributionSide;
	cur: CostAttributionSide;
	deltaCost: number;
	volumeEffect: number;
	efficiencyEffect: number;
	mixEffect: number;
	/** Largest model-mix movements (by |deltaShare|), largest first. */
	modelShifts: ModelMixShift[];
}

function sideFromDays(days: DailyTokenStats[], deps: EfficiencyDeps): { side: CostAttributionSide; tokensByModel: Map<string, number> } | null {
	let sessions = 0;
	let tokens = 0;
	let cost = 0;
	const tokensByModel = new Map<string, number>();
	for (const day of days) {
		sessions += day.sessions;
		tokens += day.tokens;
		cost += deps.calculateEstimatedCost(day.modelUsage, 'copilot');
		for (const [model, usage] of Object.entries(day.modelUsage)) {
			tokensByModel.set(model, (tokensByModel.get(model) ?? 0) + usage.inputTokens + usage.outputTokens);
		}
	}
	if (sessions === 0 || tokens === 0) { return null; }
	return {
		side: {
			cost,
			sessions,
			tokens,
			tokensPerSession: tokens / sessions,
			dollarsPerMTokens: (cost / tokens) * 1_000_000,
		},
		tokensByModel,
	};
}

function buildModelShifts(prev: Map<string, number>, cur: Map<string, number>, prevTotal: number, curTotal: number): ModelMixShift[] {
	const models = new Set<string>([...prev.keys(), ...cur.keys()]);
	const shifts: ModelMixShift[] = [];
	for (const model of models) {
		const prevTokens = prev.get(model) ?? 0;
		const curTokens = cur.get(model) ?? 0;
		const prevShare = prevTotal > 0 ? prevTokens / prevTotal : 0;
		const curShare = curTotal > 0 ? curTokens / curTotal : 0;
		const deltaShare = curShare - prevShare;
		// Ignore sub-half-point movements — they are noise in the mix story.
		if (Math.abs(deltaShare) < 0.005) { continue; }
		shifts.push({ model, prevShare, curShare, deltaShare, prevTokens, curTokens });
	}
	return shifts.sort((a, b) => Math.abs(b.deltaShare) - Math.abs(a.deltaShare)).slice(0, 6);
}

/**
 * Decomposes the cost change from `prevDays` to `curDays` (each an array of
 * daily stats for one period) into volume, efficiency, and model-mix effects.
 * Returns null when either period has no sessions or no tokens — a
 * decomposition against an empty baseline has no meaning.
 */
export function computeCostAttribution(
	prevDays: DailyTokenStats[],
	curDays: DailyTokenStats[],
	deps: EfficiencyDeps,
): CostAttribution | null {
	const prev = sideFromDays(prevDays, deps);
	const cur = sideFromDays(curDays, deps);
	if (!prev || !cur) { return null; }

	const s0 = prev.side.sessions, s1 = cur.side.sessions;
	const t0 = prev.side.tokensPerSession, t1 = cur.side.tokensPerSession;
	// $/token (not per million) so the products below are dollars.
	const p0 = prev.side.cost / prev.side.tokens;
	const p1 = cur.side.cost / cur.side.tokens;

	const volumeEffect = (s1 - s0) * t0 * p0;
	const efficiencyEffect = s1 * (t1 - t0) * p0;
	const mixEffect = s1 * t1 * (p1 - p0);

	return {
		prev: prev.side,
		cur: cur.side,
		deltaCost: cur.side.cost - prev.side.cost,
		volumeEffect,
		efficiencyEffect,
		mixEffect,
		modelShifts: buildModelShifts(prev.tokensByModel, cur.tokensByModel, prev.side.tokens, cur.side.tokens),
	};
}

/** Inclusive calendar-day boundaries for the two adjacent 30-day attribution windows. */
export function getTrailingWindowBoundaries(now: Date): { prevStart: Date; prevEnd: Date; curStart: Date; curEnd: Date } {
	const dayAtOffset = (offset: number): Date => new Date(now.getFullYear(), now.getMonth(), now.getDate() - offset);
	return {
		prevStart: dayAtOffset(59),
		prevEnd: dayAtOffset(30),
		curStart: dayAtOffset(29),
		curEnd: dayAtOffset(0),
	};
}

/** Splits daily stats into [previous 30 days, trailing 30 days] windows relative to `now`. */
export function splitTrailingWindows(dailyStats: DailyTokenStats[], now: Date): { prevDays: DailyTokenStats[]; curDays: DailyTokenStats[] } {
	const boundaries = getTrailingWindowBoundaries(now);
	const curStartKey = fmtKey(boundaries.curStart);
	const prevStartKey = fmtKey(boundaries.prevStart);
	const nowKey = fmtKey(boundaries.curEnd);
	const prevDays: DailyTokenStats[] = [];
	const curDays: DailyTokenStats[] = [];
	for (const day of dailyStats) {
		if (day.date >= curStartKey && day.date <= nowKey) { curDays.push(day); }
		else if (day.date >= prevStartKey && day.date < curStartKey) { prevDays.push(day); }
	}
	return { prevDays, curDays };
}

// ---------------------------------------------------------------------------
// Period delta cards
// ---------------------------------------------------------------------------

export type DeltaUnit = 'ratio' | 'percent' | 'minutes' | 'tokens' | 'currency';

/** One month-over-month delta card. `prev`/`cur` are null when the metric is unavailable in that period. */
export interface EfficiencyDelta {
	id: string;
	label: string;
	/** What the metric means and why its direction matters. */
	description: string;
	prev: number | null;
	cur: number | null;
	unit: DeltaUnit;
	/** Which direction of change counts as an improvement. */
	goodDirection: 'up' | 'down';
	/** Percent change (cur vs prev); null when either side is unavailable or prev is 0. */
	deltaPct: number | null;
	/** True when the change moved in `goodDirection`; null when not computable. */
	improved: boolean | null;
}

/** Minimum sessions in a period before its ratios are trusted for a delta card. */
const MIN_SESSIONS_FOR_DELTAS = 5;
/** Minimum edit turns before a period's retry rate is meaningful. */
const MIN_EDIT_TURNS_FOR_DELTAS = 10;
/** Minimum tier-classified requests before the low-cost share is meaningful. */
const MIN_COST_BUCKET_REQUESTS = 10;

function periodRetryRate(p: UsageAnalysisPeriod): number | null {
	let retries = 0;
	let editTurns = 0;
	for (const c of Object.values(p.modelEfficiency ?? {})) {
		retries += c.retries;
		editTurns += c.editTurns;
	}
	return editTurns >= MIN_EDIT_TURNS_FOR_DELTAS ? retries / editTurns : null;
}

function periodLowCostShare(p: UsageAnalysisPeriod): number | null {
	const ms = p.modelSwitching;
	const total = ms.lowCostRequests + ms.mediumCostRequests + ms.highCostRequests;
	return total >= MIN_COST_BUCKET_REQUESTS ? ms.lowCostRequests / total : null;
}

function periodActiveMinutesPerSession(p: UsageAnalysisPeriod): number | null {
	const d = p.sessionDuration;
	if (!d || p.sessions === 0 || d.activeDurationMs <= 0) { return null; }
	return (d.activeDurationMs / p.sessions) / 60_000;
}

function periodApplyRate(p: UsageAnalysisPeriod): number | null {
	const a = p.applyUsage;
	return a && a.totalCodeBlocks > 0 ? a.totalApplies / a.totalCodeBlocks : null;
}

function periodTurnsPerSession(p: UsageAnalysisPeriod): number | null {
	const c = p.conversationPatterns;
	return c && p.sessions > 0 ? c.avgTurnsPerSession : null;
}

function makeDelta(
	id: string,
	label: string,
	description: string,
	prev: number | null,
	cur: number | null,
	unit: DeltaUnit,
	goodDirection: 'up' | 'down',
): EfficiencyDelta {
	let deltaPct: number | null = null;
	let improved: boolean | null = null;
	if (prev !== null && cur !== null && prev !== 0) {
		deltaPct = ((cur - prev) / Math.abs(prev)) * 100;
		if (Math.abs(deltaPct) >= 0.05) {
			improved = goodDirection === 'down' ? cur < prev : cur > prev;
		}
	}
	return { id, label, description, prev, cur, unit, goodDirection, deltaPct, improved };
}

/** Aggregate token/cost totals for one period, used by the volume delta cards. */
export interface PeriodVolumeTotals {
	tokens: number;
	sessions: number;
	estimatedCost: number;
}

/**
 * Builds the month-over-month delta cards from two usage-analysis periods
 * (typically current month-to-date vs. the previous full month). All cards are
 * per-session ratios or shares, so a partial current month compares fairly
 * against a full previous month. Periods with fewer than
 * {@link MIN_SESSIONS_FOR_DELTAS} sessions contribute null (card shows as
 * "not enough data").
 */
export function computeEfficiencyDeltas(
	cur: UsageAnalysisPeriod,
	prev: UsageAnalysisPeriod,
	curTotals?: PeriodVolumeTotals,
	prevTotals?: PeriodVolumeTotals,
): EfficiencyDelta[] {
	const curOk = cur.sessions >= MIN_SESSIONS_FOR_DELTAS;
	const prevOk = prev.sessions >= MIN_SESSIONS_FOR_DELTAS;
	const gate = <T>(ok: boolean, v: T | null): T | null => (ok ? v : null);

	const deltas: EfficiencyDelta[] = [
		makeDelta(
			'turns-per-session', 'Turns per session',
			'Average user requests per session. Fewer turns for the same work means less back-and-forth to get a usable result.',
			gate(prevOk, periodTurnsPerSession(prev)), gate(curOk, periodTurnsPerSession(cur)), 'ratio', 'down',
		),
		makeDelta(
			'active-minutes-per-session', 'Active minutes per session',
			'Net working time per session, excluding idle gaps. Shorter sessions at the same output means tasks complete faster.',
			gate(prevOk, periodActiveMinutesPerSession(prev)), gate(curOk, periodActiveMinutesPerSession(cur)), 'minutes', 'down',
		),
		makeDelta(
			'retry-rate', 'Edit retry rate',
			'Share of edit turns where the model had to retry a failed edit. Lower means edits land on the first attempt more often.',
			gate(prevOk, periodRetryRate(prev)), gate(curOk, periodRetryRate(cur)), 'percent', 'down',
		),
		makeDelta(
			'low-cost-share', 'Low-cost model share',
			'Share of requests served by low-cost models. A rising share with steady output means the same work at lower rates.',
			gate(prevOk, periodLowCostShare(prev)), gate(curOk, periodLowCostShare(cur)), 'percent', 'up',
		),
		makeDelta(
			'apply-rate', 'Apply rate',
			'Share of suggested code blocks you actually applied. Higher means more of what the AI produces is directly usable.',
			gate(prevOk, periodApplyRate(prev)), gate(curOk, periodApplyRate(cur)), 'percent', 'up',
		),
	];

	if (curTotals && prevTotals) {
		deltas.push(
			makeDelta(
				'tokens-per-session', 'Tokens per session',
				'Average tokens consumed per session. Falling token use at the same output means leaner prompts and less rework.',
				prevTotals.sessions >= MIN_SESSIONS_FOR_DELTAS ? prevTotals.tokens / prevTotals.sessions : null,
				curTotals.sessions >= MIN_SESSIONS_FOR_DELTAS ? curTotals.tokens / curTotals.sessions : null,
				'tokens', 'down',
			),
			makeDelta(
				'cost-per-session', 'Cost per session',
				'Estimated cost per session. The bottom line of model choice and session efficiency combined.',
				prevTotals.sessions >= MIN_SESSIONS_FOR_DELTAS ? prevTotals.estimatedCost / prevTotals.sessions : null,
				curTotals.sessions >= MIN_SESSIONS_FOR_DELTAS ? curTotals.estimatedCost / curTotals.sessions : null,
				'currency', 'down',
			),
		);
	}

	return deltas;
}

// ---------------------------------------------------------------------------
// Value signals
// ---------------------------------------------------------------------------

/** Inputs for {@link computeValueSignals}. PR counts are null when PR stats were never loaded. */
export interface ValueSignalsInput {
	/**
	 * PRs authored by the signed-in user in the PR window. This is the shipped-work
	 * signal for the common workflow where AI is driven locally and the human opens
	 * the PR — unlike {@link aiPrs}, which only counts bot-opened PRs.
	 */
	userPrs: number | null;
	/** Subset of `userPrs` that has been merged. */
	mergedPrs: number | null;
	/** PRs opened by AI bot accounts (cloud agents such as the Copilot coding agent). */
	aiPrs: number | null;
	/** ISO start of the PR window. */
	prsSince: string | null;
	/** Estimated cost of the analysis period in USD. */
	periodCost: number;
	applyUsage?: ApplyButtonUsage;
	/** Lines added + removed over the analysis period. */
	linesChanged: number;
	now?: Date;
}

/**
 * Outcome-shaped value metrics: what did the AI usage produce, not just what
 * it consumed. LOC is a weak proxy; merged pull requests and applied code
 * blocks are closer to shipped value.
 */
export interface ValueSignals {
	/** PRs you authored in the window; null when PR stats were never loaded. */
	userPrs: number | null;
	/** PRs you authored that were merged. */
	mergedPrs: number | null;
	/** PRs opened by AI bot accounts (cloud agent delegation); 0 is normal when AI is driven locally. */
	aiPrs: number | null;
	/** ISO start of the PR window (when PR stats are available). */
	prsSince: string | null;
	/** Merged PRs per week over the PR window, falling back to authored PRs when merge data is absent. */
	prsPerWeek: number | null;
	/** Estimated period cost divided by merged PRs; null when either side is unavailable/zero. */
	costPerMergedPr: number | null;
	/** Applied / shown code blocks over the analysis period. */
	applyRate: number | null;
	appliedBlocks: number;
	totalBlocks: number;
	/** Lines of code changed per dollar over the analysis period. */
	locPerDollar: number | null;
	linesChanged: number;
	periodCost: number;
}

/**
 * Assembles the value signals for a period. PR counts come from the GitHub PR
 * stats when the user has loaded them (Usage Analysis → Repository PRs); pass
 * null when unavailable so the view can hint at how to enable them.
 */
/** PRs per week over the window starting at `since`, or null when either input is missing. */
function prsPerWeekRate(prs: number | null, since: string | null, now: Date): number | null {
	if (prs === null || !since) { return null; }
	const weeks = Math.max(1 / 7, (now.getTime() - new Date(since).getTime()) / (7 * 24 * 3600 * 1000));
	return prs / weeks;
}

export function computeValueSignals(input: ValueSignalsInput): ValueSignals {
	const { userPrs, mergedPrs, aiPrs, prsSince, periodCost, applyUsage, linesChanged } = input;
	const current = input.now ?? new Date();
	// Merged PRs are the truer "shipped" count; fall back to authored when a
	// provider or fixture carries no merge state.
	const prsPerWeek = prsPerWeekRate(mergedPrs ?? userPrs, prsSince, current);
	return {
		userPrs,
		mergedPrs,
		aiPrs,
		prsSince,
		prsPerWeek,
		costPerMergedPr: mergedPrs !== null && mergedPrs > 0 && periodCost > 0 ? periodCost / mergedPrs : null,
		applyRate: applyUsage && applyUsage.totalCodeBlocks > 0 ? applyUsage.totalApplies / applyUsage.totalCodeBlocks : null,
		appliedBlocks: applyUsage?.totalApplies ?? 0,
		totalBlocks: applyUsage?.totalCodeBlocks ?? 0,
		locPerDollar: periodCost > 0 && linesChanged > 0 ? linesChanged / periodCost : null,
		linesChanged,
		periodCost,
	};
}

/**
 * True when two Value snapshots say the same thing, so re-rendering would be a no-op.
 *
 * Both sides of the Efficiency panel's Value update check this: the extension host to avoid
 * posting churn on every Repository PRs refresh, the webview to leave the rendered DOM (and the
 * user's scroll position) alone when a replayed or duplicate update carries nothing new.
 */
export function valueSignalsEqual(a: ValueSignals | undefined, b: ValueSignals | undefined): boolean {
	if (!a || !b) { return a === b; }
	const keys: (keyof ValueSignals)[] = [
		'userPrs', 'mergedPrs', 'aiPrs', 'prsSince', 'prsPerWeek', 'costPerMergedPr',
		'applyRate', 'appliedBlocks', 'totalBlocks', 'locPerDollar', 'linesChanged', 'periodCost',
	];
	return keys.every((key) => a[key] === b[key]);
}

// ---------------------------------------------------------------------------
// Skill / tool usage trends
// ---------------------------------------------------------------------------

/** One bucket of agent-skill usage. */
export interface SkillUsageBucketPoint {
	/** First day of the bucket, YYYY-MM-DD. */
	bucketKey: string;
	/** Human label, e.g. "Jun 2–8". */
	label: string;
	/** Total skill invocations across the bucket's sessions. */
	totalCalls: number;
	/** Sessions that invoked at least one skill. */
	skillSessions: number;
	/** All sessions observed in the bucket (denominator of `skillShare`). */
	trackedSessions: number;
	/** Share of sessions using any skill, 0..1; null when no sessions tracked. */
	skillShare: number | null;
	/** Invocation counts by skill name for this bucket. */
	byName: { [skillName: string]: number };
}

/** A weekly skill-usage point — {@link SkillUsageBucketPoint} plus the original `weekKey`. */
export interface SkillUsageWeekPoint extends SkillUsageBucketPoint {
	/** Monday of the week, YYYY-MM-DD. Same value as `bucketKey`. */
	weekKey: string;
}

/** Bucketed skill-usage series plus the overall top skills across the window. */
export interface SkillUsageTrends {
	weeks: SkillUsageWeekPoint[];
	/** Skill names ordered by total invocations across the window, largest first. */
	topSkills: string[];
	/** Total invocations across the whole window. */
	totalCalls: number;
}

/**
 * Builds the agent-skill usage series (graphify, custom slash-command skills, …)
 * over the given buckets. Sessions are attributed to the bucket containing their
 * last activity day, matching {@link buildEfficiencyBucketSeries}.
 */
export function buildSkillUsageSeries(
	sessions: EfficiencySessionInput[],
	buckets: EfficiencyBucket[],
	options: EfficiencySeriesOptions = {},
): SkillUsageTrends {
	type SkillAccum = { bucket: EfficiencyBucket; totalCalls: number; skillSessions: number; trackedSessions: number; byName: { [name: string]: number } };
	const accums: SkillAccum[] = buckets.map(bucket => ({ bucket, totalCalls: 0, skillSessions: 0, trackedSessions: 0, byName: {} }));
	const byDay = indexBucketsByDay(buckets);

	const totalsByName = new Map<string, number>();
	for (const s of filterSessionsByEditor(sessions, options.editor)) {
		const index = byDay.get(s.dayKey);
		if (index === undefined) { continue; }
		const acc = accums[index];
		acc.trackedSessions += 1;
		const entries = Object.entries(s.skillCalls ?? {}).filter(([, count]) => count > 0);
		if (entries.length === 0) { continue; }
		acc.skillSessions += 1;
		for (const [name, count] of entries) {
			acc.totalCalls += count;
			acc.byName[name] = (acc.byName[name] ?? 0) + count;
			totalsByName.set(name, (totalsByName.get(name) ?? 0) + count);
		}
	}

	return {
		weeks: accums.map(a => ({
			bucketKey: a.bucket.key,
			weekKey: a.bucket.key,
			label: a.bucket.label,
			totalCalls: a.totalCalls,
			skillSessions: a.skillSessions,
			trackedSessions: a.trackedSessions,
			skillShare: a.trackedSessions > 0 ? a.skillSessions / a.trackedSessions : null,
			byName: a.byName,
		})),
		topSkills: Array.from(totalsByName.entries()).sort((a, b) => b[1] - a[1]).map(([name]) => name),
		totalCalls: Array.from(totalsByName.values()).reduce((a, b) => a + b, 0),
	};
}

/**
 * Builds the weekly agent-skill usage series for the trailing `weeksBack` weeks
 * — the view's default, unfiltered scope.
 */
export function buildSkillUsageTrends(
	sessions: EfficiencySessionInput[],
	deps: EfficiencyDeps,
	weeksBack: number = DEFAULT_TREND_WEEKS,
): SkillUsageTrends {
	const now = deps.now ?? new Date();
	const start = getMondayOfWeek(now);
	start.setDate(start.getDate() - (weeksBack - 1) * 7);
	const range: EfficiencyRange = { id: 'custom', label: `Last ${weeksBack} weeks`, startKey: fmtKey(start), endKey: fmtKey(startOfDay(now)) };
	return buildSkillUsageSeries(sessions, buildEfficiencyBuckets(range, 'weekly'));
}

// ---------------------------------------------------------------------------
// Skill impact (with vs. without cohort comparison)
// ---------------------------------------------------------------------------

/** Aggregate efficiency metrics for one cohort of sessions. Null when the metric had no data. */
export interface SkillCohortMetrics {
	sessions: number;
	avgTurns: number | null;
	avgTokens: number | null;
	avgActiveMinutes: number | null;
	/** Aggregate retries / edit turns; null below {@link MIN_EDIT_TURNS_FOR_DELTAS} edit turns. */
	retryRate: number | null;
}

/** One metric compared across the with/without cohorts. */
export interface SkillImpactMetric {
	id: 'turns' | 'tokens' | 'active-minutes' | 'retry-rate';
	label: string;
	withSkill: number | null;
	withoutSkill: number | null;
	/** Percent difference of the with-cohort vs. the without-cohort; null when either side is missing. */
	deltaPct: number | null;
	/** Which direction of difference reads as favourable for the skill. */
	goodDirection: 'up' | 'down';
	/** True when the with-cohort is favourable; null when not computable or within noise (<5%). */
	favorable: boolean | null;
}

/** Impact summary for one skill: sessions using it vs. sessions not using it. */
export interface SkillImpact {
	skill: string;
	totalCalls: number;
	withSkill: SkillCohortMetrics;
	withoutSkill: SkillCohortMetrics;
	metrics: SkillImpactMetric[];
}

/** Minimum sessions in the with-cohort before an impact comparison is shown. */
const MIN_SKILL_COHORT_SESSIONS = 5;
/** Differences below this share are treated as noise, not signal. */
const IMPACT_NOISE_THRESHOLD = 0.05;

function cohortMetrics(sessions: EfficiencySessionInput[]): SkillCohortMetrics {
	let turnSessions = 0, turns = 0;
	let tokenSessions = 0, tokens = 0;
	let durationSessions = 0, durationMs = 0;
	let editTurns = 0, retries = 0;
	for (const s of sessions) {
		if (s.interactions !== undefined && s.interactions > 0) { turnSessions += 1; turns += s.interactions; }
		if (s.totalTokens !== undefined && s.totalTokens > 0) { tokenSessions += 1; tokens += s.totalTokens; }
		if (s.activeDurationMs !== undefined && s.activeDurationMs > 0) { durationSessions += 1; durationMs += s.activeDurationMs; }
		editTurns += s.editTurns ?? 0;
		retries += s.retries ?? 0;
	}
	return {
		sessions: sessions.length,
		avgTurns: turnSessions > 0 ? turns / turnSessions : null,
		avgTokens: tokenSessions > 0 ? tokens / tokenSessions : null,
		avgActiveMinutes: durationSessions > 0 ? (durationMs / durationSessions) / 60_000 : null,
		retryRate: editTurns >= MIN_EDIT_TURNS_FOR_DELTAS ? retries / editTurns : null,
	};
}

function impactMetric(
	id: SkillImpactMetric['id'],
	label: string,
	withSkill: number | null,
	withoutSkill: number | null,
	goodDirection: 'up' | 'down',
): SkillImpactMetric {
	let deltaPct: number | null = null;
	let favorable: boolean | null = null;
	if (withSkill !== null && withoutSkill !== null && withoutSkill !== 0) {
		deltaPct = ((withSkill - withoutSkill) / Math.abs(withoutSkill)) * 100;
		if (Math.abs(deltaPct) >= IMPACT_NOISE_THRESHOLD * 100) {
			favorable = goodDirection === 'down' ? withSkill < withoutSkill : withSkill > withoutSkill;
		}
	}
	return { id, label, withSkill, withoutSkill, deltaPct, goodDirection, favorable };
}

/**
 * For every skill with at least {@link MIN_SKILL_COHORT_SESSIONS} sessions,
 * compares the sessions that used it against the sessions that did not, on
 * turns, tokens, active minutes, and retry rate.
 *
 * This is a correlation, not causation: sessions where a skill is invoked may
 * simply be different kinds of work. The view must present it as such.
 */
export function computeSkillImpact(sessions: EfficiencySessionInput[]): SkillImpact[] {
	const bySkill = new Map<string, { withSkill: EfficiencySessionInput[]; totalCalls: number }>();
	for (const s of sessions) {
		for (const [name, count] of Object.entries(s.skillCalls ?? {})) {
			if (count <= 0) { continue; }
			const entry = bySkill.get(name) ?? { withSkill: [], totalCalls: 0 };
			entry.withSkill.push(s);
			entry.totalCalls += count;
			bySkill.set(name, entry);
		}
	}

	const impacts: SkillImpact[] = [];
	for (const [skill, entry] of bySkill) {
		if (entry.withSkill.length < MIN_SKILL_COHORT_SESSIONS) { continue; }
		const withSet = new Set(entry.withSkill);
		const withoutSessions = sessions.filter(s => !withSet.has(s));
		if (withoutSessions.length < MIN_SKILL_COHORT_SESSIONS) { continue; }
		const withM = cohortMetrics(entry.withSkill);
		const withoutM = cohortMetrics(withoutSessions);
		impacts.push({
			skill,
			totalCalls: entry.totalCalls,
			withSkill: withM,
			withoutSkill: withoutM,
			metrics: [
				impactMetric('turns', 'Turns per session', withM.avgTurns, withoutM.avgTurns, 'down'),
				impactMetric('tokens', 'Tokens per session', withM.avgTokens, withoutM.avgTokens, 'down'),
				impactMetric('active-minutes', 'Active minutes per session', withM.avgActiveMinutes, withoutM.avgActiveMinutes, 'down'),
				impactMetric('retry-rate', 'Edit retry rate', withM.retryRate, withoutM.retryRate, 'down'),
			],
		});
	}
	return impacts.sort((a, b) => b.withSkill.sessions - a.withSkill.sessions);
}

// ---------------------------------------------------------------------------
// Model comparison
// ---------------------------------------------------------------------------

/**
 * One model's efficiency profile over a time window, derived from the daily
 * per-model aggregates. Costs use provider/API rates (the basis carried by
 * `ModelEfficiencyCounters.cost`), so "cheaper per edit turn" is a statement
 * about the model, not about a Copilot billing plan.
 *
 * Every ratio is null when its denominator is 0 or below the sample floor.
 */
export interface ModelPeriodMetrics {
	model: string;
	displayName: string;
	/** Human label for the window this was computed over, e.g. "Aug 2026". */
	periodLabel: string;
	sessions: number;
	/** Token-weighted session equivalents — the denominator for per-session ratios. */
	sessionShare: number;
	calls: number;
	editTurns: number;
	tokens: number;
	cost: number;
	loc: number;
	costPerEditTurn: number | null;
	costPerSession: number | null;
	costPerKloc: number | null;
	dollarsPerMTokens: number | null;
	tokensPerEditTurn: number | null;
	tokensPerSession: number | null;
	oneShotRate: number | null;
	retryRate: number | null;
	selfCorrectionRate: number | null;
	cacheReadShare: number | null;
	activeMinutesPerSession: number | null;
	applyRate: number | null;
	/** Share of this model's tokens per task category (0..1), for confounder context. */
	taskMix: { [category: string]: number };
	/** True when the window carries enough sessions for the ratios to be trusted. */
	sampleSufficient: boolean;
	/** True when the window carries enough edit turns for the edit-based rates. */
	editSampleSufficient: boolean;
}

/** Minimum session equivalents before a model's period ratios are trusted. */
const MIN_SESSION_SHARE_FOR_COMPARE = 5;
/** Minimum edit turns before a model's edit-based rates are trusted. */
const MIN_EDIT_TURNS_FOR_COMPARE = 10;
/** Task-mix divergence (in share points) above which a confounder caveat is raised. */
const TASK_MIX_DIVERGENCE_THRESHOLD = 0.2;
/** Differences below this percentage are treated as noise, not signal. */
const COMPARE_NOISE_PCT = 10;

/**
 * The minimal slice of a day needed for model comparisons. `DailyTokenStats`
 * satisfies this shape, so the webview can be handed a trimmed payload instead
 * of the full daily stats array.
 */
export interface ModelDailyInput {
	/** Local day key, YYYY-MM-DD. */
	date: string;
	modelEfficiency?: DailyModelEfficiency;
	taskCategoryUsage?: { [category: string]: { tokens: number; sessions: number } };
	/**
	 * Editor/agent this slice belongs to. The payload carries one row per
	 * (day, editor) pair, so merging every row reproduces the unsplit day
	 * exactly while an editor-scoped view can take just its own rows. Absent on
	 * rows whose editor could not be determined.
	 */
	editor?: string;
}

/**
 * Splits one day's per-model efficiency counters into one row per editor, so
 * the Models tab can scope to an editor.
 *
 * Merging every row of a day reproduces the unsplit day exactly: the counters
 * are written per editor from the same sessions, and the day's task-category
 * tokens are apportioned by each editor's share of the day's model tokens, so
 * the shares sum back to 1. Returns an empty array when the day carries no
 * editor split, leaving the caller to ship the unsplit row.
 */
export function splitModelDayByEditor(day: DailyTokenStats): ModelDailyInput[] {
	const byEditor = day.editorModelEfficiency;
	if (!byEditor || Object.keys(byEditor).length === 0) { return []; }
	const editorTokens = new Map<string, number>();
	let dayTokens = 0;
	for (const [editor, efficiency] of Object.entries(byEditor)) {
		const tokens = Object.values(efficiency).reduce((sum, e) => sum + e.inputTokens + e.outputTokens, 0);
		editorTokens.set(editor, tokens);
		dayTokens += tokens;
	}
	const rows: ModelDailyInput[] = [];
	for (const [editor, efficiency] of Object.entries(byEditor)) {
		if (Object.keys(efficiency).length === 0) { continue; }
		const share = dayTokens > 0 ? (editorTokens.get(editor) ?? 0) / dayTokens : 0;
		const row: ModelDailyInput = { date: day.date, modelEfficiency: efficiency, editor };
		if (day.taskCategoryUsage && share > 0) {
			const scaled: { [category: string]: { tokens: number; sessions: number } } = {};
			for (const [category, usage] of Object.entries(day.taskCategoryUsage)) {
				scaled[category] = { tokens: usage.tokens * share, sessions: usage.sessions * share };
			}
			row.taskCategoryUsage = scaled;
		}
		rows.push(row);
	}
	return rows;
}

/**
 * Narrows day rows to one editor. Rows without an editor are unattributed
 * usage and are deliberately excluded rather than silently folded into
 * whichever editor is selected.
 */
export function selectModelDaysForEditor(days: ModelDailyInput[], editor?: string): ModelDailyInput[] {
	return editor ? days.filter(d => d.editor === editor) : days;
}

/**
 * Underlying model vendors present in `days`, alphabetically.
 *
 * This is the model's own provider ({@link getModelBillingProvider}), not
 * whoever bills for the call — a Claude model used through Copilot is an
 * Anthropic model on a GitHub Copilot bill, and conflating the two would make
 * the filter lie. The one place the two blur is a BYOK custom endpoint, which
 * that helper labels with the user's own provider group (e.g.
 * "Mistral (Custom)") because the call is served by, and billed by, that
 * endpoint; the filter surfaces that label verbatim rather than guessing at
 * the model behind it.
 */
export function listModelVendors(days: ModelDailyInput[]): string[] {
	const vendors = new Set<string>();
	for (const day of days) {
		for (const model of Object.keys(day.modelEfficiency ?? {})) { vendors.add(getModelBillingProvider(model)); }
	}
	return Array.from(vendors).sort((a, b) => a.localeCompare(b));
}

/** Keeps only the models served by `vendor`; no vendor means no narrowing. */
export function filterModelsByVendor<T extends { model: string }>(models: T[], vendor?: string): T[] {
	return vendor ? models.filter(m => getModelBillingProvider(m.model) === vendor) : models;
}

/**
 * Distributes a day's task-category tokens across the models active that day,
 * weighted by each model's share of the day's tokens. Task categories are
 * classified per session, not per model, so this is the closest attribution
 * available — it is used for context only, never to score a model.
 */
function accumulateTaskMix(day: ModelDailyInput, model: string, target: Map<string, number>): void {
	const categories = day.taskCategoryUsage;
	if (!categories || !day.modelEfficiency) { return; }
	const dayModelTokens = Object.values(day.modelEfficiency).reduce((sum, e) => sum + e.inputTokens + e.outputTokens, 0);
	if (dayModelTokens === 0) { return; }
	const entry = day.modelEfficiency[model];
	if (!entry) { return; }
	const share = (entry.inputTokens + entry.outputTokens) / dayModelTokens;
	for (const [category, usage] of Object.entries(categories)) {
		target.set(category, (target.get(category) ?? 0) + usage.tokens * share);
	}
}

function normalizeMix(raw: Map<string, number>): { [category: string]: number } {
	const total = [...raw.values()].reduce((a, b) => a + b, 0);
	const mix: { [category: string]: number } = {};
	if (total === 0) { return mix; }
	for (const [category, value] of raw) { mix[category] = value / total; }
	return mix;
}

/** Safe division: null when the denominator is zero or the gate is closed. */
function gatedRatio(numerator: number, denominator: number, gate = true): number | null {
	return gate && denominator > 0 ? numerator / denominator : null;
}

/**
 * Aggregates one model's daily efficiency entries across `days` into a single
 * comparable profile. Returns null when the model never appears in the window.
 */
export function computeModelPeriodMetrics(days: ModelDailyInput[], model: string, periodLabel: string): ModelPeriodMetrics | null {
	const totals = createEmptyDailyModelEfficiencyEntry();
	const taskMixRaw = new Map<string, number>();
	let seen = false;
	for (const day of days) {
		const entry = day.modelEfficiency?.[model];
		if (!entry) { continue; }
		seen = true;
		mergeDailyModelEfficiency({ [model]: totals }, { [model]: entry });
		accumulateTaskMix(day, model, taskMixRaw);
	}
	if (!seen) { return null; }

	const tokens = totals.inputTokens + totals.outputTokens;
	const loc = totals.linesAdded + totals.linesRemoved;
	const enoughSessions = totals.sessionShare >= MIN_SESSION_SHARE_FOR_COMPARE;
	const enoughEdits = totals.editTurns >= MIN_EDIT_TURNS_FOR_COMPARE;

	return {
		model,
		displayName: getModelDisplayName(model),
		periodLabel,
		sessions: totals.sessions,
		sessionShare: totals.sessionShare,
		calls: totals.calls,
		editTurns: totals.editTurns,
		tokens,
		cost: totals.cost,
		loc,
		costPerEditTurn: gatedRatio(totals.cost, totals.editTurns, enoughEdits),
		costPerSession: gatedRatio(totals.cost, totals.sessionShare, enoughSessions),
		costPerKloc: gatedRatio(totals.cost * 1000, loc, enoughSessions),
		dollarsPerMTokens: gatedRatio(totals.cost * 1_000_000, tokens),
		tokensPerEditTurn: gatedRatio(tokens, totals.editTurns, enoughEdits),
		tokensPerSession: gatedRatio(tokens, totals.sessionShare, enoughSessions),
		oneShotRate: gatedRatio(totals.oneShotEditTurns, totals.editTurns, enoughEdits),
		retryRate: gatedRatio(totals.retries, totals.editTurns, enoughEdits),
		selfCorrectionRate: gatedRatio(totals.selfCorrections, totals.editTurns, enoughEdits),
		// Capped at 1.0: some providers report cachedReadTokens > inputTokens.
		cacheReadShare: capShare(gatedRatio(totals.cachedReadTokens, totals.inputTokens)),
		activeMinutesPerSession: gatedRatio(totals.activeDurationMs / 60_000, totals.durationSessionShare),
		applyRate: gatedRatio(totals.applies, totals.codeBlocks),
		taskMix: normalizeMix(taskMixRaw),
		sampleSufficient: enoughSessions,
		editSampleSufficient: enoughEdits,
	};
}

function capShare(value: number | null): number | null {
	return value === null ? null : Math.min(1, value);
}

/** A model that appears in the window, with the volume that decides whether it is worth comparing. */
export interface ComparableModel {
	model: string;
	displayName: string;
	sessions: number;
	sessionShare: number;
	editTurns: number;
	tokens: number;
	cost: number;
	/** True when the model clears the sample floor and can be compared meaningfully. */
	sampleSufficient: boolean;
}

/**
 * Lists the models present in `days`, most-used first, so the comparison UI can
 * populate its pickers and default to the two most-used comparable models.
 */
export function listComparableModels(days: ModelDailyInput[]): ComparableModel[] {
	const totals: DailyModelEfficiency = {};
	for (const day of days) { mergeDailyModelEfficiency(totals, day.modelEfficiency); }
	return Object.entries(totals)
		.map(([model, e]) => ({
			model,
			displayName: getModelDisplayName(model),
			sessions: e.sessions,
			sessionShare: e.sessionShare,
			editTurns: e.editTurns,
			tokens: e.inputTokens + e.outputTokens,
			cost: e.cost,
			sampleSufficient: e.sessionShare >= MIN_SESSION_SHARE_FOR_COMPARE,
		}))
		.sort((a, b) => b.tokens - a.tokens);
}

/** One bucket of one model's efficiency metrics, for the per-model drift chart. */
export interface ModelBucketPoint {
	/** First day of the bucket, YYYY-MM-DD. */
	bucketKey: string;
	label: string;
	metrics: ModelPeriodMetrics | null;
}

/** A weekly drift point — {@link ModelBucketPoint} plus the original `weekKey`. */
export interface ModelWeekPoint extends ModelBucketPoint {
	/** Monday of the week, YYYY-MM-DD. Same value as `bucketKey`. */
	weekKey: string;
}

/**
 * Builds a bucketed series of `model`'s efficiency profile, so a model's own
 * drift over time is visible. Buckets where the model was not used carry a null
 * profile (rendered as a gap, not a zero).
 */
export function buildModelBucketSeries(
	days: ModelDailyInput[],
	model: string,
	buckets: EfficiencyBucket[],
): ModelBucketPoint[] {
	const grouped: ModelDailyInput[][] = buckets.map(() => []);
	const byDay = indexBucketsByDay(buckets);
	for (const day of days) {
		const index = byDay.get(day.date);
		if (index !== undefined) { grouped[index].push(day); }
	}
	return buckets.map((bucket, i) => ({
		bucketKey: bucket.key,
		label: bucket.label,
		metrics: computeModelPeriodMetrics(grouped[i], model, bucket.label),
	}));
}

/**
 * Builds the weekly drift series across the default trend window — a thin
 * wrapper over {@link buildModelBucketSeries}.
 */
export function buildModelWeeklySeries(
	days: ModelDailyInput[],
	model: string,
	now: Date,
	weeks = DEFAULT_TREND_WEEKS,
): ModelWeekPoint[] {
	const start = getMondayOfWeek(now);
	start.setDate(start.getDate() - (weeks - 1) * 7);
	const range: EfficiencyRange = { id: 'custom', label: `Last ${weeks} weeks`, startKey: fmtKey(start), endKey: fmtKey(startOfDay(now)) };
	return buildModelBucketSeries(days, model, buildEfficiencyBuckets(range, 'weekly'))
		.map(point => ({ ...point, weekKey: point.bucketKey }));
}

/** Selectable comparison windows, shared by the extension and the Models tab. */
export type ModelCompareWindowId = 'last30' | 'prev30' | 'last90' | 'thisMonth' | 'lastMonth';

/** A resolved date window: inclusive `startKey`..`endKey` day keys plus a human label. */
export interface ModelCompareWindow {
	id: ModelCompareWindowId;
	label: string;
	/** Short, concrete date span (e.g. "Aug 8 – Sep 6") so windows with similar names are distinguishable. */
	rangeLabel: string;
	startKey: string;
	endKey: string;
}

/** Formats a short "Mon D – Mon D[, YYYY]" span; adds the year to the start when it differs from the end's year. */
function formatDateRangeLabel(startKey: string, endKey: string): string {
	const start = new Date(`${startKey}T00:00:00`);
	const end = new Date(`${endKey}T00:00:00`);
	const sameYear = start.getFullYear() === end.getFullYear();
	const startOpts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) };
	const startFmt = start.toLocaleDateString('en-US', startOpts);
	const endFmt = end.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
	return `${startFmt} – ${endFmt}`;
}

/** Resolves a window id into concrete date bounds relative to `now`. */
export function resolveModelCompareWindow(id: ModelCompareWindowId, now: Date): ModelCompareWindow {
	const monthLabel = (d: Date): string => d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
	const dayOffset = (days: number): Date => new Date(now.getFullYear(), now.getMonth(), now.getDate() - days);
	const build = (label: string, startKey: string, endKey: string): ModelCompareWindow =>
		({ id, label, rangeLabel: formatDateRangeLabel(startKey, endKey), startKey, endKey });
	switch (id) {
		case 'last30':
			return build('Last 30 days', fmtKey(dayOffset(29)), fmtKey(now));
		case 'prev30':
			return build('Previous 30 days', fmtKey(dayOffset(59)), fmtKey(dayOffset(30)));
		case 'last90':
			return build('Last 90 days', fmtKey(dayOffset(89)), fmtKey(now));
		case 'thisMonth': {
			const start = new Date(now.getFullYear(), now.getMonth(), 1);
			return build(monthLabel(start), fmtKey(start), fmtKey(now));
		}
		case 'lastMonth': {
			const start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
			const end = new Date(now.getFullYear(), now.getMonth(), 0);
			return build(monthLabel(start), fmtKey(start), fmtKey(end));
		}
	}
}

/** Filters `days` down to the resolved window (inclusive on both ends). */
export function selectDaysInWindow(days: ModelDailyInput[], window: ModelCompareWindow): ModelDailyInput[] {
	return days.filter(d => d.date >= window.startKey && d.date <= window.endKey);
}

/** Whether any per-model efficiency data exists inside the resolved window — used to hide/disable empty windows in the picker. */
export function windowHasModelData(days: ModelDailyInput[], window: ModelCompareWindow): boolean {
	return selectDaysInWindow(days, window).some(d => d.modelEfficiency && Object.keys(d.modelEfficiency).length > 0);
}

/** Which two sides the Models tab is comparing. */
export type ModelCompareMode = 'models' | 'periods';

/** The Models tab's current picker state, in the shape the webview keeps it. */
export interface ModelCompareSelection {
	mode: ModelCompareMode;
	modelA: string;
	modelB: string;
	/** The shared window, used by `models` mode. */
	window: ModelCompareWindowId;
	/** The baseline window, used by `periods` mode. */
	windowA: ModelCompareWindowId;
	/** The compared-with window, used by `periods` mode. */
	windowB: ModelCompareWindowId;
}

/** The models that appear at all in `days` — key presence only, no aggregation. */
function modelsPresent(days: ModelDailyInput[]): Set<string> {
	const seen = new Set<string>();
	for (const day of days) {
		for (const model of Object.keys(day.modelEfficiency ?? {})) { seen.add(model); }
	}
	return seen;
}

/** Deduplicates day entries by identity, so overlapping windows are not counted twice. */
function uniqueDays(...groups: ModelDailyInput[][]): ModelDailyInput[] {
	return [...new Set(groups.flat())];
}

/**
 * Lists the models the *active* window(s) can actually compare, so the pickers
 * never offer a selection that is guaranteed to render an empty side.
 *
 * In `models` mode that is every model present in the shared window. In
 * `periods` mode it is only the models present in *both* windows — a model used
 * in just one of them has no second side to compare against. Volume ordering
 * and the sample floor are computed over the same window(s), never over the
 * full payload, so "low sample" reflects what is being compared.
 */
export function listEligibleModels(
	days: ModelDailyInput[],
	selection: ModelCompareSelection,
	now: Date,
	vendor?: string,
): ComparableModel[] {
	return filterModelsByVendor(listWindowEligibleModels(days, selection, now), vendor);
}

function listWindowEligibleModels(
	days: ModelDailyInput[],
	selection: ModelCompareSelection,
	now: Date,
): ComparableModel[] {
	if (selection.mode === 'periods') {
		const daysA = selectDaysInWindow(days, resolveModelCompareWindow(selection.windowA, now));
		const daysB = selectDaysInWindow(days, resolveModelCompareWindow(selection.windowB, now));
		// Membership only needs the model keys, so it is a cheap scan — the full
		// per-model aggregate is computed once, over the union.
		const inA = modelsPresent(daysA);
		const inB = modelsPresent(daysB);
		return listComparableModels(uniqueDays(daysA, daysB)).filter(m => inA.has(m.model) && inB.has(m.model));
	}
	return listComparableModels(selectDaysInWindow(days, resolveModelCompareWindow(selection.window, now)));
}

/**
 * Brings a stale selection back to something the active window(s) can compare.
 *
 * Selections survive mode and window changes, so a model picked from a wider
 * slice of history — or a Model B that is still valid but now equals Model A —
 * would otherwise leave a side permanently empty. A model the user picked that
 * is still eligible is always kept, even when it is below the sample floor;
 * only *defaults* prefer the models that clear it. Returns empty model ids when
 * the window(s) hold nothing eligible, which is the caller's cue to render its
 * empty state. `vendor` narrows the eligible set to one model provider.
 */
export function reconcileModelSelection(
	days: ModelDailyInput[],
	selection: ModelCompareSelection,
	now: Date,
	vendor?: string,
): ModelCompareSelection {
	const eligible = listEligibleModels(days, selection, now, vendor);
	const eligibleIds = new Set(eligible.map(m => m.model));
	// Defaults come off this pool: every model that clears the sample floor
	// first, then the rest, each group still most-used first. A stable partition
	// rather than an either/or, so a high-token low-sample model cannot outrank a
	// model with a trustworthy sample when only one side can be filled from it.
	const pool = [...eligible.filter(m => m.sampleSufficient), ...eligible.filter(m => !m.sampleSufficient)];
	const firstOther = (exclude?: string): string => pool.find(m => m.model !== exclude)?.model ?? '';

	// Replacing Model A must not eat an eligible Model B: that would move the
	// user's pick onto the other side and then displace it. Take the next model
	// instead, and only fall back to B when there is nothing else in the window.
	const heldB = selection.mode === 'models' && eligibleIds.has(selection.modelB) ? selection.modelB : undefined;
	const modelA = eligibleIds.has(selection.modelA) ? selection.modelA : (firstOther(heldB) || firstOther());
	// `periods` mode compares one model against itself across two windows, so it
	// leaves Model B untouched — it is reconciled again on the way back to `models`.
	if (selection.mode === 'periods') { return { ...selection, modelA }; }
	const keepB = eligibleIds.has(selection.modelB) && selection.modelB !== modelA;
	return { ...selection, modelA, modelB: keepB ? selection.modelB : firstOther(modelA) };
}

export type ModelComparisonMetricId =	| 'cost-per-edit-turn' | 'cost-per-session' | 'cost-per-kloc' | 'dollars-per-mtokens'
	| 'tokens-per-edit-turn' | 'tokens-per-session' | 'one-shot-rate' | 'retry-rate'
	| 'self-correction-rate' | 'cache-read-share' | 'active-minutes-per-session' | 'apply-rate';

/** One metric compared head-to-head between two sides. */
export interface ModelComparisonRow {
	id: ModelComparisonMetricId;
	label: string;
	/** What the metric means, and why its direction matters. */
	description: string;
	a: number | null;
	b: number | null;
	unit: DeltaUnit;
	goodDirection: 'up' | 'down';
	/** Percent difference of side B vs. side A; null when either side is missing. */
	deltaPct: number | null;
	/** Which side is better; 'tie' inside the noise band, null when not computable. */
	winner: 'a' | 'b' | 'tie' | null;
	/** True when both sides cleared the sample floor and the gap is outside the noise band. */
	significant: boolean;
}

/**
 * Head-to-head comparison of two efficiency profiles. Both "model A vs model B
 * over the same window" and "one model, this period vs. last period" produce
 * this same shape — the caller decides what the two sides mean.
 */
export interface ModelComparison {
	a: ModelPeriodMetrics;
	b: ModelPeriodMetrics;
	rows: ModelComparisonRow[];
	/** Reasons to distrust the comparison (small samples, diverging task mix, …). */
	caveats: string[];
	/** Net verdict across the significant rows; null when nothing is significant. */
	verdict: { winner: 'a' | 'b' | 'tie'; wins: { a: number; b: number } } | null;
}

function comparisonRow(
	id: ModelComparisonMetricId,
	label: string,
	description: string,
	a: number | null,
	b: number | null,
	unit: DeltaUnit,
	goodDirection: 'up' | 'down',
): ModelComparisonRow {
	let deltaPct: number | null = null;
	let winner: ModelComparisonRow['winner'] = null;
	let significant = false;
	if (a !== null && b !== null) {
		const baseline = Math.max(Math.abs(a), Math.abs(b));
		if (baseline === 0) {
			deltaPct = 0;
			winner = 'tie';
		} else {
			deltaPct = ((b - a) / baseline) * 100;
			if (Math.abs(deltaPct) < COMPARE_NOISE_PCT) {
				winner = 'tie';
			} else {
				const bIsBetter = goodDirection === 'down' ? b < a : b > a;
				winner = bIsBetter ? 'b' : 'a';
				significant = true;
			}
		}
	}
	return { id, label, description, a, b, unit, goodDirection, deltaPct, winner, significant };
}

/** Total divergence between two task mixes, in share points (0 = identical, 1 = disjoint). */
function taskMixDivergence(a: { [c: string]: number }, b: { [c: string]: number }): number {
	const categories = new Set([...Object.keys(a), ...Object.keys(b)]);
	let divergence = 0;
	for (const c of categories) { divergence += Math.abs((a[c] ?? 0) - (b[c] ?? 0)); }
	return divergence / 2;
}

function buildCaveats(a: ModelPeriodMetrics, b: ModelPeriodMetrics): string[] {
	const caveats: string[] = [];
	for (const side of [a, b]) {
		if (!side.sampleSufficient) {
			caveats.push(`${side.displayName} (${side.periodLabel}) has only ${side.sessionShare.toFixed(1)} session equivalents — below the ${MIN_SESSION_SHARE_FOR_COMPARE} needed for reliable per-session ratios.`);
		}
		if (!side.editSampleSufficient) {
			caveats.push(`${side.displayName} (${side.periodLabel}) has only ${side.editTurns} edit turns — below the ${MIN_EDIT_TURNS_FOR_COMPARE} needed for reliable retry and one-shot rates.`);
		}
	}
	const divergence = taskMixDivergence(a.taskMix, b.taskMix);
	if (divergence >= TASK_MIX_DIVERGENCE_THRESHOLD) {
		caveats.push(`The two sides did different kinds of work (${Math.round(divergence * 100)}% task-mix difference), so part of the gap may reflect the tasks rather than the models.`);
	}
	if (a.sessions > a.sessionShare * 1.5 || b.sessions > b.sessionShare * 1.5) {
		caveats.push('Much of this usage comes from sessions that mixed several models; duration and lines-of-code are split by token share and are therefore approximate.');
	}
	return caveats;
}

function buildVerdict(rows: ModelComparisonRow[]): ModelComparison['verdict'] {
	const significant = rows.filter(r => r.significant);
	if (significant.length === 0) { return null; }
	const wins = {
		a: significant.filter(r => r.winner === 'a').length,
		b: significant.filter(r => r.winner === 'b').length,
	};
	const winner = wins.a === wins.b ? 'tie' : wins.a > wins.b ? 'a' : 'b';
	return { winner, wins };
}

/**
 * Compares two efficiency profiles metric by metric. Rows whose denominators
 * fell below the sample floor arrive as nulls (the view renders them as "—"),
 * and `caveats` explains anything that should temper the conclusion.
 */
export function compareModels(a: ModelPeriodMetrics, b: ModelPeriodMetrics): ModelComparison {
	const rows: ModelComparisonRow[] = [
		comparisonRow('cost-per-edit-turn', 'Cost per edit turn',
			'What one round of file edits actually costs. The headline efficiency number.',
			a.costPerEditTurn, b.costPerEditTurn, 'currency', 'down'),
		comparisonRow('cost-per-session', 'Cost per session',
			'Average spend per session, at provider rates.',
			a.costPerSession, b.costPerSession, 'currency', 'down'),
		comparisonRow('cost-per-kloc', 'Cost per 1000 lines changed',
			'Spend per unit of code actually shipped.',
			a.costPerKloc, b.costPerKloc, 'currency', 'down'),
		comparisonRow('dollars-per-mtokens', 'Cost per million tokens',
			'The raw price of the model, before any behavioural differences.',
			a.dollarsPerMTokens, b.dollarsPerMTokens, 'currency', 'down'),
		comparisonRow('tokens-per-edit-turn', 'Tokens per edit turn',
			'How much context the model burns to make one round of edits.',
			a.tokensPerEditTurn, b.tokensPerEditTurn, 'tokens', 'down'),
		comparisonRow('tokens-per-session', 'Tokens per session',
			'Total token appetite per session.',
			a.tokensPerSession, b.tokensPerSession, 'tokens', 'down'),
		comparisonRow('one-shot-rate', 'One-shot edit rate',
			'Share of edit turns finished with no retries and no self-corrections. Higher is better.',
			a.oneShotRate, b.oneShotRate, 'percent', 'up'),
		comparisonRow('retry-rate', 'Edit retry rate',
			'Retries per edit turn — how often an edit fails and is immediately re-attempted.',
			a.retryRate, b.retryRate, 'ratio', 'down'),
		comparisonRow('self-correction-rate', 'Self-correction rate',
			'How often the model goes back to fix its own earlier edit in the same turn.',
			a.selfCorrectionRate, b.selfCorrectionRate, 'ratio', 'down'),
		comparisonRow('cache-read-share', 'Cache read share',
			'Share of input tokens served from the prompt cache. Higher is cheaper.',
			a.cacheReadShare, b.cacheReadShare, 'percent', 'up'),
		comparisonRow('active-minutes-per-session', 'Active minutes per session',
			'Net working time per session, excluding idle gaps.',
			a.activeMinutesPerSession, b.activeMinutesPerSession, 'minutes', 'down'),
		comparisonRow('apply-rate', 'Apply rate',
			'Share of suggested code blocks actually applied — does the output stick?',
			a.applyRate, b.applyRate, 'percent', 'up'),
	];
	return { a, b, rows, caveats: buildCaveats(a, b), verdict: buildVerdict(rows) };
}

// ---------------------------------------------------------------------------
// View payload
// ---------------------------------------------------------------------------

/** Full payload for the Efficiency webview. */
export interface EfficiencyViewData {
	weekly: EfficiencyWeekPoint[];
	/** True when any week has LOC data (enables the cost-per-KLOC series). */
	hasLoc: boolean;
	/** True when any week has session-duration data. */
	hasDuration: boolean;
	/** True when any week has a meaningful retry rate. */
	hasRetry: boolean;
	/** True when any week has apply-rate data. */
	hasApply: boolean;
	attribution: CostAttribution | null;
	/** Human labels and inclusive calendar-date ranges for the compared attribution windows. */
	attributionWindows: { prev: string; cur: string; prevRange: string; curRange: string };
	deltas: EfficiencyDelta[];
	/** Human labels for the delta card periods. */
	deltaWindows: { prev: string; cur: string };
	value: ValueSignals;
	/** Weekly agent-skill usage (graphify, custom skills, …); empty weeks when no skills detected. */
	skillTrends: SkillUsageTrends;
	/** With/without cohort comparison per skill; empty when no skill reaches the sample floor. */
	skillImpact: SkillImpact[];
	/** True when any skill invocation was detected in the trend window. */
	hasSkills: boolean;
	/**
	 * Trimmed per-day, per-model efficiency data backing the Models tab. The tab
	 * recomputes comparisons client-side from this so switching models or windows
	 * is instant and needs no round trip to the extension host.
	 */
	modelDaily: ModelDailyInput[];
	/** True when at least two models cleared the comparison sample floor. */
	hasModelComparison: boolean;
	/**
	 * Compact per-day volume aggregates (five numbers per day, plus the same
	 * five per editor) for up to {@link EFFICIENCY_MAX_RANGE_DAYS} days. This is
	 * what the time presets, drill-down and editor filter recompute from, so no
	 * UI gesture re-reads a session log. Absent on legacy payloads, in which
	 * case the view falls back to the pre-computed `weekly` series.
	 */
	dailyVolume?: EfficiencyDailyVolume[];
	/**
	 * Per-session behavioural inputs (duration, edit turns, retries, applies,
	 * skill calls) over the session-collection window — numeric counters plus
	 * skill names only, never prompts, paths or titles.
	 */
	sessionSamples?: EfficiencySessionInput[];
	/** Editor display names present in the payload, most-used first. */
	editors?: string[];
	/**
	 * How many trailing days `sessionSamples` covers. Session-derived behaviour
	 * is collected over a shorter window than the daily volume aggregates, so
	 * ranges longer than this show duration/retry/apply gaps and say so.
	 */
	behaviorWindowDays?: number;
	/**
	 * Prompt-cache breakage over the last 30 days. Null for users whose editors
	 * do not report per-turn cache token counts (today: anything but Claude Code
	 * / Claude Desktop), in which case the Cache tab is hidden entirely rather
	 * than shown empty.
	 */
	cacheBreakage: CacheBreakagePeriodStats | null;
	lastUpdated: string;
	backendConfigured: boolean;
	compactNumbers?: boolean;
	/**
	 * Locale used by the view's number/currency formatters, detected by the
	 * extension host. Undefined falls back to the webview runtime's own locale.
	 */
	locale?: string;
	isDebugMode?: boolean;
}
