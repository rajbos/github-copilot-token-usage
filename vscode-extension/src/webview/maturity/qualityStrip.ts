/**
 * "Quality alongside adoption" — a strip under the Fluency Score stage banner.
 *
 * GitHub's Agentic Engineering System warns against measuring speed without
 * measuring error: agent adoption should grow without rework growing with it.
 * This strip puts the month-over-month rework numbers next to the score. It
 * never changes the score, and it is a separate element from the stage banner
 * and radar so the PNG, PDF and share exports — which clone only those — never
 * carry it: the data is local only.
 *
 * Pure string building plus a sanitizer, unit-testable without a DOM.
 */
import { escapeHtml, formatFixed, formatPercent } from '../shared/formatUtils';
import { localize, localizeFormat } from '../shared/localization';
import type { PeriodPair, SpeedQualityClass, SpeedQualityComparison } from '../../../../src/speedVsError';

export type AgenticQualityView = { comparison: SpeedQualityComparison };

const CLASSES: readonly SpeedQualityClass[] = ['faster-and-steadier', 'faster-but-weaker', 'rework-rising', 'steady', 'insufficient-data'];

function finiteOrNull(value: unknown): number | null {
	return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function sanitizePair(raw: any): PeriodPair {
	return { current: finiteOrNull(raw?.current), previous: finiteOrNull(raw?.previous) };
}

/** Validate the `agenticQuality` payload; null when absent or malformed. */
export function sanitizeAgenticQuality(raw: any): AgenticQualityView | null {
	const c = raw?.comparison;
	if (!c || !CLASSES.includes(c.classification)) { return null; }
	const reason = c.reason === 'too-early-in-month' || c.reason === 'too-few-sessions' ? c.reason : undefined;
	return {
		comparison: {
			classification: c.classification,
			agenticPerDay: sanitizePair(c.agenticPerDay),
			correctionsPerSession: sanitizePair(c.correctionsPerSession),
			oneShotRate: sanitizePair(c.oneShotRate),
			reason,
		},
	};
}

function pairHtml(label: string, pair: PeriodPair, format: (v: number) => string): string {
	const value = (v: number | null) => (v === null ? '—' : format(v));
	return `<div class="quality-metric">
		<div class="quality-metric-label">${escapeHtml(label)}</div>
		<div class="quality-metric-value">${escapeHtml(value(pair.current))}</div>
		<div class="quality-metric-previous">${escapeHtml(localizeFormat('agentic.quality.lastMonth', value(pair.previous)))}</div>
	</div>`;
}

/** The strip; empty string when there is nothing to show. */
export function buildQualityStripHtml(view: AgenticQualityView | null | undefined): string {
	if (!view) { return ''; }
	const { comparison } = view;
	const verdictKey = comparison.classification === 'insufficient-data'
		? `agentic.quality.verdict.insufficient-data.${comparison.reason ?? 'too-few-sessions'}`
		: `agentic.quality.verdict.${comparison.classification}`;
	const warn = comparison.classification === 'faster-but-weaker' || comparison.classification === 'rework-rising';
	return `<div class="quality-strip" id="quality-strip">
		<div class="quality-strip-head">
			<span class="quality-strip-title">${escapeHtml(localize('agentic.quality.title'))}</span>
			<span class="quality-strip-note">${escapeHtml(localize('agentic.quality.note'))}</span>
		</div>
		<div class="quality-metrics">
			${pairHtml(localize('agentic.quality.agenticPerDay'), comparison.agenticPerDay, v => formatFixed(v, 1))}
			${pairHtml(localize('agentic.quality.correctionsPerSession'), comparison.correctionsPerSession, v => formatFixed(v, 2))}
			${pairHtml(localize('agentic.quality.oneShot'), comparison.oneShotRate, v => formatPercent(v * 100, 0))}
		</div>
		<div class="quality-verdict${warn ? ' quality-verdict-warn' : ''}">${escapeHtml(localize(verdictKey))}</div>
	</div>`;
}
