/**
 * DOM anchors for insight cards.
 *
 * Shared between the extension host (which asks the Usage Analysis webview to scroll to a
 * specific insight after a toast or status-bar click) and the webview (which stamps the id
 * onto the rendered card). Kept in its own dependency-free module so both sides agree on the
 * exact id without the webview bundle pulling in the whole insights engine.
 */

/** Prefix for the DOM id of an insight card in the Insights tab. */
export const INSIGHT_CARD_ID_PREFIX = 'insight-card-';

/** DOM id of the Insights-tab card rendered for `insightId`. */
export function insightCardElementId(insightId: string): string {
	return `${INSIGHT_CARD_ID_PREFIX}${insightId}`;
}

/** True when a switchTab anchor points at an insight card rather than a static section. */
export function isInsightCardAnchor(anchor: string): boolean {
	return anchor.startsWith(INSIGHT_CARD_ID_PREFIX);
}
