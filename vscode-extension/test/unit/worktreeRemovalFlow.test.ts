import test from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	getLocaleStableGitEnvironment,
	isSubmoduleWorktreeRemovalFailure,
	isWorktreeDirectoryRemovalFailure,
	retrySubmoduleWorktreeRemovalWithConfirmation,
} from '../../src/extension';
import { extractBracesBlock } from './sourceStructureTestHelpers';

const extensionSource = fs.readFileSync(path.join(__dirname, '../../../../src/extension.ts'), 'utf8');

function extractMethodBody(marker: string): string {
	const markerIndex = extensionSource.indexOf(marker);
	assert.notEqual(markerIndex, -1, `marker not found in extension.ts: ${marker}`);
	const bodyStart = extensionSource.indexOf(' {\n', markerIndex) + 1;
	assert.ok(bodyStart > 0, `method body not found in extension.ts: ${marker}`);
	return extractBracesBlock(extensionSource.slice(bodyStart), '');
}

test('recognizes only Git submodule worktree removal refusals', () => {
	assert.equal(
		isSubmoduleWorktreeRemovalFailure('fatal: working trees containing submodules cannot be moved or removed'),
		true,
	);
	assert.equal(
		isSubmoduleWorktreeRemovalFailure('fatal: cannot remove a locked working tree'),
		false,
	);
});

test('forces locale-stable Git diagnostics without dropping inherited environment variables', () => {
	const environment = getLocaleStableGitEnvironment({ PATH: 'git-path', LANG: 'de_DE.UTF-8' });
	assert.equal(environment.PATH, 'git-path');
	assert.equal(environment.LANG, 'C');
	assert.equal(environment.LC_ALL, 'C');
});

test('recognizes only classified OS directory-removal failures', () => {
	assert.equal(isWorktreeDirectoryRemovalFailure("error: failed to delete 'C:\\repo\\worktree': Access is denied"), true);
	assert.equal(isWorktreeDirectoryRemovalFailure('fatal: cannot remove a locked working tree'), false);
});

const submoduleFailure = {
	ok: false,
	stderr: 'fatal: working trees containing submodules cannot be moved or removed',
};

test('declining submodule force removal makes no destructive retry', async () => {
	let forceCalls = 0;
	const result = await retrySubmoduleWorktreeRemovalWithConfirmation(
		'C:\\repo\\worktree',
		submoduleFailure,
		async () => undefined,
		async () => {
			forceCalls++;
			return { ok: true, stderr: '' };
		},
		async () => assert.fail('declining must not invoke the directory fallback'),
	);

	assert.equal(result, undefined);
	assert.equal(forceCalls, 0);
});

test('confirming submodule force removal makes exactly one destructive retry', async () => {
	let forceCalls = 0;
	const result = await retrySubmoduleWorktreeRemovalWithConfirmation(
		'C:\\repo\\worktree',
		submoduleFailure,
		async (_message, _options, action) => action,
		async () => {
			forceCalls++;
			return { ok: true, stderr: '' };
		},
		async () => assert.fail('successful forced removal must not invoke the directory fallback'),
	);

	assert.deepEqual(result, { ok: true, stderr: '' });
	assert.equal(forceCalls, 1);
});

test('unrelated Git failures are neither confirmed nor force-retried', async () => {
	let confirmationCalls = 0;
	let forceCalls = 0;
	const lockedFailure = { ok: false, stderr: 'fatal: cannot remove a locked working tree' };
	const result = await retrySubmoduleWorktreeRemovalWithConfirmation(
		'C:\\repo\\worktree',
		lockedFailure,
		async () => {
			confirmationCalls++;
			return 'Force Delete';
		},
		async () => {
			forceCalls++;
			return { ok: true, stderr: '' };
		},
		async () => assert.fail('unrelated failures must not invoke the directory fallback'),
	);

	assert.equal(result, lockedFailure);
	assert.equal(confirmationCalls, 0);
	assert.equal(forceCalls, 0);
});

test('confirmed force failure invokes the raw-directory fallback only after the forced retry', async () => {
	const calls: string[] = [];
	const result = await retrySubmoduleWorktreeRemovalWithConfirmation(
		'C:\\repo\\worktree',
		submoduleFailure,
		async (_message, _options, action) => {
			calls.push('confirm');
			return action;
		},
		async () => {
			calls.push('force');
			return { ok: false, stderr: "error: failed to delete 'C:\\repo\\worktree': Access is denied" };
		},
		async () => {
			calls.push('fallback');
			return { ok: true, stderr: '' };
		},
	);

	assert.deepEqual(calls, ['confirm', 'force', 'fallback']);
	assert.deepEqual(result, { ok: true, stderr: '' });
});

test('confirmed unrelated force failure does not invoke the raw-directory fallback', async () => {
	let fallbackCalls = 0;
	const lockedFailure = { ok: false, stderr: 'fatal: cannot remove a locked working tree' };
	const result = await retrySubmoduleWorktreeRemovalWithConfirmation(
		'C:\\repo\\worktree',
		submoduleFailure,
		async (_message, _options, action) => action,
		async () => lockedFailure,
		async () => {
			fallbackCalls++;
			return { ok: true, stderr: '' };
		},
	);

	assert.equal(result, lockedFailure);
	assert.equal(fallbackCalls, 0);
});

test('bulk cleanup only uses filesystem deletion for classified OS removal failures', () => {
	const cleanup = extractMethodBody('private async cleanupSinglePushedWorktree(');
	assert.ok(
		cleanup.includes('if (!result.ok && isWorktreeDirectoryRemovalFailure(result.stderr))'),
		'bulk cleanup must preserve Git safety refusals instead of force-deleting the directory',
	);
	assert.ok(
		!cleanup.includes('if (!result.ok) {\n      result = await this.removeWorktreeDirectoryFallback'),
		'bulk cleanup must not use filesystem deletion for arbitrary Git failures',
	);
});

test('single-worktree removal retains the confirmed filesystem fallback without deinitializing submodules', () => {
	const removal = extractMethodBody('private async _removeWorktreeWithFallback(');
	assert.ok(removal.includes('retrySubmoduleWorktreeRemovalWithConfirmation('));
	assert.ok(removal.includes('removeWorktreeDirectoryFallback(mainRepoRoot, worktreePath)'));
	assert.ok(!removal.includes('submodule", "deinit'), 'must not mutate shared submodule configuration');
});
