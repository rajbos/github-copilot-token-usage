// Renders the Efficiency view's selected-period ("week") drill-down: a native
// labelled selector plus a detail region. Pure string builders with no DOM or
// CSS imports so the markup is unit-testable directly in Node, like
// modelMixTable.ts.
//
// A canvas point click only augments this: the <select> gives keyboard and
// assistive-technology users the same selection.
//
// @security bucket labels and model names derive from session data; every
// dynamic value goes through `escapeHtml`.

import { escapeHtml, formatCompact, formatCost, formatNumber } from '../shared/formatUtils';
import { localize, localizeFormat } from '../shared/localization';
import type { EfficiencyBucket } from '../../../../src/efficiencyAnalysis';
import type {
	BucketDetail, BucketDetailMetric, BucketMetricUnit, ModelBucketDetail, SkillBucketDetail,
} from '../../../../src/efficiencyBucketDetail';

export const BUCKET_PICK_ID = 'eff-bucket-pick';
export const BUCKET_DETAIL_ID = 'eff-bucket-detail';
export const BUCKET_DRILL_BUTTON_ID = 'eff-bucket-drill';

/** Formats a metric value in its unit; `null` is the em dash, never zero. */
export function formatBucketValue(value: number | null, unit: BucketMetricUnit): string {
	if (value === null) { return '—'; }
	switch (unit) {
		case 'currency': return `$${value.toFixed(2)}`;
		case 'tokens': return formatCompact(Math.round(value));
		case 'minutes': return `${value.toFixed(1)} min`;
		case 'seconds': return `${value.toFixed(1)} s`;
		case 'tokensPerSecond': return `${value.toFixed(1)} tok/s`;
		case 'percent': return `${value.toFixed(0)}%`;
		case 'ratio': return value.toFixed(1);
		case 'count': return value >= 100 ? formatNumber(Math.round(value)) : value.toFixed(1);
	}
}

/**
 * Change text that does not rely on colour or an arrow alone: the direction is
 * spelled out and so is whether it is better or worse.
 */
export function formatBucketChange(deltaPct: number | null, improved: boolean | null): string {
	if (deltaPct === null) { return '—'; }
	const magnitude = Math.abs(deltaPct).toFixed(0);
	const direction = deltaPct > 0 ? localizeFormat('efficiency.detail.up', magnitude)
		: deltaPct < 0 ? localizeFormat('efficiency.detail.down', magnitude)
			: localize('efficiency.detail.flat');
	if (improved === null) { return direction; }
	return `${direction} (${localize(improved ? 'efficiency.detail.better' : 'efficiency.detail.worse')})`;
}

/** The labelled native selector that mirrors a chart point click. */
export function bucketPickerHtml(buckets: EfficiencyBucket[], selectedKey: string): string {
	if (buckets.length === 0) { return ''; }
	const options = [`<option value=""${selectedKey ? '' : ' selected'}>${escapeHtml(localize('efficiency.detail.pickerNone'))}</option>`]
		.concat(buckets.map(b => `<option value="${escapeHtml(b.key)}"${b.key === selectedKey ? ' selected' : ''}>${escapeHtml(b.label)}</option>`));
	return `<label class="scope-field bucket-pick">${escapeHtml(localize('efficiency.detail.pickerLabel'))} <select id="${BUCKET_PICK_ID}">${options.join('')}</select></label>`;
}

/** Shown while nothing is selected, so the region is always present and discoverable. */
export function renderBucketDetailPlaceholder(): string {
	return `<section id="${BUCKET_DETAIL_ID}" class="bucket-detail" role="region" aria-live="polite" aria-label="${escapeHtml(localize('efficiency.detail.regionLabel'))}"><p class="eff-section-note">${escapeHtml(localize('efficiency.detail.hint'))}</p></section>`;
}

function noteText(note: BucketDetail['notes'][number]): string {
	switch (note) {
		case 'partial': return localize('efficiency.detail.note.partial');
		case 'no-sessions': return localize('efficiency.detail.note.noSessions');
		case 'no-prior': return localize('efficiency.detail.note.noPrior');
	}
}

function metricRow(m: BucketDetailMetric): string {
	const label = localize(`efficiency.detail.metric.${m.id}`);
	const reason = m.unavailable ? ` <span class="bucket-reason">${escapeHtml(localize(`efficiency.detail.unavailable.${m.unavailable}`))}</span>` : '';
	return `<tr><th scope="row">${escapeHtml(label)}</th>`
		+ `<td>${escapeHtml(formatBucketValue(m.value, m.unit))}${reason}</td>`
		+ `<td>${escapeHtml(formatBucketValue(m.prior, m.unit))}</td>`
		+ `<td>${escapeHtml(formatBucketChange(m.deltaPct, m.improved))}</td></tr>`;
}

function rawList(raw: BucketDetail['raw']): string {
	const items: [string, string][] = [
		['sessions', formatNumber(raw.sessions)],
		['tokens', formatCompact(raw.tokens)],
		['turns', formatNumber(raw.turns)],
		['loc', formatNumber(raw.loc)],
		['cost', formatCost(raw.cost)],
	];
	return `<dl class="bucket-raw">${items.map(([k, v]) => `<div><dt>${escapeHtml(localize(`efficiency.detail.raw.${k}`))}</dt><dd>${escapeHtml(v)}</dd></div>`).join('')}</dl>`;
}

function headerHtml(label: string, startKey: string, endKey: string, partial: boolean, canDrill: boolean): string {
	const drill = canDrill
		? `<button type="button" id="${BUCKET_DRILL_BUTTON_ID}" class="bucket-drill">${escapeHtml(localize('efficiency.detail.showDays'))}</button>`
		: '';
	const badge = partial ? ` <span class="bucket-partial">${escapeHtml(localize('efficiency.detail.partialBadge'))}</span>` : '';
	return `<h3>${escapeHtml(label)}${badge}</h3>
		<p class="bucket-range">${escapeHtml(localizeFormat('efficiency.detail.range', startKey, endKey))} ${drill}</p>`;
}

/** Detail for the Trends and Combined tabs. */
export function renderBucketDetail(detail: BucketDetail, canDrill: boolean): string {
	const notes = detail.notes.map(n => `<li>${escapeHtml(noteText(n))}</li>`).join('');
	return `<section id="${BUCKET_DETAIL_ID}" class="bucket-detail" role="region" aria-live="polite" aria-label="${escapeHtml(localize('efficiency.detail.regionLabel'))}">
		${headerHtml(detail.label, detail.startKey, detail.endKey, detail.partial, canDrill)}
		${rawList(detail.raw)}
		<table class="bucket-metrics"><caption class="bucket-sr">${escapeHtml(localize('efficiency.detail.caption'))}</caption>
			<thead><tr><th scope="col">${escapeHtml(localize('efficiency.detail.col.metric'))}</th><th scope="col">${escapeHtml(localize('efficiency.detail.col.value'))}</th><th scope="col">${escapeHtml(localize('efficiency.detail.col.prior'))}</th><th scope="col">${escapeHtml(localize('efficiency.detail.col.change'))}</th></tr></thead>
			<tbody>${detail.metrics.map(metricRow).join('')}</tbody></table>
		${notes ? `<ul class="bucket-notes">${notes}</ul>` : ''}
	</section>`;
}

/** Detail for the Skills tab: counts against the tracked-session denominator. */
export function renderSkillBucketDetail(
	skill: SkillBucketDetail, base: BucketDetail, canDrill: boolean,
): string {
	const share = skill.skillShare === null ? '—' : `${(skill.skillShare * 100).toFixed(0)}%`;
	const change = skill.shareChangePoints === null ? '—'
		: localizeFormat('efficiency.detail.skills.points', `${skill.shareChangePoints > 0 ? '+' : ''}${skill.shareChangePoints.toFixed(0)}`);
	const rows: [string, string][] = [
		['calls', formatNumber(skill.totalCalls)],
		['sessions', formatNumber(skill.skillSessions)],
		['tracked', formatNumber(skill.trackedSessions)],
		['share', share],
		['shareChange', change],
	];
	const top = skill.top.length === 0 ? ''
		: `<p>${escapeHtml(localize('efficiency.detail.skills.top'))} ${skill.top.map(t => `${escapeHtml(t.name)} (${formatNumber(t.calls)})`).join(', ')}</p>`;
	const notes = base.notes.filter(n => n !== 'no-sessions').map(n => `<li>${escapeHtml(noteText(n))}</li>`).join('')
		+ (skill.trackedSessions === 0 ? `<li>${escapeHtml(localize('efficiency.detail.note.noSessions'))}</li>` : '');
	return `<section id="${BUCKET_DETAIL_ID}" class="bucket-detail" role="region" aria-live="polite" aria-label="${escapeHtml(localize('efficiency.detail.regionLabel'))}">
		${headerHtml(base.label, base.startKey, base.endKey, base.partial, canDrill)}
		${rawList(base.raw)}
		<dl class="bucket-raw">${rows.map(([k, v]) => `<div><dt>${escapeHtml(localize(`efficiency.detail.skills.${k}`))}</dt><dd>${escapeHtml(v)}</dd></div>`).join('')}</dl>
		${top}
		${notes ? `<ul class="bucket-notes">${notes}</ul>` : ''}
	</section>`;
}

/** One model's block inside the Models detail. */
function modelBlock(m: ModelBucketDetail | null, name: string, metricLabel: string, unit: BucketMetricUnit, floor: number): string {
	if (!m) {
		return `<div class="bucket-model"><h4>${escapeHtml(name)}</h4><p>${escapeHtml(localizeFormat('efficiency.detail.models.notUsed', name))}</p></div>`;
	}
	const raws: [string, string][] = [
		['sessions', formatNumber(m.sessions)],
		['editTurns', formatNumber(m.editTurns)],
		['tokens', formatCompact(m.tokens)],
		['loc', formatNumber(m.loc)],
		['cost', formatCost(m.cost)],
	];
	const low = m.sampleSufficient ? '' : `<p class="bucket-reason">${escapeHtml(localizeFormat('efficiency.detail.models.lowSample', String(floor)))}</p>`;
	const mix = m.taskMix.length === 0 ? ''
		: `<p>${escapeHtml(localizeFormat('efficiency.detail.models.taskMix', m.taskMix.map(t => `${t.category} ${(t.share * 100).toFixed(0)}%`).join(', ')))}</p>`;
	return `<div class="bucket-model"><h4>${escapeHtml(m.displayName)}</h4>
		<dl class="bucket-raw">${raws.map(([k, v]) => `<div><dt>${escapeHtml(localize(`efficiency.detail.models.${k}`))}</dt><dd>${escapeHtml(v)}</dd></div>`).join('')}</dl>
		<p>${escapeHtml(metricLabel)}: ${escapeHtml(formatBucketValue(m.value, unit))} · ${escapeHtml(localize('efficiency.detail.col.prior'))}: ${escapeHtml(formatBucketValue(m.prior, unit))} · ${escapeHtml(formatBucketChange(m.deltaPct, m.improved))}</p>
		${low}${mix}</div>`;
}

export interface ModelDetailEntry { name: string; detail: ModelBucketDetail | null }

/** Detail for the Models tab: the selected model/period profile with the comparison's caveats kept. */
export function renderModelBucketDetail(
	base: BucketDetail, entries: ModelDetailEntry[], metricLabel: string, unit: BucketMetricUnit, sessionFloor: number, canDrill: boolean,
): string {
	const notes = base.notes.filter(n => n === 'partial' || n === 'no-prior').map(n => `<li>${escapeHtml(noteText(n))}</li>`).join('');
	return `<section id="${BUCKET_DETAIL_ID}" class="bucket-detail" role="region" aria-live="polite" aria-label="${escapeHtml(localize('efficiency.detail.regionLabel'))}">
		${headerHtml(base.label, base.startKey, base.endKey, base.partial, canDrill)}
		<div class="bucket-models">${entries.map(e => modelBlock(e.detail, e.name, metricLabel, unit, sessionFloor)).join('')}</div>
		<ul class="bucket-notes">${notes}<li>${escapeHtml(localize('efficiency.detail.models.mixed'))}</li><li>${escapeHtml(localize('efficiency.detail.models.observational'))}</li></ul>
	</section>`;
}

/** Ordinary button for Month vs Month and Cost Attribution rows. */
export function contextButtonHtml(action: string, target: string, labelKey: string, ariaKey: string, subject: string): string {
	return `<button type="button" class="eff-context-btn" data-ctx="${escapeHtml(action)}" data-target="${escapeHtml(target)}" aria-label="${escapeHtml(localizeFormat(ariaKey, subject))}">${escapeHtml(localize(labelKey))}</button>`;
}
