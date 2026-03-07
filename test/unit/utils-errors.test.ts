import test from 'node:test';
import * as assert from 'node:assert/strict';

import {
	BackendError,
	isAzurePolicyDisallowedError,
	isStorageLocalAuthDisallowedByPolicyError,
	redactSecretsInText,
	safeStringifyError,
	withErrorHandling
} from '../utils/errors';

test('redactSecretsInText is no-op for empty inputs and skips blank secrets', () => {
	assert.equal(redactSecretsInText('', ['a']), '');
	assert.equal(redactSecretsInText('hello', []), 'hello');
	assert.equal(redactSecretsInText('hello', ['   ']), 'hello');
});

test('redactSecretsInText redacts all occurrences and escapes regex characters', () => {
	const text = 'token=a.b+c? token=a.b+c?';
	const redacted = redactSecretsInText(text, ['a.b+c?']);
	assert.equal(redacted, 'token=[REDACTED] token=[REDACTED]');
});

test('safeStringifyError prefers stack when present and redacts secrets', () => {
	const err = new Error('boom secret');
	err.stack = 'STACK secret';
	const out = safeStringifyError(err, ['secret']);
	assert.equal(out.includes('secret'), false);
	assert.ok(out.includes('STACK'));

	const out2 = safeStringifyError({ message: 'oops secret' } as any, ['secret']);
	assert.equal(out2.includes('secret'), false);
});

test('safeStringifyError does not throw on circular objects', () => {
	const circular: any = {};
	circular.self = circular;
	const out = safeStringifyError(circular);
	assert.equal(typeof out, 'string');
	assert.ok(out.length > 0);
});

test('safeStringifyError handles string/primitive/object error shapes', () => {
	assert.equal(safeStringifyError('boom'), 'boom');
	assert.ok(safeStringifyError(123).includes('123'));
	assert.equal(safeStringifyError({ error: 'bad' } as any), 'bad');
	assert.equal(typeof safeStringifyError(undefined), 'string');

	const err = new Error('msg');
	(err as any).stack = '';
	assert.ok(safeStringifyError(err).includes('msg'));
});

test('isAzurePolicyDisallowedError detects code and message patterns', () => {
	assert.equal(isAzurePolicyDisallowedError({ code: 'RequestDisallowedByPolicy' } as any), true);
	assert.equal(isAzurePolicyDisallowedError({ message: 'blocked by policy assignment' } as any), true);
	assert.equal(isAzurePolicyDisallowedError(new Error('nope')), false);
	assert.equal(isAzurePolicyDisallowedError(null), false);
});

test('isStorageLocalAuthDisallowedByPolicyError detects common policy messaging', () => {
	assert.equal(isStorageLocalAuthDisallowedByPolicyError({ message: 'AllowSharedKeyAccess is disabled by policy' } as any), true);
	assert.equal(isStorageLocalAuthDisallowedByPolicyError({ message: 'Local authentication disabled' } as any), true);
	assert.equal(isStorageLocalAuthDisallowedByPolicyError({ message: 'Shared Key blocked by policy' } as any), true);
	assert.equal(isStorageLocalAuthDisallowedByPolicyError({ message: 'something else' } as any), false);
});

test('withErrorHandling returns value on success and wraps errors on failure', async () => {
	const ok = await withErrorHandling(async () => 42, 'prefix');
	assert.equal(ok, 42);

	await assert.rejects(
		async () => withErrorHandling(async () => { throw new Error('secret'); }, 'prefix', ['secret']),
		(e: any) => {
			assert.ok(e instanceof BackendError);
			assert.ok(String(e.message).startsWith('prefix:'));
			assert.equal(String(e.message).includes('secret'), false);
			return true;
		}
	);
});

test('redacts secrets from error stack traces', () => {
	const error = new Error('Failed to connect');
	error.stack = 'Error: Failed to connect\n    at test.js:10\n    key=abc123secret at auth.js:5';
	const result = safeStringifyError(error, ['abc123secret']);
	assert.ok(!result.includes('abc123secret'), 'Secret should be redacted from stack trace');
	assert.ok(result.includes('[REDACTED]'), 'Stack trace should contain redaction marker');
	assert.ok(result.includes('Failed to connect'), 'Error message should still be present');
});
