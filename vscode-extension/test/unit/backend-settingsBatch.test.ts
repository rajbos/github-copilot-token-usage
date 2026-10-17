import test from 'node:test';
import * as assert from 'node:assert/strict';

import { applySettingsAtomically, deferWhileApplyingSettings } from '../../src/backend/settingsBatch';

test('deferWhileApplyingSettings: runs immediately (returns false) outside a batch', () => {
	assert.equal(deferWhileApplyingSettings(() => { throw new Error('must not be called by the helper'); }), false);
});

test('applySettingsAtomically: defers reactions and runs only the last one, once, after the batch', async () => {
	const ran: string[] = [];
	await applySettingsAtomically(async () => {
		assert.equal(deferWhileApplyingSettings(() => ran.push('first')), true);
		assert.equal(deferWhileApplyingSettings(() => ran.push('second')), true);
		assert.deepEqual(ran, [], 'nothing runs while settings are still being written');
	});
	assert.deepEqual(ran, ['second']);
});

test('applySettingsAtomically: nested batches flush only when the outermost one ends', async () => {
	const ran: string[] = [];
	await applySettingsAtomically(async () => {
		await applySettingsAtomically(async () => { deferWhileApplyingSettings(() => ran.push('inner')); });
		assert.deepEqual(ran, []);
	});
	assert.deepEqual(ran, ['inner']);
});

test('applySettingsAtomically: still flushes and rethrows when a write fails', async () => {
	const ran: string[] = [];
	await assert.rejects(applySettingsAtomically(async () => {
		deferWhileApplyingSettings(() => ran.push('react'));
		throw new Error('write failed');
	}), /write failed/);
	assert.deepEqual(ran, ['react'], 'a partially applied save still gets its sync');
	assert.equal(deferWhileApplyingSettings(() => undefined), false, 'the batch is closed afterwards');
});

test('applySettingsAtomically: returns the write result', async () => {
	assert.equal(await applySettingsAtomically(async () => 42), 42);
});
