// Pure text builders for the Efficiency view's Cost Attribution bars.
// Kept out of `main.ts` (which grabs the VS Code webview API on import) so the
// exact tooltip text can be asserted in unit tests without a DOM.
import { formatCost, formatNumber, formatSignedCostPrecise } from '../shared/formatUtils';
import { localizeFormat } from '../shared/localization';

/** How a factor's two compared values should be rendered. */
export type AttributionValueKind = 'count' | 'tokens' | 'rate';

/** One Cost Attribution factor: what moved, from what to what, and what it cost. */
export interface AttributionFactor {
	/**
	 * Localization key of the headline line, a template taking the previous and
	 * current value — e.g. `Session count: {0} → {1} sessions`. The measure and
	 * its unit live inside the template so a translation can reorder or re-word
	 * both, rather than being concatenated around fixed English.
	 */
	headlineKey: string;
	/** Value in the earlier window. */
	prev: number;
	/** Value in the later window. */
	cur: number;
	kind: AttributionValueKind;
	/** Signed dollar amount this factor contributed to the cost change. */
	effect: number;
}

/** Locale-aware rendering of one compared value, by what it measures. */
function formatAttributionValue(value: number, kind: AttributionValueKind): string {
	switch (kind) {
		case 'rate': return formatCost(value);
		// Token counts are fractional averages; a "tokens/session" reading with
		// decimals is noise, so round before grouping.
		case 'tokens': return formatNumber(Math.round(value));
		case 'count': return formatNumber(value);
	}
}

/**
 * Plain-text tooltip for one Cost Attribution bar: the factor's previous and
 * current value with their unit, then the signed dollar effect at full
 * precision so a sub-cent movement stays legible instead of collapsing to
 * "$0.00". Returns unescaped text — the caller escapes it into the attribute.
 */
export function buildAttributionTooltip(factor: AttributionFactor): string {
	const prev = formatAttributionValue(factor.prev, factor.kind);
	const cur = formatAttributionValue(factor.cur, factor.kind);
	const effect = formatSignedCostPrecise(factor.effect);
	const headline = localizeFormat(factor.headlineKey, prev, cur);
	return `${headline}\n${localizeFormat('efficiency.attribution.costEffectLine', effect)}`;
}
