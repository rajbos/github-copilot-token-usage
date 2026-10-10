/**
 * Unit tests for Windsurf (Cascade) token / user-turn extraction
 * (src/windsurf.ts).
 *
 * Token usage lives on CORTEX_STEP_TYPE_PLANNER_RESPONSE steps as string-encoded
 * integers (cumulativeTokensAtStep / inputTokens / cacheReadTokens). User turns are
 * the count of CORTEX_STEP_TYPE_USER_INPUT steps. These tests pin that behaviour.
 */
import test from 'node:test';
import * as assert from 'node:assert/strict';

import { WindsurfDataAccess, type WindsurfHost } from '../windsurf';

const extUri = { fsPath: '/mock/ext', path: '/mock/ext', scheme: 'file' };
// Mutable host double: tests flip `appName` to simulate running inside Windsurf / Devin / VS Code.
const hostState = { appName: 'Visual Studio Code' };
const host: WindsurfHost = {
	getAppName: () => hostState.appName,
	getExtension: () => undefined,
	isEnabled: () => true,
};
const windsurf = new WindsurfDataAccess(extUri, undefined, host);

const plannerStep = (meta: Record<string, string>) => ({
	type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
	metadata: meta,
});
const userStep = () => ({ type: 'CORTEX_STEP_TYPE_USER_INPUT', metadata: {} });
const otherStep = (type: string) => ({ type, metadata: {} });

// ----- extractTokenUsage -----

test('extractTokenUsage: totalTokens is the max cumulativeTokensAtStep across planner steps', () => {
	const steps = [
		userStep(),
		plannerStep({ cumulativeTokensAtStep: '4200', inputTokens: '4000', cacheReadTokens: '100' }),
		otherStep('CORTEX_STEP_TYPE_TOOL_CALL'),
		plannerStep({ cumulativeTokensAtStep: '10417', inputTokens: '8717', cacheReadTokens: '1152' }),
	] as any;

	const usage = windsurf.extractTokenUsage(steps);
	assert.equal(usage.totalTokens, 10417);
	assert.equal(usage.inputTokens, 4000 + 8717);
	assert.equal(usage.cachedTokens, 100 + 1152);
});

test('extractTokenUsage: ignores non-planner steps entirely', () => {
	const steps = [
		userStep(),
		otherStep('CORTEX_STEP_TYPE_RETRIEVE_MEMORY'),
		otherStep('CORTEX_STEP_TYPE_USER_INPUT'),
	] as any;

	const usage = windsurf.extractTokenUsage(steps);
	assert.deepEqual(usage, { totalTokens: 0, inputTokens: 0, cachedTokens: 0 });
});

test('extractTokenUsage: tolerates planner steps missing some token fields', () => {
	const steps = [
		plannerStep({ cumulativeTokensAtStep: '11027' }), // no inputTokens / cacheReadTokens
		plannerStep({ inputTokens: '500' }), // no cumulativeTokensAtStep
	] as any;

	const usage = windsurf.extractTokenUsage(steps);
	assert.equal(usage.totalTokens, 11027);
	assert.equal(usage.inputTokens, 500);
	assert.equal(usage.cachedTokens, 0);
});

test('extractTokenUsage: rejects malformed / non-integer strings instead of partial-parsing', () => {
	const steps = [
		plannerStep({ cumulativeTokensAtStep: '123abc', inputTokens: '1.2e4', cacheReadTokens: '-50' }),
		plannerStep({ cumulativeTokensAtStep: '9000' }),
	] as any;

	const usage = windsurf.extractTokenUsage(steps);
	// '123abc', '1.2e4' and '-50' are all rejected (no silent parseInt truncation / negatives)
	assert.equal(usage.totalTokens, 9000);
	assert.equal(usage.inputTokens, 0);
	assert.equal(usage.cachedTokens, 0);
});

test('extractTokenUsage: handles missing metadata and empty input', () => {
	assert.deepEqual(windsurf.extractTokenUsage([]), { totalTokens: 0, inputTokens: 0, cachedTokens: 0 });
	const steps = [{ type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE' }] as any;
	assert.deepEqual(windsurf.extractTokenUsage(steps), { totalTokens: 0, inputTokens: 0, cachedTokens: 0 });
});

// ----- countUserTurns -----

test('countUserTurns: counts only CORTEX_STEP_TYPE_USER_INPUT steps', () => {
	const steps = [
		userStep(),
		plannerStep({ cumulativeTokensAtStep: '100' }),
		otherStep('CORTEX_STEP_TYPE_TOOL_CALL'),
		userStep(),
		userStep(),
	] as any;

	assert.equal(windsurf.countUserTurns(steps), 3);
});

test('countUserTurns: returns 0 when there are no user-input steps', () => {
	const steps = [plannerStep({ cumulativeTokensAtStep: '100' }), otherStep('CORTEX_STEP_TYPE_TOOL_CALL')] as any;
	assert.equal(windsurf.countUserTurns(steps), 0);
	assert.equal(windsurf.countUserTurns([]), 0);
});

// ----- getAllTrajectorySteps (step_offset pagination) -----

/**
 * Test double that serves canned step pages keyed by offset, recording the offsets
 * requested. Lets us exercise the pagination loop without a live Windsurf API.
 */
class PagingWindsurf extends WindsurfDataAccess {
	requestedOffsets: number[] = [];
	constructor(private pages: Array<Array<{ type: string }>>, private ignoreOffset = false) {
		super(extUri);
	}
	async getCascadeTrajectorySteps(_cascadeId: string, stepOffset = 0): Promise<any> {
		this.requestedOffsets.push(stepOffset);
		if (this.ignoreOffset) {
			// Simulate a server that ignores step_offset and always returns page 0.
			return { steps: this.pages[0] };
		}
		// Find the page whose starting index matches the requested offset.
		let acc = 0;
		for (const page of this.pages) {
			if (acc === stepOffset) { return { steps: page }; }
			acc += page.length;
		}
		return { steps: [] };
	}
}

test('getAllTrajectorySteps: accumulates all pages via increasing step_offset', async () => {
	const pages = [
		[{ type: 'A' }, { type: 'B' }, { type: 'C' }],
		[{ type: 'D' }, { type: 'E' }],
		[{ type: 'F' }],
	];
	const wd = new PagingWindsurf(pages);
	const all = await wd.getAllTrajectorySteps('cid', 6);
	assert.equal(all.length, 6);
	assert.deepEqual(all.map((s) => (s as any).type), ['A', 'B', 'C', 'D', 'E', 'F']);
	assert.deepEqual(wd.requestedOffsets, [0, 3, 5]);
});

test('getAllTrajectorySteps: stops once expectedCount is reached', async () => {
	const pages = [
		[{ type: 'A' }, { type: 'B' }],
		[{ type: 'C' }, { type: 'D' }],
	];
	const wd = new PagingWindsurf(pages);
	const all = await wd.getAllTrajectorySteps('cid', 2);
	assert.equal(all.length, 2); // does not fetch the second page
	assert.deepEqual(wd.requestedOffsets, [0]);
});

test('getAllTrajectorySteps: guards against a server that ignores step_offset (no duplicate accumulation)', async () => {
	const pages = [[{ type: 'A' }, { type: 'B' }]];
	const wd = new PagingWindsurf(pages, /* ignoreOffset */ true);
	const all = await wd.getAllTrajectorySteps('cid', 10);
	// Without the guard this would loop to maxPages accumulating duplicates; the
	// repeated-first-step guard stops after the second identical page.
	assert.equal(all.length, 2);
	assert.deepEqual(all.map((s) => (s as any).type), ['A', 'B']);
});

test('getAllTrajectorySteps: returns empty when the first page is empty', async () => {
	const wd = new PagingWindsurf([[]]);
	const all = await wd.getAllTrajectorySteps('cid', 0);
	assert.equal(all.length, 0);
});

// ----- buildModelUsage -----

test('buildModelUsage: maps Windsurf input+cache into ModelUsage and derives output', () => {
	// inputTokens is uncached; cachedTokens is cache reads; total excludes cache.
	const usage = { totalTokens: 149612, inputTokens: 18141, cachedTokens: 1872656 };
	const mu = windsurf.buildModelUsage(usage, 'claude-sonnet-4-5');
	const entry = mu['Claude Sonnet 4.5'];
	assert.ok(entry, 'expected the model display name as the key');
	// ModelUsage.inputTokens is TOTAL input incl. cache reads.
	assert.equal(entry.inputTokens, 18141 + 1872656);
	assert.equal(entry.cachedReadTokens, 1872656);
	// output = total - uncached input.
	assert.equal(entry.outputTokens, 149612 - 18141);
});

test('buildModelUsage: clamps output to 0 when inputTokens exceeds totalTokens', () => {
	const usage = { totalTokens: 100, inputTokens: 500, cachedTokens: 0 };
	const mu = windsurf.buildModelUsage(usage, 'gpt-4o');
	assert.equal(mu['GPT-4o'].outputTokens, 0);
});

test('buildModelUsage: falls back to a "Windsurf" key when the model UID is missing', () => {
	const usage = { totalTokens: 10, inputTokens: 4, cachedTokens: 0 };
	const mu = windsurf.buildModelUsage(usage, undefined);
	assert.ok(mu['Windsurf'], 'expected a Windsurf fallback key');
	assert.equal(mu['Windsurf'].outputTokens, 6);
});

// ----- countToolCalls -----

test('countToolCalls: counts only action steps, grouped by friendly tool name', () => {
	const steps = [
		userStep(),
		plannerStep({ cumulativeTokensAtStep: '100' }),
		otherStep('CORTEX_STEP_TYPE_CODE_ACTION'),
		otherStep('CORTEX_STEP_TYPE_CODE_ACTION'),
		otherStep('CORTEX_STEP_TYPE_RUN_COMMAND'),
		otherStep('CORTEX_STEP_TYPE_CHECKPOINT'), // not a tool
		otherStep('CORTEX_STEP_TYPE_ERROR_MESSAGE'), // not a tool
		otherStep('CORTEX_STEP_TYPE_GREP_SEARCH'),
	] as any;

	const result = windsurf.countToolCalls(steps);
	assert.equal(result.total, 4);
	assert.deepEqual(result.byTool, { 'Edit file': 2, 'Run command': 1, 'Grep search': 1 });
});

test('countToolCalls: returns an empty breakdown when there are no tool steps', () => {
	const steps = [userStep(), plannerStep({ cumulativeTokensAtStep: '100' })] as any;
	assert.deepEqual(windsurf.countToolCalls(steps), { total: 0, byTool: {} });
});


// ----- Devin (Cognition Labs desktop IDE — fork/rebrand of Windsurf) support -----
// Devin bundles the same codeium.windsurf extension and shares the exact same
// ~/.codeium/windsurf/cascade storage. It is distinguished only by vscode.env.appName
// and by the devin://trajectory/{id} virtual-path scheme used for live API sessions.

test('isRunningInDevin: true only when appName contains "devin"', () => {
	try {
		hostState.appName = 'Devin';
		assert.equal(windsurf.isRunningInDevin(), true);
		assert.equal(windsurf.isRunningInWindsurf(), false);

		hostState.appName = 'Windsurf';
		assert.equal(windsurf.isRunningInDevin(), false);
		assert.equal(windsurf.isRunningInWindsurf(), true);

		hostState.appName = 'Visual Studio Code';
		assert.equal(windsurf.isRunningInDevin(), false);
		assert.equal(windsurf.isRunningInWindsurf(), false);
	} finally {
		hostState.appName = 'Visual Studio Code';
	}
});

test('isRunningInWindsurfFamily: true for either Windsurf or Devin, false otherwise', () => {
	try {
		hostState.appName = 'Devin';
		assert.equal(windsurf.isRunningInWindsurfFamily(), true);

		hostState.appName = 'Windsurf';
		assert.equal(windsurf.isRunningInWindsurfFamily(), true);

		hostState.appName = 'Visual Studio Code';
		assert.equal(windsurf.isRunningInWindsurfFamily(), false);
	} finally {
		hostState.appName = 'Visual Studio Code';
	}
});

test('isWindsurfSessionFile: recognises both windsurf:// and devin:// trajectory schemes', () => {
	assert.equal(windsurf.isWindsurfSessionFile('windsurf://trajectory/abc123'), true);
	assert.equal(windsurf.isWindsurfSessionFile('devin://trajectory/abc123'), true);
	assert.equal(windsurf.isWindsurfSessionFile('/some/other/path.json'), false);
});

test('getFamilyEditorName: labels sessions per their virtual-path scheme', () => {
	assert.equal(windsurf.getFamilyEditorName('devin://trajectory/abc123'), 'Devin');
	assert.equal(windsurf.getFamilyEditorName('windsurf://trajectory/abc123'), 'Windsurf');
});

test('extractTrajectoryId: strips either windsurf:// or devin:// trajectory prefix', () => {
	assert.equal(windsurf.extractTrajectoryId('windsurf://trajectory/abc123'), 'abc123');
	assert.equal(windsurf.extractTrajectoryId('devin://trajectory/abc123'), 'abc123');
});