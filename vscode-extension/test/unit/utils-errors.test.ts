import test from 'node:test';
import * as assert from 'node:assert/strict';

import {
	BackendError,
	BackendConfigError,
	BackendAuthError,
	BackendSyncError,
	isAzurePolicyDisallowedError,
	isStorageLocalAuthDisallowedByPolicyError,
	redactSecretsInText,
	safeStringifyError,
	withErrorHandling
} from '../../src/utils/errors';

test('BackendConfigError/BackendAuthError/BackendSyncError set name and cause', () => {
	const configErr = new BackendConfigError('config bad', new Error('cause'));
	assert.equal(configErr.name, 'BackendConfigError');
	assert.equal(configErr.message, 'config bad');
	assert.ok(configErr instanceof BackendError);

	const authErr = new BackendAuthError('auth bad');
	assert.equal(authErr.name, 'BackendAuthError');
	assert.ok(authErr instanceof BackendError);

	const syncErr = new BackendSyncError('sync bad', 'original');
	assert.equal(syncErr.name, 'BackendSyncError');
	assert.ok(syncErr instanceof BackendError);
});

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

// ── Mutation-killing tests ──────────────────────────────────────────────

test('BackendError sets name property to BackendError', () => {
        const err = new BackendError('test');
        assert.equal(err.name, 'BackendError');
        assert.equal(err.message, 'test');
});

test('BackendError stores cause', () => {
        const cause = new Error('root');
        const err = new BackendError('wrapped', cause);
        assert.equal(err.cause, cause);
});

test('safeStringifyError uses message when stack is empty string', () => {
        const err = new Error('fallback message');
        err.stack = '';
        const result = safeStringifyError(err);
        assert.ok(result.includes('fallback message'));
});

test('safeStringifyError redacts secrets from non-Error string', () => {
        const result = safeStringifyError('connection failed at host=secret123', ['secret123']);
        assert.ok(!result.includes('secret123'), 'Secret should be redacted');
        assert.ok(result.includes('[REDACTED]'), 'Should contain redaction marker');
});

test('safeStringifyError redacts secrets from plain object message', () => {
        const result = safeStringifyError({ message: 'key=mytoken123' } as any, ['mytoken123']);
        assert.ok(!result.includes('mytoken123'));
        assert.ok(result.includes('[REDACTED]'));
});

test('safeStringifyError handles object with error property but no message', () => {
        const result = safeStringifyError({ error: 'something went wrong' } as any);
        assert.equal(result, 'something went wrong');
});

test('isStorageLocalAuthDisallowedByPolicyError returns false for non-object primitives', () => {
        assert.equal(isStorageLocalAuthDisallowedByPolicyError(undefined), false);
        assert.equal(isStorageLocalAuthDisallowedByPolicyError(null), false);
        assert.equal(isStorageLocalAuthDisallowedByPolicyError(42), false);
        assert.equal(isStorageLocalAuthDisallowedByPolicyError('string'), false);
});

test('isStorageLocalAuthDisallowedByPolicyError requires both shared key AND policy', () => {
        // "shared key" alone should NOT match (requires both "shared key" AND "policy")
        assert.equal(
                isStorageLocalAuthDisallowedByPolicyError({ message: 'shared key was used for auth' } as any),
                false
        );
        // "policy" alone should NOT match via the shared key+policy branch
        // but may match via the other branches if it contains the exact phrases
        assert.equal(
                isStorageLocalAuthDisallowedByPolicyError({ message: 'policy was applied' } as any),
                false
        );
});

test('isAzurePolicyDisallowedError returns false for undefined and primitive values', () => {
        assert.equal(isAzurePolicyDisallowedError(undefined), false);
        assert.equal(isAzurePolicyDisallowedError(42), false);
        assert.equal(isAzurePolicyDisallowedError('string'), false);
        assert.equal(isAzurePolicyDisallowedError(true), false);
});

test('isAzurePolicyDisallowedError returns false when code and message do not match', () => {
        assert.equal(isAzurePolicyDisallowedError({ code: 'SomethingElse', message: 'unrelated error' } as any), false);
});

test('redactSecretsInText handles null secretsToRedact gracefully', () => {
        assert.equal(redactSecretsInText('hello', null as any), 'hello');
});

test('withErrorHandling preserves the original error as cause', async () => {
        const original = new Error('original');
        try {
                await withErrorHandling(async () => { throw original; }, 'op');
                assert.fail('Should have thrown');
        } catch (e: any) {
                assert.ok(e instanceof BackendError);
                assert.equal(e.cause, original);
        }
});