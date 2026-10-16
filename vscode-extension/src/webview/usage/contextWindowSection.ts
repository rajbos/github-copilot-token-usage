import { escapeHtml, formatFixed, formatNumber } from '../shared/formatUtils';
import { localize, localizeFormat } from '../shared/localization';
import { getWindowData } from '../../../../src/webview/shared/dataLoader';
import { getModelDisplayName } from '../../../../src/webview/shared/modelUtils';
import { getLongContextInfo } from '../../../../src/tokenEstimation';
import type { AutomaticCompactionStats, ContextPressureStats, ContextWindowStats, ModelPricing } from '../../../../src/types';
import { CONTEXT_NEAR_LIMIT_RATIO } from '../../../../src/types';
import { hasContextWindowData } from './contextWindowSanitizer';

type ContextPeriod = { contextWindow?: ContextWindowStats; contextPressure?: ContextPressureStats };

/** The slice of the usage stats this section reads. */
export interface ContextWindowSectionStats {
	today: ContextPeriod;
	last30Days: ContextPeriod;
	lastMonth: ContextPeriod;
	autoCompactionsLast7Days?: AutomaticCompactionStats;
}

/** The near-limit threshold as a whole percentage, for display in copy. */
export const NEAR_LIMIT_PERCENT = Math.round(CONTEXT_NEAR_LIMIT_RATIO * 100);

const _modelPricingData = getWindowData<{ pricing: Record<string, ModelPricing> }>('__MODEL_PRICING__');
const MODEL_PRICING_MAP: Record<string, ModelPricing> = _modelPricingData?.pricing ?? {};

/** Long-context tier info for a set of models — smallest threshold wins. */
function _tierInfoForModels(models: string[]): { thresholdTokens: number; defaultInputCostPerMillion: number; longContextInputCostPerMillion: number; model: string } | null {
	let best: { thresholdTokens: number; defaultInputCostPerMillion: number; longContextInputCostPerMillion: number; model: string } | null = null;
	for (const model of models) {
		const info = getLongContextInfo(model, MODEL_PRICING_MAP);
		if (info && (!best || info.thresholdTokens < best.thresholdTokens)) {
			best = { ...info, model };
		}
	}
	return best;
}

/** "how much repo fits" estimate: ~4 characters per token, ~40 characters per source line. */
function _defaultTierCapacityText(thresholdTokens: number): string {
	const mb = (thresholdTokens * 4) / (1024 * 1024);
	const lines = Math.round(thresholdTokens / 10 / 1000);
	return `≈${formatFixed(mb, 1)} MB of code (~${formatNumber(lines)}K lines)`;
}

function _renderContextWindowBar(maxTokens: number, tier: { thresholdTokens: number; defaultInputCostPerMillion: number; longContextInputCostPerMillion: number; model: string }): string {
	const pct = (maxTokens / tier.thresholdTokens) * 100;
	const fillPct = Math.min(pct, 100);
	const color = pct > 100 ? 'var(--error-color, #f14c4c)' : pct >= 70 ? 'var(--warning-color, #cca700)' : 'var(--success-color, #89d185)';
	const modelName = escapeHtml(getModelDisplayName(tier.model));
	const rateNote = `above it, input billing goes $${tier.defaultInputCostPerMillion.toFixed(2)} → $${tier.longContextInputCostPerMillion.toFixed(2)} per 1M tokens`;
	return `
		<div style="margin-top: 12px;">
			<div style="display:flex; justify-content:space-between; font-size:12px; color:var(--text-secondary); margin-bottom:4px;">
				<span>${formatNumber(maxTokens)} tokens — ${formatFixed(pct, 0)}% of the ${formatNumber(tier.thresholdTokens)}-token default tier for ${modelName}</span>
				<span>${formatNumber(tier.thresholdTokens)}</span>
			</div>
			<div style="height:8px; border-radius:4px; background:var(--border-subtle); overflow:hidden;">
				<div style="height:100%; width:${formatFixed(fillPct, 0)}%; background:${color}; border-radius:4px;"></div>
			</div>
			<div style="font-size:11px; color:var(--text-muted); margin-top:4px;">Default tier fits ${_defaultTierCapacityText(tier.thresholdTokens)}; ${rateNote}.</div>
		</div>`;
}

/** One labelled value line inside a context-window period column. */
function _cwRow(label: string, value: string, subNote?: string, labelTitle?: string): string {
	const titleAttr = labelTitle ? ` title="${labelTitle}"` : '';
	return `
		<div style="margin-bottom: 10px;">
			<div style="font-size: 12px; font-weight: 600; color: var(--text-secondary); margin-bottom: 2px;"${titleAttr}>${label}</div>
			<div style="font-size: 13px; color: var(--text-primary);">${value}</div>
			${subNote ? `<div style="font-size: 11px; color: var(--text-secondary); margin-top: 2px; line-height: 1.4;">${subNote}</div>` : ''}
		</div>`;
}

/** Largest-request row for one period column (empty string when the period has none). */
function _cwLargestRequestRow(cw: ContextWindowStats): string {
	if (cw.maxRequestInputTokens <= 0) { return ''; }
	const tier = _tierInfoForModels(cw.maxRequestModels);
	const modelsLabel = escapeHtml(cw.maxRequestModels.map(m => getModelDisplayName(m)).join(', ') || '—');
	const thresholdNote = tier
		? `${formatFixed((cw.maxRequestInputTokens / tier.thresholdTokens) * 100, 0)}% of the ${formatNumber(tier.thresholdTokens)}-token price line · ${modelsLabel}`
		: `${modelsLabel} — no long-context surcharge for ${cw.maxRequestModels.length > 1 ? 'these models' : 'this model'}`;
	return _cwRow('📏 Largest request', `${formatNumber(cw.maxRequestInputTokens)} input tokens`, thresholdNote,
		'The biggest single prompt (input incl. cached tokens) sent to a model in one request during this period');
}

/** Fullest-CLI-window row for one period column (empty string when unavailable). */
function _cwFullestWindowRow(cw: ContextWindowStats): string {
	if ((cw.maxReachedTokens ?? 0) <= 0) { return ''; }
	const limit = cw.maxReachedWindowLimit;
	const value = limit
		? `${formatNumber(cw.maxReachedTokens!)} of ${formatNumber(limit)} (${formatFixed((cw.maxReachedTokens! / limit) * 100, 0)}%)`
		: formatNumber(cw.maxReachedTokens!);
	return _cwRow('🪟 Fullest CLI window', value, undefined,
		'The highest context fill recorded for a Copilot CLI session in this period, versus its window limit');
}

/** Per-session context-exhaustion rows for one period column (empty when unavailable). */
function _cwPressureRows(cp: ContextPressureStats | undefined): string {
	if (!cp) { return ''; }
	const compactedRow = cp.sessionsConsidered > 0
		? _cwRow(localize('usage.contextPressure.compactedLabel'),
			localizeFormat('usage.contextPressure.ofCount', formatNumber(cp.sessionsCompacted), formatNumber(cp.sessionsConsidered)),
			cp.sessionsCompacted > 0
				? localizeFormat('usage.contextPressure.compactedShare', formatFixed((cp.sessionsCompacted / cp.sessionsConsidered) * 100, 0))
				: localize('usage.contextPressure.noneCompacted'),
			localize('usage.contextPressure.compactedTooltip'))
		: '';
	const nearRow = cp.sessionsWithFillData > 0
		? _cwRow(localize('usage.contextPressure.nearLimitLabel'),
			localizeFormat('usage.contextPressure.ofCount', formatNumber(cp.sessionsNearLimit), formatNumber(cp.sessionsWithFillData)),
			cp.worstFillPercent
				? localizeFormat('usage.contextPressure.worstFill', cp.worstFillPercent)
				: undefined,
			localizeFormat('usage.contextPressure.nearLimitTooltip', NEAR_LIMIT_PERCENT))
		: '';
	return compactedRow + nearRow;
}

/** Renders one period column of the context-window section. */
function renderContextWindowPeriodHtml(cw: ContextWindowStats | undefined, cp?: ContextPressureStats): string {
	const hasWindowData = hasContextWindowData(cw);
	const pressureRows = _cwPressureRows(cp);
	if (!hasWindowData && !pressureRows) { return '<div style="color: var(--text-muted); font-size: 11px;">No data</div>'; }
	if (!hasWindowData) { return pressureRows; }
	const tierEntries = Object.entries(cw!.tierCounts);
	const tierSessionCount = tierEntries.reduce((sum, [, c]) => sum + c, 0);
	const tierRow = tierEntries.length > 0
		? _cwRow('🪜 Context tiers', tierEntries.map(([t, c]) => `${escapeHtml(t)} ×${c}`).join(', '),
			`${tierSessionCount} Copilot CLI session${tierSessionCount === 1 ? '' : 's'} grouped by chosen window size — "default" is the standard window at normal rates; larger tiers unlock more context at long-context prices`,
			'Copilot CLI lets you pick a context-window tier per session; the count shows how many sessions used each tier')
		: '';
	return _cwLargestRequestRow(cw!) + _cwFullestWindowRow(cw!) + tierRow + pressureRows;
}

function renderAutomaticCompactions(stats: AutomaticCompactionStats | undefined): string {
	if (!stats) { return ''; }
	const sources: Array<[string, number]> = [
		['GitHub Copilot CLI', stats.bySource.copilotCli],
		['Claude', stats.bySource.claude],
	];
	const entries = sources.filter(([, count]) => count > 0)
		.map(([source, count]) => `${escapeHtml(source)} ×${formatNumber(count)}`);
	const breakdown = entries.length > 0
		? entries.join(', ')
		: 'No automatic compactions detected';
	return `
		<h4 class="ctx-window-subheading">${escapeHtml(localize('usage.contextWindow.compactionHeading'))}</h4>
		<div class="automatic-compactions-card"
			title="Automatic compactions remove earlier messages to fit the context window and can affect response quality.">
			<div>
				<div class="automatic-compactions-label">↩ Automatic compactions (last 7 days)</div>
				<div class="automatic-compactions-detail">${breakdown}</div>
			</div>
			<div class="automatic-compactions-value">${formatNumber(stats.total)}</div>
		</div>`;
}

/**
 * Context band section: largest request per period vs the long-context pricing threshold,
 * fullest CLI window, context tiers used, and the automatic compactions that context pressure
 * forced over the last 7 days.
 */
export function buildContextWindowSectionHtml(stats: ContextWindowSectionStats): string {
	const cw30 = stats.last30Days.contextWindow;
	const tier30 = cw30 && cw30.maxRequestInputTokens > 0 ? _tierInfoForModels(cw30.maxRequestModels) : null;
	const bar = cw30 && tier30 ? _renderContextWindowBar(cw30.maxRequestInputTokens, tier30) : '';
	return `
		<div class="section" id="section-context-window">
			<div class="section-title"><span>🪟</span><span>Context Window &amp; Long-Context Pricing</span></div>
			<div class="section-subtitle">How close your largest requests come to the long-context price line. Models with tiered pricing bill higher input rates once a request exceeds their default-tier threshold.</div>
			<div class="three-column">
				<div>
					<h4 style="color: var(--text-primary); font-size: 13px; margin-bottom: 8px;">📅 Today</h4>
					${renderContextWindowPeriodHtml(stats.today.contextWindow, stats.today.contextPressure)}
				</div>
				<div>
					<h4 style="color: var(--text-primary); font-size: 13px; margin-bottom: 8px;">📆 Last 30 Days</h4>
					${renderContextWindowPeriodHtml(cw30, stats.last30Days.contextPressure)}
				</div>
				<div>
					<h4 style="color: var(--text-primary); font-size: 13px; margin-bottom: 8px;">📅 Previous Month</h4>
					${renderContextWindowPeriodHtml(stats.lastMonth.contextWindow, stats.lastMonth.contextPressure)}
				</div>
			</div>
			${bar}
			${renderAutomaticCompactions(stats.autoCompactionsLast7Days)}
		</div>`;
}
