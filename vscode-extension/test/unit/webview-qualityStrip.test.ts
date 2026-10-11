import test from 'node:test';
import * as assert from 'node:assert/strict';
import { buildQualityStripHtml, sanitizeAgenticQuality } from '../../src/webview/maturity/qualityStrip';

const comparison = {
	classification: 'faster-but-weaker',
	agenticPerDay: { current: 1.2, previous: 0.5 },
	correctionsPerSession: { current: 0.8, previous: 0.4 },
	oneShotRate: { current: 0.7, previous: 0.8 },
};

test('buildQualityStripHtml: shows the pair of numbers and a warning verdict', () => {
	const html = buildQualityStripHtml(sanitizeAgenticQuality({ comparison }));
	assert.match(html, /id="quality-strip"/);
	assert.match(html, /1\.2/);
	assert.match(html, /last month: 0\.40/);
	assert.match(html, /70%/);
	assert.match(html, /quality-verdict-warn/);
	assert.match(html, /not part of any export/);
	assert.doesNotMatch(html, /btn-show-readiness|outrun the controls/, 'no stretched-repository note any more');
});

test('buildQualityStripHtml: insufficient data explains why, and missing values render as a dash', () => {
	const view = sanitizeAgenticQuality({ comparison: { ...comparison, classification: 'insufficient-data', reason: 'too-early-in-month', oneShotRate: { current: null, previous: null } } });
	const html = buildQualityStripHtml(view);
	assert.match(html, /Too early in the month/);
	assert.match(html, /—/);
});

test('sanitizeAgenticQuality: rejects unknown classifications and invalid numbers', () => {
	assert.equal(sanitizeAgenticQuality({ comparison: { ...comparison, classification: 'great' } }), null);
	assert.equal(sanitizeAgenticQuality(undefined), null);
	assert.equal(sanitizeAgenticQuality({ comparison: { ...comparison, agenticPerDay: { current: -1, previous: 'x' } } })?.comparison.agenticPerDay.current, null);
});
