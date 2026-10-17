import test from 'node:test';
import assert from 'node:assert/strict';
import { timedStep, timedStepSync, SLOW_STEP_LOG_THRESHOLD_MS } from '../../src/stepTimer';

test('a fast step returns its value and logs nothing', async () => {
	const logs: string[] = [];
	assert.equal(timedStepSync(m => logs.push(m), 'fast', () => 7), 7);
	assert.equal(await timedStep(m => logs.push(m), 'fast async', async () => 8), 8);
	assert.deepEqual(logs, []);
});

test('a slow step is logged with its label, and a throwing step still reports and rethrows', async () => {
	const logs: string[] = [];
	await timedStep(m => logs.push(m), 'slow one', () => new Promise<void>(r => setTimeout(r, SLOW_STEP_LOG_THRESHOLD_MS + 30)));
	await assert.rejects(timedStep(m => logs.push(m), 'slow failing', async () => {
		await new Promise(r => setTimeout(r, SLOW_STEP_LOG_THRESHOLD_MS + 30));
		throw new Error('boom');
	}), /boom/);
	assert.equal(logs.length, 2);
	assert.match(logs[0], /slow one took \d+ms/);
	assert.match(logs[1], /slow failing took \d+ms/);
});
