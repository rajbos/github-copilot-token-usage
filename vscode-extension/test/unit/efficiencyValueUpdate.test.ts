import test from 'node:test';
import * as assert from 'node:assert/strict';
import {
	createEfficiencyWebviewReadyNotifier,
	isValueSignalsPayload,
	type EfficiencyWebviewReadyMessage,
} from '../../src/webview/efficiency/valueUpdate';
import type { ValueSignals } from '../../../src/efficiencyAnalysis';

function signals(overrides: Partial<ValueSignals> = {}): ValueSignals {
	return {
		userPrs: 18, mergedPrs: 14, aiPrs: 3, prsSince: '2026-02-14T00:00:00.000Z', prsPerWeek: 3.5,
		costPerMergedPr: 2.99, applyRate: 0.62, appliedBlocks: 186, totalBlocks: 300,
		locPerDollar: 352.6, linesChanged: 14740, periodCost: 41.8,
		...overrides,
	};
}

test('readiness is announced with the reason the webview reached that point', () => {
	const messages: EfficiencyWebviewReadyMessage[] = [];
	const notifyReady = createEfficiencyWebviewReadyNotifier((message) => messages.push(message));

	notifyReady('listener-registered');
	notifyReady('content-rendered');

	assert.deepEqual(messages, [
		{ command: 'efficiencyWebviewReady', reason: 'listener-registered' },
		{ command: 'efficiencyWebviewReady', reason: 'content-rendered' },
	]);
});

test('isValueSignalsPayload accepts a never-loaded snapshot (null PR counts)', () => {
	assert.ok(isValueSignalsPayload(signals({
		userPrs: null, mergedPrs: null, aiPrs: null, prsSince: null, prsPerWeek: null, costPerMergedPr: null,
	})));
});

test('isValueSignalsPayload rejects payloads that would render as undefined', () => {
	// The postMessage wire is untyped: without this gate a malformed payload replaces real
	// metrics with "undefined" cards.
	assert.equal(isValueSignalsPayload(undefined), false);
	assert.equal(isValueSignalsPayload(null), false);
	assert.equal(isValueSignalsPayload('nope'), false);
	const { mergedPrs: _dropped, ...missingField } = signals();
	assert.equal(isValueSignalsPayload(missingField), false);
	assert.equal(isValueSignalsPayload(signals({ linesChanged: null as unknown as number })), false);
	assert.equal(isValueSignalsPayload(signals({ periodCost: Number.NaN })), false);
	assert.equal(isValueSignalsPayload(signals({ userPrs: '3' as unknown as number })), false);
	assert.equal(isValueSignalsPayload(signals({ prsSince: 12 as unknown as string })), false);
	// An unparseable date would render as "Invalid Date" in the "you opened since …" line.
	assert.equal(isValueSignalsPayload(signals({ prsSince: 'not-a-date' })), false);
	assert.equal(isValueSignalsPayload(signals({ prsSince: '' })), false);
});

test('isValueSignalsPayload accepts the date shapes the host actually sends', () => {
	assert.ok(isValueSignalsPayload(signals({ prsSince: '2026-02-14T00:00:00.000Z' })));
	assert.ok(isValueSignalsPayload(signals({ prsSince: '2026-02-14' })));
});
