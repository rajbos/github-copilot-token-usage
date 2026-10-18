// The Usage Analysis "Router" card: HydraFusion routing aggregated across the Copilot
// CLI sessions of a period. Numeric only — see `aggregateHydraFusionSummaries` in
// `src/hydrafusion.ts`, which builds the data every host receives.
import { escapeHtml, formatFixed, formatNumber } from '../shared/formatUtils';
import { localize } from '../shared/localization';
import type { HydraFusionAggregate } from '../../../../src/hydrafusion';

export const ROUTER_PERIODS = ['today', 'last30Days', 'month', 'lastMonth'] as const;
export type RouterPeriod = typeof ROUTER_PERIODS[number];
export type RouterPayload = Partial<Record<RouterPeriod, HydraFusionAggregate | null>>;

const num = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) ? value : 0;
const optionalNum = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null;

type RawRecord = Record<string, unknown>;

function isRecord(value: unknown): value is RawRecord {
	return !!value && typeof value === 'object' && !Array.isArray(value);
}

function sanitizeAggregate(raw: unknown): HydraFusionAggregate | null {
	if (!isRecord(raw) || num(raw.totalTurns) <= 0) { return null; }
	return {
		sessions: num(raw.sessions), totalTurns: num(raw.totalTurns), compoundTurns: num(raw.compoundTurns),
		judgeAccepts: num(raw.judgeAccepts), judgeRejects: num(raw.judgeRejects), escalatedTurns: num(raw.escalatedTurns),
		totalAiu: num(raw.totalAiu), reviewAiu: num(raw.reviewAiu), degradedTurns: num(raw.degradedTurns),
		patternCounts: Array.isArray(raw.patternCounts)
			? raw.patternCounts
				.filter((p): p is RawRecord & { pattern: string } => isRecord(p) && typeof p.pattern === 'string')
				.map(p => ({ pattern: p.pattern, turns: num(p.turns), aiu: num(p.aiu) }))
			: [],
		compoundRatePercent: num(raw.compoundRatePercent),
		judgeRejectionRatePercent: optionalNum(raw.judgeRejectionRatePercent),
		aiuPerTurn: optionalNum(raw.aiuPerTurn),
		totalUsd: num(raw.totalUsd),
		usdPerTurn: optionalNum(raw.usdPerTurn),
		reviewSharePercent: num(raw.reviewSharePercent),
		escalationRatePercent: num(raw.escalationRatePercent),
	};
}

/** Validates the host payload; a period with no routed turns becomes null. Returns undefined when absent. */
export function sanitizeRouterPayload(raw: unknown): RouterPayload | undefined {
	if (!isRecord(raw)) { return undefined; }
	const result: RouterPayload = {};
	for (const period of ROUTER_PERIODS) { result[period] = sanitizeAggregate(raw[period]); }
	return result;
}

const pct = (value: number | null): string => value === null ? '—' : `${formatFixed(value, 1)}%`;

function statCard(label: string, value: string): string {
	return `<div class="stat-card"><div class="stat-label">${escapeHtml(label)}</div><div class="stat-value">${escapeHtml(value)}</div></div>`;
}

function periodBlock(period: RouterPeriod, agg: HydraFusionAggregate): string {
	const mix = agg.patternCounts.map(p => `${p.pattern} ${formatNumber(p.turns)}`).join(' · ');
	return `
		<div class="router-period" data-router-period="${period}">
			<h4>${escapeHtml(localize(`usage.router.period.${period}`))}</h4>
			<div class="stats-grid">
				${statCard(localize('usage.router.stat.sessions'), formatNumber(agg.sessions))}
				${statCard(localize('usage.router.stat.turns'), formatNumber(agg.totalTurns))}
				${statCard(localize('usage.router.stat.compoundRate'), pct(agg.compoundRatePercent))}
				${statCard(localize('usage.router.stat.judgeRejection'), pct(agg.judgeRejectionRatePercent))}
				${statCard(localize('usage.router.stat.escalation'), pct(agg.escalationRatePercent))}
				${statCard(localize('usage.router.stat.aiuPerTurn'), agg.aiuPerTurn === null ? '—' : formatFixed(agg.aiuPerTurn, 2))}
				${statCard(localize('usage.router.stat.reviewShare'), pct(agg.reviewSharePercent))}
				${statCard(localize('usage.router.stat.totalSpend'), `$${formatFixed(agg.totalUsd, 2)}`)}
			</div>
			${mix ? `<div class="section-subtitle">${escapeHtml(localize('usage.router.patternMix'))}: ${escapeHtml(mix)}</div>` : ''}
		</div>`;
}

/** The card, or an empty string when no period has a routed HydraFusion turn. */
export function buildRouterSectionHtml(router: RouterPayload | undefined): string {
	const blocks = ROUTER_PERIODS.flatMap(period => {
		const agg = router?.[period];
		return agg ? [periodBlock(period, agg)] : [];
	});
	if (blocks.length === 0) { return ''; }
	return `
		<div class="section" id="section-router">
			<div class="section-title"><span>⚡</span><span>${escapeHtml(localize('usage.router.title'))}</span></div>
			<div class="section-subtitle">${escapeHtml(localize('usage.router.subtitle'))}</div>
			${blocks.join('')}
		</div>`;
}
