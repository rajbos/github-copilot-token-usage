import { describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import { buildRouterSectionHtml, sanitizeRouterPayload } from '../../src/webview/usage/hydraFusionCard';
import { deriveHydraFusionAggregate } from '../../../src/hydrafusion';

const aggregate = deriveHydraFusionAggregate({
	sessions: 2, totalTurns: 4, compoundTurns: 2, judgeAccepts: 1, judgeRejects: 1, escalatedTurns: 1,
	totalAiu: 40, reviewAiu: 10, degradedTurns: 0,
	patternCounts: [{ pattern: 'cascade', turns: 3, aiu: 30 }, { pattern: 'single', turns: 1, aiu: 10 }],
});

describe('sanitizeRouterPayload', () => {
	test('returns undefined for a missing or non-object payload', () => {
		assert.equal(sanitizeRouterPayload(undefined), undefined);
		assert.equal(sanitizeRouterPayload('x'), undefined);
	});

	test('keeps numeric fields, nulls periods without turns and drops unknown keys', () => {
		const out = sanitizeRouterPayload({ last30Days: { ...aggregate, prompt: 'secret' }, today: { totalTurns: 0 }, month: 'bad' })!;
		assert.equal(out.last30Days!.totalTurns, 4);
		assert.equal('prompt' in out.last30Days!, false);
		assert.equal(out.today, null);
		assert.equal(out.month, null);
		assert.equal(out.lastMonth, null);
	});

	test('coerces non-numeric values to zero / null rather than rendering NaN', () => {
		const out = sanitizeRouterPayload({ today: { ...aggregate, totalAiu: 'x', judgeRejectionRatePercent: 'x', aiuPerTurn: undefined } })!;
		assert.equal(out.today!.totalAiu, 0);
		assert.equal(out.today!.judgeRejectionRatePercent, null);
		assert.equal(out.today!.aiuPerTurn, null);
	});
});

describe('buildRouterSectionHtml', () => {
	test('renders nothing when no period has routed turns', () => {
		assert.equal(buildRouterSectionHtml(undefined), '');
		assert.equal(buildRouterSectionHtml({ today: null, last30Days: null }), '');
	});

	test('renders one block per routed period with the headline rates', () => {
		const html = buildRouterSectionHtml({ today: null, last30Days: aggregate });
		assert.match(html, /id="section-router"/);
		assert.match(html, /data-router-period="last30Days"/);
		assert.doesNotMatch(html, /data-router-period="today"/);
		assert.match(html, /HydraFusion Router/);
		assert.match(html, /50\.0%/);
		assert.match(html, /cascade 3 · single 1/);
		assert.match(html, /10\.00/);
	});

	test('shows an em dash when the judge never ran', () => {
		const noJudge = deriveHydraFusionAggregate({ ...aggregate, judgeAccepts: 0, judgeRejects: 0 });
		const html = buildRouterSectionHtml({ today: noJudge });
		assert.match(html, /Judge rejection rate<\/div><div class="stat-value">—</);
	});

	test('escapes pattern names', () => {
		const evil = { ...aggregate, patternCounts: [{ pattern: '<img onerror=x>', turns: 1, aiu: 1 }] };
		const html = buildRouterSectionHtml({ today: evil });
		assert.doesNotMatch(html, /<img/);
	});
});
