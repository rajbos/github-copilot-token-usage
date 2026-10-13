import test from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { computeAnalysisPoolSize, decideAnalysisPool } from '../../src/analysis/poolConfig';
import { ExclusiveRunner } from '../../src/analysis/exclusiveRunner';
import { createThreadWorker } from '../../src/analysis/analysisWorkerPool';

const EXTENSION_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const ANALYSIS_SRC = path.join(EXTENSION_ROOT, 'src', 'analysis');

test('pool size leaves a core for the host and is capped at two, with a floor of one', () => {
	assert.equal(computeAnalysisPoolSize(1), 1);
	assert.equal(computeAnalysisPoolSize(2), 1);
	assert.equal(computeAnalysisPoolSize(3), 2);
	assert.equal(computeAnalysisPoolSize(8), 2);
	assert.equal(computeAnalysisPoolSize(0), 1);
	assert.equal(computeAnalysisPoolSize(Number.NaN), 1);
	assert.equal(computeAnalysisPoolSize(undefined as unknown as number), 1);
});

test('worker threads are started with an empty execArgv so host node flags are not inherited', () => {
	const calls: Array<{ file: unknown; options: Record<string, unknown> }> = [];
	class FakeWorkerCtor {
		constructor(file: unknown, options: Record<string, unknown>) { calls.push({ file, options }); }
	}
	createThreadWorker('/x/analysisWorker.js', { extensionPath: '/ext' }, FakeWorkerCtor as never);
	assert.equal(calls.length, 1);
	assert.equal(calls[0].file, '/x/analysisWorker.js');
	assert.deepEqual(calls[0].options.execArgv, []);
	assert.deepEqual(calls[0].options.workerData, { extensionPath: '/ext' });
});

test('the disable switch and a missing bundle both select the in-process path', () => {
	assert.deepEqual(decideAnalysisPool({ disableEnv: '1', bundleExists: true }), { use: false, reason: 'disabled' });
	assert.deepEqual(decideAnalysisPool({ disableEnv: '1', bundleExists: false }), { use: false, reason: 'disabled' });
	assert.deepEqual(decideAnalysisPool({ disableEnv: undefined, bundleExists: false }), { use: false, reason: 'missing-bundle' });
	assert.deepEqual(decideAnalysisPool({ disableEnv: undefined, bundleExists: true }), { use: true });
	assert.deepEqual(decideAnalysisPool({ disableEnv: '0', bundleExists: true }), { use: true });
});

test('ExclusiveRunner runs overlapping tasks strictly one after another, in call order', async () => {
	const runner = new ExclusiveRunner();
	const events: string[] = [];
	let active = 0;
	let maxActive = 0;
	const task = (name: string, delayMs: number) => async () => {
		active++; maxActive = Math.max(maxActive, active);
		events.push(`start ${name}`);
		await new Promise((r) => setTimeout(r, delayMs));
		events.push(`end ${name}`);
		active--;
		return name;
	};
	const results = await Promise.all([runner.run(task('a', 20)), runner.run(task('b', 1)), runner.run(task('c', 5))]);
	assert.deepEqual(results, ['a', 'b', 'c']);
	assert.equal(maxActive, 1);
	assert.deepEqual(events, ['start a', 'end a', 'start b', 'end b', 'start c', 'end c']);
});

test('a rejected task does not wedge the chain and only fails its own caller', async () => {
	const runner = new ExclusiveRunner();
	const failing = runner.run(async () => { throw new Error('boom'); });
	const next = runner.run(async () => 'ok');
	await assert.rejects(failing, /boom/);
	assert.equal(await next, 'ok');
	assert.equal(await runner.run(async () => 'later'), 'later');
});

test('the vscode stub throws on any use, but tolerates the __esModule probe', () => {
	// eslint-disable-next-line @typescript-eslint/no-require-imports
	const stub = require('../../src/analysis/vscodeStub') as Record<string, unknown>;
	assert.throws(() => stub.window, /VS Code API is not available/);
	assert.throws(() => stub.workspace, /VS Code API is not available/);
	assert.equal(stub.__esModule, false);
});

test('nothing under src/analysis imports vscode except through the stub alias', () => {
	const offenders: string[] = [];
	const importRe = /(?:from\s+|import\s*\(\s*|require\s*\(\s*|import\s+)['"]vscode['"]/;
	for (const file of fs.readdirSync(ANALYSIS_SRC).filter((f) => f.endsWith('.ts'))) {
		if (file === 'vscodeStub.ts') { continue; }
		const lines = fs.readFileSync(path.join(ANALYSIS_SRC, file), 'utf8').split(/\r?\n/);
		lines.forEach((line, i) => { if (importRe.test(line)) { offenders.push(`${file}:${i + 1}`); } });
	}
	assert.deepEqual(offenders, []);
});

test('esbuild aliases vscode to the stub for the worker bundle', () => {
	const build = fs.readFileSync(path.join(EXTENSION_ROOT, 'esbuild.js'), 'utf8');
	assert.match(build, /alias:\s*\{\s*vscode:[^}]*vscodeStub/);
});
