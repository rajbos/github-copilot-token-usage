import test from 'node:test';
import * as assert from 'node:assert/strict';
import { INSIGHT_CARD_ID_PREFIX, insightCardElementId, isInsightCardAnchor } from '../../src/insightAnchors';

// The extension host builds the anchor it sends with `switchTab`; the webview stamps the same id
// onto the card it renders. If the two ever disagree the scroll silently no-ops and the user is
// dropped at the top of the Insights tab — exactly the bug this module exists to prevent.

test('insightCardElementId: derives a card id from an insight id', () => {
	assert.equal(insightCardElementId('marathon-session-today'), 'insight-card-marathon-session-today');
	assert.equal(insightCardElementId('stale-skills'), `${INSIGHT_CARD_ID_PREFIX}stale-skills`);
});

test('insightCardElementId: distinct insights get distinct card ids', () => {
	assert.notEqual(insightCardElementId('a'), insightCardElementId('b'));
});

test('isInsightCardAnchor: recognizes card anchors and rejects static section anchors', () => {
	assert.equal(isInsightCardAnchor(insightCardElementId('unused-mcp-servers')), true);
	assert.equal(isInsightCardAnchor('section-tool-curation'), false);
	assert.equal(isInsightCardAnchor('section-model-efficiency'), false);
	assert.equal(isInsightCardAnchor(''), false);
});
