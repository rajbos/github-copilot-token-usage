/**
 * Unit tests for the `memory-files` CLI command's threshold parsing.
 * Tests resolveMemoryFilesThresholds() in cli/src/commands/memory-files.ts
 */

import test from 'node:test';
import * as assert from 'node:assert/strict';

import { resolveMemoryFilesThresholds, buildPromoteOutput, analyzesLocalCheckout } from '../commands/memory-files';
import { analyzeServerMemories } from '../../../src/copilotServerMemories';
import { DEFAULT_STALE_DAYS, DEFAULT_LARGE_FILE_BYTES } from '../../../src/copilotMemoryFiles';

test('resolveMemoryFilesThresholds falls back to defaults when options are missing', () => {
	const result = resolveMemoryFilesThresholds({});
	assert.equal(result.staleDays, DEFAULT_STALE_DAYS);
	assert.equal(result.largeFileBytes, DEFAULT_LARGE_FILE_BYTES);
});

test('resolveMemoryFilesThresholds honors an explicit 0 instead of silently using the default', () => {
	const result = resolveMemoryFilesThresholds({ staleDays: '0', largeKb: '0' });
	// 0 is clamped to the 1 floor, not replaced by the default (a `|| DEFAULT` bug regression check).
	assert.equal(result.staleDays, 1);
	assert.equal(result.largeFileBytes, 1024);
});

test('resolveMemoryFilesThresholds passes through valid positive values', () => {
	const result = resolveMemoryFilesThresholds({ staleDays: '30', largeKb: '5' });
	assert.equal(result.staleDays, 30);
	assert.equal(result.largeFileBytes, 5 * 1024);
});

test('resolveMemoryFilesThresholds falls back to defaults for non-numeric input', () => {
	const result = resolveMemoryFilesThresholds({ staleDays: 'abc', largeKb: 'xyz' });
	assert.equal(result.staleDays, DEFAULT_STALE_DAYS);
	assert.equal(result.largeFileBytes, DEFAULT_LARGE_FILE_BYTES);
});

test('resolveMemoryFilesThresholds clamps negative values to the 1 floor', () => {
	const result = resolveMemoryFilesThresholds({ staleDays: '-5', largeKb: '-2' });
	assert.equal(result.staleDays, 1);
	assert.equal(result.largeFileBytes, 1024);
});

test('resolveMemoryFilesThresholds falls back to defaults for a value with trailing non-digit characters', () => {
	// parseInt('30days', 10) === 30 — strict validation must reject this instead of
	// silently truncating it to a numeric prefix.
	const result = resolveMemoryFilesThresholds({ staleDays: '30days', largeKb: '5kb' });
	assert.equal(result.staleDays, DEFAULT_STALE_DAYS);
	assert.equal(result.largeFileBytes, DEFAULT_LARGE_FILE_BYTES);
});

// ---------------------------------------------------------------------------
// --promote output contract: stdout is only the paste-ready block (#2286)
// ---------------------------------------------------------------------------

function promoteAnalysis(deps: Parameters<typeof analyzeServerMemories>[1], repoRoot?: string) {
	const analysis = analyzeServerMemories({
		repo: 'o/n',
		enabled: true,
		memories: [{ id: '1', subject: 'caching', fact: 'Cache via snapshots.', citations: ['src/cache.ts:1'] }],
	}, deps);
	return repoRoot ? { ...analysis, repoRoot } : analysis;
}

test('buildPromoteOutput sends the analyzed checkout to stderr and keeps stdout paste-ready', () => {
	const output = buildPromoteOutput(promoteAnalysis(
		{ fileExists: () => true, promotionTargetStatus: p => (p === '.github/copilot-instructions.md' ? 'exists' : 'absent') },
		'/home/dev/repo',
	));
	assert.equal(output.exitCode, 0);
	assert.equal(output.stderr, 'Analyzed o/n at /home/dev/repo\n');
	assert.ok(!output.stdout.includes('/home/dev/repo'), 'the checkout path must not leak into the pasted block');
	assert.match(output.stdout, /Suggested target: \.github\/copilot-instructions\.md\./);
	assert.match(output.stdout, /- \*\*caching\*\* — Cache via snapshots\./);
});

test('buildPromoteOutput for --repo elsewhere names no checkout and no guessed target', () => {
	// The CLI passes `fileExists: () => true` and no target probe when --repo is not this checkout.
	const output = buildPromoteOutput(promoteAnalysis({ fileExists: () => true }));
	assert.equal(output.exitCode, 0);
	assert.equal(output.stderr, '');
	assert.match(output.stdout, /not checked against a local checkout/);
	assert.ok(!/Suggested target: AGENTS\.md\./.test(output.stdout), 'must not claim AGENTS.md exists in another repository');
});

test('buildPromoteOutput reports a failed read on stderr with exit code 1', () => {
	const failed = { ...promoteAnalysis({ fileExists: () => true }), error: 'HTTP 401' };
	assert.deepEqual(buildPromoteOutput(failed), { stdout: '', stderr: 'Could not read o/n: HTTP 401\n', exitCode: 1 });
	assert.equal(buildPromoteOutput(undefined).exitCode, 0);
});

test('buildPromoteOutput never suggests a target the local probe rejected', () => {
	const output = buildPromoteOutput(promoteAnalysis(
		{ fileExists: () => true, promotionTargetStatus: p => (p === 'AGENTS.md' ? 'unsafe' : 'exists') },
		'/home/dev/repo',
	));
	assert.match(output.stdout, /Suggested target: none — AGENTS\.md is not a regular file inside this checkout/);
	assert.ok(!output.stdout.includes('copilot-instructions'), 'must not fall back to the other candidate');
});

test('buildPromoteOutput explains a stale-only store instead of calling it documented', () => {
	const output = buildPromoteOutput(promoteAnalysis({ fileExists: () => false, promotionTargetStatus: () => 'absent' }, '/home/dev/repo'));
	assert.match(output.stdout, /1 cites only files that no longer exist/);
	assert.ok(!output.stdout.includes('every stored memory already cites'));
});

test('analyzesLocalCheckout matches --repo against the origin case-insensitively', () => {
	assert.equal(analyzesLocalCheckout(undefined, 'owner/repo'), true);
	assert.equal(analyzesLocalCheckout('Owner/Repo', 'owner/repo'), true, 'GitHub slugs are case-insensitive');
	assert.equal(analyzesLocalCheckout('owner/repo.git', 'owner/repo'), true, 'remote-form --repo still names this checkout');
	assert.equal(analyzesLocalCheckout('owner/other', 'owner/repo'), false);
	assert.equal(analyzesLocalCheckout('owner/repo', undefined), false);
});
