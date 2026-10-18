/**
 * HydraFusion routing analysis for Copilot CLI session logs.
 *
 * HydraFusion is a router: one user prompt ("turn") can be answered by several models
 * in sequence — a draft, a review, an escalation — and the CLI deliberately shows the
 * user only the final answer plus a single credit figure. The per-leg detail is never
 * surfaced in the UI, but it *is* written to `~/.copilot/session-state/<id>/events.jsonl`
 * so the CLI can resume and rewind a session. This module reads that same file for a
 * second purpose: reconstructing which model actually did the work, what the reviewer
 * decided, and where the credits went.
 *
 * Pure parsing over the raw JSONL text — no file I/O — so both the extension host and
 * the CLI can call it, and so it is directly unit-testable.
 *
 * Four event types carry the story:
 *  - `session.fusion_resolved`        the routing decision (pattern, phase plan, candidate models)
 *  - `assistant.fusion_phase_completed` one event per leg, carrying its model, verdict and cost
 *  - `session.fusion_handoff`         an escalation from a rejecting judge to a repair leg
 *  - `session.fusion_completed`       the turn rollup (totals, which leg supplied the answer)
 *
 * Cost is reported in nano-AIU (`totalNanoAiu`); AIU ("AI credit units") is that divided
 * by 1e9. The rollup's total and the sum of its phases describe the *same* spend from two
 * directions, so they must never be added together — see `totalAiu` below.
 *
 * `events.jsonl` is session state, not an API. It carries no compatibility promise, so
 * every field here is read defensively and a session that lacks fusion events simply
 * returns `undefined` rather than an empty shell.
 *
 * Schema verified against Copilot CLI 1.0.84-x. Background and field-level measurements:
 * https://github.com/samueltauil/hydrafusion-traces (docs/SPIKE.md).
 */

import { NANO_AIU_TO_DOLLARS } from './tokenEstimation';

/** Nano-AIU per AIU — the CLI reports credits scaled by 1e9 to keep them integral. */
const NANO_AIU_PER_AIU = 1_000_000_000;

/**
 * Execution pattern the router picked for one turn.
 *
 * `single` — one model solves the task outright.
 * `cascade` — an efficient model drafts, a judge from another family accepts or rejects,
 *   and a rejection escalates the whole task to a stronger model (`repair`).
 * `critique` — one model drafts, a read-only critic reviews, and the drafter may revise once.
 *
 * Kept open-ended (`string`) because routing is served remotely (`routeSource: capi_plan`)
 * and new patterns can appear without a CLI release.
 */
export type HydraFusionPattern = 'single' | 'cascade' | 'critique' | (string & {});

/**
 * What one leg was for. `primary`/`draft` produce work, `judge`/`critic` review it,
 * `repair`/`revision` redo or amend it after a review.
 */
export type HydraFusionPhaseKind = 'primary' | 'draft' | 'judge' | 'critic' | 'repair' | 'revision' | (string & {});

/** A judge's decision on the draft it reviewed. Only `judge` legs carry one; critics do not. */
export type HydraFusionVerdict = 'accept' | 'reject' | (string & {});

/** Token and credit usage for one leg, as reported by the CLI (not estimated). */
export interface HydraFusionUsage {
	/** Inference calls this leg made — one leg can make many round trips. */
	requestCount: number;
	inputTokens: number;
	outputTokens: number;
	/** Input tokens served from the prompt cache (a subset of `inputTokens`). */
	cachedTokens: number;
	cacheWriteTokens: number;
	/** Credits this leg cost, in AIU. */
	aiu: number;
}

/** One fusion leg: a single model's contribution to a turn. */
export interface HydraFusionPhase {
	phaseId: string;
	kind: HydraFusionPhaseKind;
	/** `solver`, `judge` or `critic` — the role the model played, independent of phase kind. */
	role: string;
	/** The model that actually served this leg, which is never `hydrafusion` itself. */
	model: string;
	status: string;
	/** The judge's decision, when this leg was a judge. `null` for every other kind. */
	verdict: HydraFusionVerdict | null;
	durationMs: number;
	/** `root` for legs working on the task, `review` for legs inspecting another leg's output. */
	conversationScope: string;
	usage: HydraFusionUsage;
	/** True when this is the leg whose output the user actually received. */
	isFinalSource: boolean;
	/** ISO timestamp the leg completed. */
	completedAt: string | null;
}

/** An escalation: a rejecting judge handing the task to a stronger model. */
export interface HydraFusionHandoff {
	sourcePhaseId: string;
	targetPhaseId: string;
	targetModel: string;
}

/** One user prompt, reconstructed from the router's own notes. */
export interface HydraFusionTurn {
	fusionId: string;
	pattern: HydraFusionPattern;
	/** `completed`, or another terminal state when the turn did not finish normally. */
	outcome: string | null;
	/** Set when the router fell back off its intended plan. `null` on a healthy turn. */
	degradedReason: string | null;
	/** Routing policy in force (e.g. `max`). */
	policy: string | null;
	/** Where the routing decision came from — `capi_plan` means it was served remotely. */
	routeSource: string | null;
	/** How long pattern selection itself took, in ms. Typically well under 1% of turn time. */
	routingLatencyMs: number | null;
	/** The phase kinds the router planned, in order — including ones that never ran. */
	plannedPhases: HydraFusionPhaseKind[];
	/** Candidate models the plan named, which may differ from the models that ran. */
	primaryModel: string | null;
	secondaryModel: string | null;
	fallbackModel: string | null;
	/** The model whose output became the answer the user saw. */
	finalSourceModel: string | null;
	/** Legs that actually ran, in completion order. */
	phases: HydraFusionPhase[];
	handoffs: HydraFusionHandoff[];
	/** Inference calls across all legs. Distinct from `phases.length`, which counts legs. */
	requestCount: number;
	inputTokens: number;
	outputTokens: number;
	cachedTokens: number;
	cacheWriteTokens: number;
	/** Total credits for the turn, in AIU. */
	aiu: number;
	/** Credits spent on legs that did not supply the answer (reviews, superseded drafts). */
	reviewAiu: number;
	durationMs: number;
	/** ISO timestamp of the routing decision. */
	startedAt: string | null;
	/** ISO timestamp of the rollup. */
	completedAt: string | null;
	/** True when more than one leg ran — i.e. more than one model contributed. */
	isCompound: boolean;
}

/** Per-model rollup across every leg in the session. */
export interface HydraFusionModelStat {
	model: string;
	/** Legs this model served. */
	legs: number;
	aiu: number;
	inputTokens: number;
	outputTokens: number;
	/** Turns where this model supplied the final answer. */
	finalAnswers: number;
}

/** Per-phase-kind rollup across every leg in the session (the "phase ledger"). */
export interface HydraFusionPhaseKindStat {
	kind: HydraFusionPhaseKind;
	legs: number;
	aiu: number;
}

/** Everything the router recorded about one session, ready to render. */
export interface HydraFusionSummary {
	turns: HydraFusionTurn[];
	/** Fusion turns observed — one per user prompt the router handled. */
	totalTurns: number;
	/** Turn count per pattern, highest first. */
	patternCounts: { pattern: HydraFusionPattern; turns: number; aiu: number }[];
	/** Turns where more than one model contributed. */
	compoundTurns: number;
	/** `compoundTurns` as a percentage of `totalTurns` (0-100). */
	compoundRatePercent: number;
	judgeAccepts: number;
	judgeRejects: number;
	/**
	 * Rejections as a percentage of all judged drafts (0-100), or `null` when no
	 * judge ran. A rejection is the quality gate working: the draft did not clear
	 * the bar and the turn escalated.
	 */
	judgeRejectionRatePercent: number | null;
	/**
	 * Total credits for the session, in AIU. Taken from the per-turn rollups, which
	 * already include their own legs — never the rollups plus the legs, which would
	 * double-count every turn.
	 */
	totalAiu: number;
	/** Credits that bought review rather than the delivered output. */
	reviewAiu: number;
	/** `reviewAiu` as a percentage of `totalAiu` (0-100). */
	reviewSharePercent: number;
	totalInputTokens: number;
	totalOutputTokens: number;
	totalCachedTokens: number;
	/** Inference calls across every leg of every turn. */
	totalRequestCount: number;
	/** Legs run across the session. */
	totalLegs: number;
	byModel: HydraFusionModelStat[];
	byPhaseKind: HydraFusionPhaseKindStat[];
	/** Distinct models that served a leg, ordered by credits spent. */
	models: string[];
	/** Mean pattern-selection latency in ms, or `null` when never reported. */
	avgRoutingLatencyMs: number | null;
	/** Turns that reported a `degradedReason` — the router falling off its plan. */
	degradedTurns: number;
	/** The synthetic model the user selected, normally `hydrafusion`. */
	syntheticModel: string | null;
}

// ── raw event shapes (defensive: session state carries no compatibility promise) ──

type RawRecord = Record<string, unknown>;

function asRecord(value: unknown): RawRecord | null {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as RawRecord : null;
}

function asString(value: unknown): string | null {
	return typeof value === 'string' && value.length > 0 ? value : null;
}

function asNumber(value: unknown): number {
	return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function asOptionalNumber(value: unknown): number | null {
	return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Converts the CLI's nano-AIU integer into AIU credits. */
export function nanoAiuToAiu(nanoAiu: unknown): number {
	return asNumber(nanoAiu) / NANO_AIU_PER_AIU;
}

/**
 * AIU-to-USD rate, derived from the repo's one canonical nano-AIU-to-dollars rate
 * (`NANO_AIU_TO_DOLLARS` in `tokenEstimation.ts`, applied elsewhere to
 * `session.shutdown.totalNanoAiu`) rather than a second hard-coded constant here.
 * `NANO_AIU_PER_AIU * NANO_AIU_TO_DOLLARS` is the same $0.01-per-credit rate GitHub
 * documents in `copilotPlans.json`'s `monthlyAiCreditsUsd` note ("1 AI credit =
 * $0.01") — computed once as its own factor, rather than inline in `aiuToUsd` below,
 * so the multiplication order doesn't reintroduce floating-point noise per call.
 */
const AIU_TO_USD_RATE = NANO_AIU_PER_AIU * NANO_AIU_TO_DOLLARS;

/** Converts AIU credits (already divided from nano-AIU) into a USD amount for display. */
export function aiuToUsd(aiu: number): number {
	return aiu * AIU_TO_USD_RATE;
}

function parseUsage(raw: unknown): HydraFusionUsage {
	const u = asRecord(raw) ?? {};
	return {
		requestCount: asNumber(u.requestCount),
		inputTokens: asNumber(u.inputTokens),
		outputTokens: asNumber(u.outputTokens),
		cachedTokens: asNumber(u.cachedTokens),
		cacheWriteTokens: asNumber(u.cacheWriteTokens),
		aiu: nanoAiuToAiu(u.totalNanoAiu),
	};
}

/** Mutable accumulator for one fusion while its events are still streaming past. */
interface TurnDraft {
	fusionId: string;
	resolved: RawRecord | null;
	resolvedAt: string | null;
	completed: RawRecord | null;
	completedAt: string | null;
	phases: { data: RawRecord; timestamp: string | null }[];
	handoffs: HydraFusionHandoff[];
}

/**
 * True when the raw session text mentions any fusion event at all.
 *
 * A cheap substring guard so the common case — the overwhelming majority of
 * sessions, which never ran HydraFusion — costs one scan instead of a full
 * JSON parse of every line.
 */
export function containsHydraFusionEvents(content: string): boolean {
	return content.includes('fusion_resolved') || content.includes('fusion_phase_completed') || content.includes('fusion_completed');
}

function buildPhase(entry: { data: RawRecord; timestamp: string | null }, finalSourcePhaseId: string | null): HydraFusionPhase {
	const d = entry.data;
	const phaseId = asString(d.phaseId) ?? '';
	return {
		phaseId,
		kind: asString(d.phaseKind) ?? 'unknown',
		role: asString(d.role) ?? 'unknown',
		model: asString(d.model) ?? 'unknown',
		status: asString(d.status) ?? 'unknown',
		verdict: asString(d.verdict),
		durationMs: asNumber(d.durationMs),
		conversationScope: asString(d.conversationScope) ?? 'root',
		usage: parseUsage(d.usage),
		isFinalSource: finalSourcePhaseId !== null && phaseId === finalSourcePhaseId,
		completedAt: entry.timestamp,
	};
}

/**
 * Picks the leg that supplied the answer.
 *
 * Normally the rollup names it outright via `finalSourcePhaseId`. When the rollup is
 * missing — a session still in flight, or a turn that never completed — the last leg
 * that did productive work (anything but a review) is the best available stand-in,
 * since reviews never become the answer.
 */
function resolveFinalSourcePhaseId(completed: RawRecord | null, phases: { data: RawRecord }[]): string | null {
	const declared = completed ? asString(completed.finalSourcePhaseId) : null;
	if (declared) { return declared; }
	for (let i = phases.length - 1; i >= 0; i--) {
		const scope = asString(phases[i].data.conversationScope);
		if (scope !== 'review') { return asString(phases[i].data.phaseId); }
	}
	return null;
}

function buildTurn(draft: TurnDraft): HydraFusionTurn {
	const resolved = draft.resolved ?? {};
	const completed = draft.completed;
	const finalSourcePhaseId = resolveFinalSourcePhaseId(completed, draft.phases);
	const phases = draft.phases.map(p => buildPhase(p, finalSourcePhaseId));

	const plannedPhases = Array.isArray(resolved.phasePlan)
		? (resolved.phasePlan as unknown[]).map(p => asString(asRecord(p)?.kind) ?? 'unknown')
		: [];

	// Prefer the rollup's own totals; fall back to summing the legs so an in-flight
	// turn still reports something truthful rather than zero.
	const phaseSum = (pick: (u: HydraFusionUsage) => number): number => phases.reduce((s, p) => s + pick(p.usage), 0);
	const fromRollup = (key: string, fallback: number): number => completed ? asNumber(completed[key]) : fallback;

	const aiu = completed ? nanoAiuToAiu(completed.totalNanoAiu) : phaseSum(u => u.aiu);
	const reviewAiu = phases.filter(p => !p.isFinalSource).reduce((s, p) => s + p.usage.aiu, 0);

	return {
		fusionId: draft.fusionId,
		pattern: asString(resolved.pattern) ?? (completed ? asString(completed.pattern) ?? 'unknown' : 'unknown'),
		outcome: completed ? asString(completed.outcome) : null,
		degradedReason: completed ? asString(completed.degradedReason) : null,
		policy: asString(resolved.policy),
		routeSource: asString(resolved.routeSource),
		routingLatencyMs: asOptionalNumber(resolved.routingLatencyMs),
		plannedPhases,
		primaryModel: asString(resolved.primaryModel),
		secondaryModel: asString(resolved.secondaryModel),
		fallbackModel: asString(resolved.fallbackModel),
		finalSourceModel: completed ? asString(completed.finalSourceModel) : (phases.find(p => p.isFinalSource)?.model ?? null),
		phases,
		handoffs: draft.handoffs,
		requestCount: fromRollup('requestCount', phaseSum(u => u.requestCount)),
		inputTokens: fromRollup('inputTokens', phaseSum(u => u.inputTokens)),
		outputTokens: fromRollup('outputTokens', phaseSum(u => u.outputTokens)),
		cachedTokens: fromRollup('cachedTokens', phaseSum(u => u.cachedTokens)),
		cacheWriteTokens: fromRollup('cacheWriteTokens', phaseSum(u => u.cacheWriteTokens)),
		aiu,
		reviewAiu,
		durationMs: fromRollup('durationMs', phases.reduce((s, p) => s + p.durationMs, 0)),
		startedAt: draft.resolvedAt,
		completedAt: draft.completedAt,
		isCompound: phases.length > 1,
	};
}

function summarizeModels(turns: HydraFusionTurn[]): HydraFusionModelStat[] {
	const byModel = new Map<string, HydraFusionModelStat>();
	for (const turn of turns) {
		for (const phase of turn.phases) {
			let stat = byModel.get(phase.model);
			if (!stat) {
				stat = { model: phase.model, legs: 0, aiu: 0, inputTokens: 0, outputTokens: 0, finalAnswers: 0 };
				byModel.set(phase.model, stat);
			}
			stat.legs++;
			stat.aiu += phase.usage.aiu;
			stat.inputTokens += phase.usage.inputTokens;
			stat.outputTokens += phase.usage.outputTokens;
			if (phase.isFinalSource) { stat.finalAnswers++; }
		}
	}
	return [...byModel.values()].sort((a, b) => b.aiu - a.aiu || b.legs - a.legs || a.model.localeCompare(b.model));
}

function summarizePhaseKinds(turns: HydraFusionTurn[]): HydraFusionPhaseKindStat[] {
	const byKind = new Map<string, HydraFusionPhaseKindStat>();
	for (const turn of turns) {
		for (const phase of turn.phases) {
			let stat = byKind.get(phase.kind);
			if (!stat) {
				stat = { kind: phase.kind, legs: 0, aiu: 0 };
				byKind.set(phase.kind, stat);
			}
			stat.legs++;
			stat.aiu += phase.usage.aiu;
		}
	}
	return [...byKind.values()].sort((a, b) => b.aiu - a.aiu || b.legs - a.legs || a.kind.localeCompare(b.kind));
}

function summarizePatterns(turns: HydraFusionTurn[]): { pattern: HydraFusionPattern; turns: number; aiu: number }[] {
	const byPattern = new Map<string, { pattern: string; turns: number; aiu: number }>();
	for (const turn of turns) {
		let stat = byPattern.get(turn.pattern);
		if (!stat) {
			stat = { pattern: turn.pattern, turns: 0, aiu: 0 };
			byPattern.set(turn.pattern, stat);
		}
		stat.turns++;
		stat.aiu += turn.aiu;
	}
	return [...byPattern.values()].sort((a, b) => b.turns - a.turns || b.aiu - a.aiu || a.pattern.localeCompare(b.pattern));
}

function percent(part: number, whole: number): number {
	return whole > 0 ? (part / whole) * 100 : 0;
}

/**
 * Reconstructs every HydraFusion turn recorded in a Copilot CLI session log.
 *
 * @param content Raw `events.jsonl` text. Malformed lines are skipped rather than fatal —
 *   a session log can be truncated mid-write while the CLI is still running.
 * @returns The session's routing summary, or `undefined` when the session never used
 *   HydraFusion (the overwhelmingly common case) so callers can skip the UI entirely.
 */
export function analyzeHydraFusionSession(content: string): HydraFusionSummary | undefined {
	if (!content || !containsHydraFusionEvents(content)) { return undefined; }

	const drafts = new Map<string, TurnDraft>();
	let syntheticModel: string | null = null;

	const draftFor = (fusionId: string): TurnDraft => {
		let draft = drafts.get(fusionId);
		if (!draft) {
			draft = { fusionId, resolved: null, resolvedAt: null, completed: null, completedAt: null, phases: [], handoffs: [] };
			drafts.set(fusionId, draft);
		}
		return draft;
	};

	for (const line of content.split('\n')) {
		const trimmed = line.trim();
		if (!trimmed || !trimmed.includes('fusion')) { continue; }
		let event: RawRecord | null;
		try { event = asRecord(JSON.parse(trimmed)); } catch { continue; }
		if (!event) { continue; }

		const type = asString(event.type);
		const data = asRecord(event.data);
		if (!type || !data) { continue; }
		const fusionId = asString(data.fusionId);
		if (!fusionId) { continue; }
		const timestamp = asString(event.timestamp);

		switch (type) {
			case 'session.fusion_resolved': {
				const draft = draftFor(fusionId);
				draft.resolved = data;
				draft.resolvedAt = timestamp;
				syntheticModel = syntheticModel ?? asString(data.syntheticModel);
				break;
			}
			case 'assistant.fusion_phase_completed':
				draftFor(fusionId).phases.push({ data, timestamp });
				break;
			case 'session.fusion_handoff':
				draftFor(fusionId).handoffs.push({
					sourcePhaseId: asString(data.sourcePhaseId) ?? '',
					targetPhaseId: asString(data.targetPhaseId) ?? '',
					targetModel: asString(data.targetModel) ?? 'unknown',
				});
				break;
			case 'session.fusion_completed': {
				const draft = draftFor(fusionId);
				draft.completed = data;
				draft.completedAt = timestamp;
				syntheticModel = syntheticModel ?? asString(data.syntheticModel);
				break;
			}
			default:
				break;
		}
	}

	// A fusion with neither a plan nor a single completed leg carries nothing to show.
	const turns = [...drafts.values()]
		.filter(d => d.resolved !== null || d.phases.length > 0)
		.map(buildTurn);
	if (turns.length === 0) { return undefined; }

	const judgeVerdicts = turns.flatMap(t => t.phases).map(p => p.verdict).filter((v): v is string => v !== null);
	const judgeAccepts = judgeVerdicts.filter(v => v === 'accept').length;
	const judgeRejects = judgeVerdicts.filter(v => v === 'reject').length;
	const judged = judgeAccepts + judgeRejects;

	const totalAiu = turns.reduce((s, t) => s + t.aiu, 0);
	const reviewAiu = turns.reduce((s, t) => s + t.reviewAiu, 0);
	const compoundTurns = turns.filter(t => t.isCompound).length;
	const latencies = turns.map(t => t.routingLatencyMs).filter((l): l is number => l !== null);
	const byModel = summarizeModels(turns);

	return {
		turns,
		totalTurns: turns.length,
		patternCounts: summarizePatterns(turns),
		compoundTurns,
		compoundRatePercent: percent(compoundTurns, turns.length),
		judgeAccepts,
		judgeRejects,
		judgeRejectionRatePercent: judged > 0 ? percent(judgeRejects, judged) : null,
		totalAiu,
		reviewAiu,
		reviewSharePercent: percent(reviewAiu, totalAiu),
		totalInputTokens: turns.reduce((s, t) => s + t.inputTokens, 0),
		totalOutputTokens: turns.reduce((s, t) => s + t.outputTokens, 0),
		totalCachedTokens: turns.reduce((s, t) => s + t.cachedTokens, 0),
		totalRequestCount: turns.reduce((s, t) => s + t.requestCount, 0),
		totalLegs: turns.reduce((s, t) => s + t.phases.length, 0),
		byModel,
		byPhaseKind: summarizePhaseKinds(turns),
		models: byModel.map(m => m.model),
		avgRoutingLatencyMs: latencies.length > 0 ? latencies.reduce((s, l) => s + l, 0) / latencies.length : null,
		degradedTurns: turns.filter(t => t.degradedReason !== null).length,
		syntheticModel,
	};
}

/**
 * Correlates each fusion turn with the chat turn (`ChatTurn.turnNumber`) whose user
 * prompt triggered it, so per-leg detail can be shown inline in the generic turns
 * table instead of only in the dedicated HydraFusion section.
 *
 * Both sequences are chronologically ordered — chat turns by `turnNumber`, fusion
 * turns by the order the router resolved them — so a single forward merge suffices:
 * for each fusion turn, advance through chat turns while their timestamp is at or
 * before the fusion turn's routing decision (`startedAt`). The last chat turn
 * advanced past is the one whose prompt the router was resolving; turns the router
 * never got to (a later prompt, or one where routing was skipped) are left unmatched.
 *
 * A missing timestamp on either side — or a session with no fusion turns — leaves
 * the corresponding entries out of the map rather than guessing; callers get an
 * empty map, not a wrong one.
 *
 * Known limitation: this correlates by timestamp proximity because neither event
 * stream carries a shared identifier — `user.message` (which becomes a `ChatTurn`)
 * has none, and `session.fusion_resolved`'s own `turnId` has nothing on the chat
 * side to match against. So if the chat turn that actually triggered a fusion
 * resolution is missing from `chatTurns` entirely (e.g. it was dropped during
 * turn extraction upstream, not a case this function can detect), that fusion
 * turn's legs attach to whichever earlier chat turn happens to precede it instead
 * — a real turn just never routed through HydraFusion is handled correctly (see
 * the "skips a chat turn a non-fusion model handled" test), but a turn missing
 * outright is not distinguishable from one. Fixing that would mean threading a
 * shared id (e.g. `assistant.turn_start`/`turn_end`'s `turnId`) through `ChatTurn`
 * itself, which is a larger change to the canonical turn model shared by every
 * consumer — out of scope for what is otherwise a display-only feature.
 *
 * @returns Map from fusion turn index (into `hydraTurns`) to the matching chat
 *   turn's `turnNumber`.
 */
export function matchHydraFusionTurnsToChatTurns(
	chatTurns: { turnNumber: number; timestamp: string | null }[],
	hydraTurns: HydraFusionTurn[],
): Map<number, number> {
	const matches = new Map<number, number>();
	let chatIndex = 0;
	for (let h = 0; h < hydraTurns.length; h++) {
		const startedAt = hydraTurns[h].startedAt ? Date.parse(hydraTurns[h].startedAt!) : NaN;
		if (Number.isNaN(startedAt)) { continue; }

		let matchedTurnNumber: number | null = null;
		while (chatIndex < chatTurns.length) {
			const ts = chatTurns[chatIndex].timestamp ? Date.parse(chatTurns[chatIndex].timestamp!) : NaN;
			// An unusable timestamp can never be a match for *any* fusion turn, but it must not
			// get stuck as the loop's position either — skip it permanently so later, well-formed
			// chat turns stay reachable by this and every subsequent fusion turn.
			if (Number.isNaN(ts)) { chatIndex++; continue; }
			if (ts > startedAt) { break; }
			matchedTurnNumber = chatTurns[chatIndex].turnNumber;
			chatIndex++;
		}
		if (matchedTurnNumber !== null) { matches.set(h, matchedTurnNumber); }
	}
	return matches;
}

// ── Cross-session aggregate ──────────────────────────────────────────────────

/**
 * The additive, numeric core of a {@link HydraFusionSummary}: what is kept per session in
 * the usage analysis and summed across a period. Counts and credits only — no model ids,
 * prompts or timestamps.
 */
export interface HydraFusionRollup {
	/** Sessions that contributed. */
	sessions: number;
	totalTurns: number;
	compoundTurns: number;
	judgeAccepts: number;
	judgeRejects: number;
	/** Turns where a rejecting judge handed the task to a stronger model. */
	escalatedTurns: number;
	/** Credits for the period in AIU, from the per-turn rollups (never rollups plus legs). */
	totalAiu: number;
	/** Credits spent on legs that did not supply the answer. */
	reviewAiu: number;
	degradedTurns: number;
	patternCounts: { pattern: HydraFusionPattern; turns: number; aiu: number }[];
}

/** Period totals and derived rates across HydraFusion sessions. Numeric only. */
export interface HydraFusionAggregate extends HydraFusionRollup {
	/** `compoundTurns` as a percentage of `totalTurns` (0-100); 0 when there are no turns. */
	compoundRatePercent: number;
	/** Rejections as a percentage of judged drafts (0-100); `null` when no judge ran. */
	judgeRejectionRatePercent: number | null;
	/** Mean credits per turn in AIU; `null` when there are no turns. */
	aiuPerTurn: number | null;
	/** Total spend in USD (`aiuToUsd(totalAiu)`). */
	totalUsd: number;
	/** Mean spend per turn in USD; `null` when there are no turns. */
	usdPerTurn: number | null;
	/** `reviewAiu` as a percentage of `totalAiu` (0-100); 0 when nothing was spent. */
	reviewSharePercent: number;
	/** Escalated turns as a percentage of all turns (0-100); 0 when there are no turns. */
	escalationRatePercent: number;
}

export function createEmptyHydraFusionRollup(): HydraFusionRollup {
	return {
		sessions: 0, totalTurns: 0, compoundTurns: 0, judgeAccepts: 0, judgeRejects: 0,
		escalatedTurns: 0, totalAiu: 0, reviewAiu: 0, degradedTurns: 0, patternCounts: [],
	};
}

/** Reduces one session's summary to its additive rollup (one session). */
export function toHydraFusionRollup(summary: HydraFusionSummary): HydraFusionRollup {
	return {
		sessions: 1,
		totalTurns: summary.totalTurns,
		compoundTurns: summary.compoundTurns,
		judgeAccepts: summary.judgeAccepts,
		judgeRejects: summary.judgeRejects,
		escalatedTurns: summary.turns.filter(turn => turn.handoffs.length > 0).length,
		totalAiu: summary.totalAiu,
		reviewAiu: summary.reviewAiu,
		degradedTurns: summary.degradedTurns,
		patternCounts: summary.patternCounts.map(p => ({ ...p })),
	};
}

/** Adds `source` into `target`, merging the pattern mix; returns `target`. */
export function addHydraFusionRollup(target: HydraFusionRollup, source: HydraFusionRollup): HydraFusionRollup {
	target.sessions += source.sessions;
	target.totalTurns += source.totalTurns;
	target.compoundTurns += source.compoundTurns;
	target.judgeAccepts += source.judgeAccepts;
	target.judgeRejects += source.judgeRejects;
	target.escalatedTurns += source.escalatedTurns;
	target.totalAiu += source.totalAiu;
	target.reviewAiu += source.reviewAiu;
	target.degradedTurns += source.degradedTurns;
	for (const incoming of source.patternCounts) {
		const existing = target.patternCounts.find(p => p.pattern === incoming.pattern);
		if (existing) { existing.turns += incoming.turns; existing.aiu += incoming.aiu; }
		else { target.patternCounts.push({ ...incoming }); }
	}
	target.patternCounts.sort((a, b) => b.turns - a.turns || b.aiu - a.aiu);
	return target;
}

/** Derives the display rates from an (already summed) rollup. */
export function deriveHydraFusionAggregate(rollup: HydraFusionRollup): HydraFusionAggregate {
	const judged = rollup.judgeAccepts + rollup.judgeRejects;
	const totalUsd = aiuToUsd(rollup.totalAiu);
	return {
		...rollup,
		patternCounts: rollup.patternCounts.map(p => ({ ...p })),
		compoundRatePercent: percent(rollup.compoundTurns, rollup.totalTurns),
		judgeRejectionRatePercent: judged > 0 ? percent(rollup.judgeRejects, judged) : null,
		aiuPerTurn: rollup.totalTurns > 0 ? rollup.totalAiu / rollup.totalTurns : null,
		totalUsd,
		usdPerTurn: rollup.totalTurns > 0 ? totalUsd / rollup.totalTurns : null,
		reviewSharePercent: percent(rollup.reviewAiu, rollup.totalAiu),
		escalationRatePercent: percent(rollup.escalatedTurns, rollup.totalTurns),
	};
}

/**
 * Period totals across several sessions' HydraFusion summaries: turns, compound rate,
 * judge accept/reject, AIU per turn, review share and the pattern mix. Each session's
 * `totalAiu` already contains its own legs, so credits are summed from those totals and
 * never from rollups plus legs.
 */
export function aggregateHydraFusionSummaries(summaries: readonly HydraFusionSummary[]): HydraFusionAggregate {
	const total = createEmptyHydraFusionRollup();
	for (const summary of summaries) { addHydraFusionRollup(total, toHydraFusionRollup(summary)); }
	return deriveHydraFusionAggregate(total);
}
