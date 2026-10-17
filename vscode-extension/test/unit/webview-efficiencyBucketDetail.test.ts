import test from 'node:test';
import * as assert from 'node:assert/strict';

import { setFormatLocale } from '../../src/webview/shared/formatUtils';
import { initializeWebviewLocalization } from '../../src/webview/shared/localization';
import {
	BUCKET_DETAIL_ID, BUCKET_DRILL_BUTTON_ID, BUCKET_PICK_ID, bucketPickerHtml, contextButtonHtml, formatBucketChange,
	formatBucketValue, renderBucketDetail, renderBucketDetailPlaceholder, renderModelBucketDetail, renderSkillBucketDetail,
} from '../../src/webview/efficiency/bucketDetail';
import type { BucketDetail } from '../../../src/efficiencyBucketDetail';

setFormatLocale('en-US');

function base(overrides: Partial<BucketDetail> = {}): BucketDetail {
	return {
		key: '2026-07-13', label: 'Jul 13–19', startKey: '2026-07-13', endKey: '2026-07-15', resolution: 'weekly', partial: true,
		raw: { sessions: 3, tokens: 1500, turns: 12, loc: 200, cost: 1.5 },
		metrics: [
			{ id: 'cost-per-kloc', unit: 'currency', goodDirection: 'down', value: null, prior: 4, deltaPct: null, improved: null, unavailable: 'no-loc' },
			{ id: 'retry-rate', unit: 'percent', goodDirection: 'down', value: 12, prior: 20, deltaPct: -40, improved: true, unavailable: null },
		],
		notes: ['partial'],
		...overrides,
	};
}

test('picker: a native labelled select with an explicit selected state and escaped labels', () => {
	initializeWebviewLocalization({});
	const html = bucketPickerHtml([
		{ key: '2026-07-06', label: 'Jul 6–12', startKey: '2026-07-06', endKey: '2026-07-12', resolution: 'weekly' },
		{ key: '2026-07-13', label: '<b>Jul 13</b>', startKey: '2026-07-13', endKey: '2026-07-19', resolution: 'weekly' },
	], '2026-07-13');
	assert.match(html, /<label[^>]*>Selected period <select id="eff-bucket-pick">/);
	assert.match(html, /<option value="2026-07-13" selected>&lt;b&gt;Jul 13&lt;\/b&gt;<\/option>/);
	assert.doesNotMatch(html, /<b>/);
	assert.equal(BUCKET_PICK_ID, 'eff-bucket-pick');
	assert.equal(bucketPickerHtml([], ''), '');
});

test('placeholder: a live region is always present so the selection has somewhere to announce', () => {
	initializeWebviewLocalization({});
	const html = renderBucketDetailPlaceholder();
	assert.match(html, new RegExp(`id="${BUCKET_DETAIL_ID}"[^>]*role="region"[^>]*aria-live="polite"`));
});

test('detail: shows range, raw volumes, null as an em dash with a reason, and the partial note', () => {
	initializeWebviewLocalization({});
	const html = renderBucketDetail(base(), true);
	assert.match(html, /2026-07-13 to 2026-07-15/);
	assert.match(html, /\(in progress\)/);
	assert.match(html, /<dt>Sessions<\/dt><dd>3<\/dd>/);
	assert.match(html, /<dt>Turns<\/dt><dd>12<\/dd>/);
	assert.match(html, /<th scope="row">Cost per 1K lines changed<\/th><td>—\s*<span class="bucket-reason">No lines-of-code data recorded\./);
	assert.match(html, /still in progress/);
	assert.match(html, new RegExp(`id="${BUCKET_DRILL_BUTTON_ID}"`));
	assert.doesNotMatch(renderBucketDetail(base(), false), new RegExp(BUCKET_DRILL_BUTTON_ID));
});

test('change text spells out direction and better/worse instead of relying on colour or arrows', () => {
	initializeWebviewLocalization({});
	assert.equal(formatBucketChange(-40, true), 'down 40% (better)');
	assert.equal(formatBucketChange(12, false), 'up 12% (worse)');
	assert.equal(formatBucketChange(5, null), 'up 5%');
	assert.equal(formatBucketChange(null, null), '—');
	assert.equal(formatBucketValue(null, 'currency'), '—');
	assert.equal(formatBucketValue(12.4, 'percent'), '12%');
});

test('skills detail: raw volume block plus the tracked-session denominator', () => {
	initializeWebviewLocalization({});
	const html = renderSkillBucketDetail({
		key: 'k', label: 'Jul 13–19', totalCalls: 5, skillSessions: 2, trackedSessions: 4, skillShare: 0.5,
		priorSkillShare: 0.25, shareChangePoints: 25, top: [{ name: 'graphify', calls: 5 }],
	}, base(), false);
	assert.match(html, /<dt>Tracked sessions<\/dt><dd>4<\/dd>/);
	assert.match(html, /<dt>Skill share of sessions<\/dt><dd>50%<\/dd>/);
	assert.match(html, /\+25 points/);
	assert.match(html, /graphify \(5\)/);
	assert.match(html, /<dt>Sessions<\/dt><dd>3<\/dd>/);
});

test('models detail: keeps sample-floor, mixed-model and observational caveats; unused model is stated', () => {
	initializeWebviewLocalization({});
	const detail = {
		model: 'm', displayName: 'Model <X>', sessions: 2, sessionShare: 2, editTurns: 12, tokens: 900, cost: 2, loc: 50,
		value: null, prior: 10, deltaPct: null, improved: null, sampleSufficient: false, editSampleSufficient: false,
		taskMix: [{ category: 'debugging', share: 0.6 }],
	};
	const html = renderModelBucketDetail(base(), [{ name: 'Model <X>', detail }, { name: 'Other', detail: null }], 'Retry', 'percent', 5, false);
	assert.match(html, /Model &lt;X&gt;/);
	assert.match(html, /<dt>Edit turns<\/dt><dd>12<\/dd>/);
	assert.match(html, /sample floor of 5 session equivalents/);
	assert.match(html, /debugging 60%/);
	assert.match(html, /Other was not used in this period/);
	assert.match(html, /split across a session’s models by token share/);
	assert.match(html, /observational/);
});

test('context button: an ordinary button carrying its action, with a subject-specific accessible name', () => {
	initializeWebviewLocalization({});
	const html = contextButtonHtml('trend', 'retry-rate', 'efficiency.context.viewTrend', 'efficiency.context.viewTrendAria', 'Edit retry rate');
	assert.match(html, /^<button type="button" class="eff-context-btn" data-ctx="trend" data-target="retry-rate" aria-label="Open the trend chart for Edit retry rate">View trend<\/button>$/);
});
