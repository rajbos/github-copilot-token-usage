import test from 'node:test';
import * as assert from 'node:assert/strict';
import { classifyAutonomy, mergeAutonomyUsage, recordAutonomy } from '../../../src/autonomy';
import { analyzeSessionUsage, createEmptySessionUsageAnalysis, type UsageAnalysisDeps } from '../../../src/usageAnalysis';
import type { AutonomyUsage } from '../../../src/types';

function makeDeps(): UsageAnalysisDeps {
	return {
		warn: () => { /* ignore */ },
		modelPricing: {},
		tokenEstimators: {},
		toolNameMap: {},
		ecosystems: [],
	} as unknown as UsageAnalysisDeps;
}

const jsonl = (events: unknown[]) => events.map(e => JSON.stringify(e)).join('\n');

test('classifyAutonomy maps Copilot and Claude values onto shared buckets', () => {
	assert.equal(classifyAutonomy('autopilot'), 'autonomous');
	assert.equal(classifyAutonomy('auto'), 'autonomous');
	assert.equal(classifyAutonomy('interactive'), 'supervised');
	assert.equal(classifyAutonomy('default'), 'supervised');
	assert.equal(classifyAutonomy('acceptEdits'), 'supervised');
	assert.equal(classifyAutonomy('plan'), 'plan');
	assert.equal(classifyAutonomy('bypassPermissions'), 'other');
	assert.equal(classifyAutonomy('normal'), null);
	assert.equal(classifyAutonomy(undefined), null);
	assert.equal(classifyAutonomy(42), null);
});

test('recordAutonomy leaves autonomyUsage absent when nothing recognised', () => {
	const a: { autonomyUsage?: AutonomyUsage } = {};
	recordAutonomy(a, undefined);
	recordAutonomy(a, 'normal');
	assert.equal(a.autonomyUsage, undefined);
	recordAutonomy(a, 'auto');
	assert.deepEqual(a.autonomyUsage, { autonomous: 1, supervised: 0, plan: 0, other: 0 });
});

test('mergeAutonomyUsage sums sessions and ignores undefined', () => {
	const period: { autonomyUsage?: AutonomyUsage } = {};
	mergeAutonomyUsage(period, undefined);
	assert.equal(period.autonomyUsage, undefined);
	mergeAutonomyUsage(period, { autonomous: 2, supervised: 1, plan: 0, other: 0 });
	mergeAutonomyUsage(period, { autonomous: 1, supervised: 0, plan: 3, other: 1 });
	assert.deepEqual(period.autonomyUsage, { autonomous: 3, supervised: 1, plan: 3, other: 1 });
});

test('Copilot CLI events.jsonl: agentMode on user.message is counted per prompt', async () => {
	const content = jsonl([
		{ type: 'session.start', data: {} },
		{ type: 'user.message', data: { content: 'a', agentMode: 'interactive' } },
		{ type: 'user.message', data: { content: 'b', agentMode: 'autopilot' } },
		{ type: 'user.message', data: { content: 'c', agentMode: 'autopilot' } },
		{ type: 'user.message', data: { content: 'd', agentMode: 'plan' } },
	]);
	const result = await analyzeSessionUsage(makeDeps(), 'session-state/x/events.jsonl', content);
	assert.deepEqual(result.autonomyUsage, { autonomous: 2, supervised: 1, plan: 1, other: 0 });
});

test('VS Code delta session: permissionLevel is tracked across kind 0 and kind 1 updates', async () => {
	const req = (id: string) => ({ requestId: id, message: { text: 'hi' } });
	const content = jsonl([
		{ kind: 0, v: { requests: [], inputState: { mode: { id: 'agent' }, permissionLevel: 'default' } } },
		{ kind: 2, k: ['requests'], v: [req('r1')] },
		{ kind: 1, k: ['inputState', 'permissionLevel'], v: 'autopilot' },
		{ kind: 2, k: ['requests'], v: [req('r2')] },
		{ kind: 2, k: ['requests'], v: [req('r3')] },
	]);
	const result = await analyzeSessionUsage(makeDeps(), 'chatSessions/s.jsonl', content);
	assert.deepEqual(result.autonomyUsage, { autonomous: 2, supervised: 1, plan: 0, other: 0 });
});

test('VS Code delta session without permissionLevel reports no autonomy data', async () => {
	const content = jsonl([
		{ kind: 0, v: { requests: [], inputState: { mode: { id: 'agent' } } } },
		{ kind: 2, k: ['requests'], v: [{ requestId: 'r1', message: { text: 'hi' } }] },
	]);
	const result = await analyzeSessionUsage(makeDeps(), 'chatSessions/s.jsonl', content);
	assert.equal(result.autonomyUsage, undefined);
});

test('empty analysis has no autonomyUsage (optional field)', () => {
	assert.equal(createEmptySessionUsageAnalysis().autonomyUsage, undefined);
});
