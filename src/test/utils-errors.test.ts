// @ts-nocheck
import test from 'node:test';
import * as assert from 'node:assert/strict';

import {
	BackendError,
	BackendConfigError,
	BackendAuthError,
	BackendSyncError,
	isAzurePolicyDisallowedError,
	isStorageLocalAuthDisallowedByPolicyError,
	isAuthError,
	isNotFoundError,
	isConflictError,
	isRetryableError,
	isNetworkError,
	redactSecretsInText,
	safeStringifyError,
	getErrorStatusCode,
	getErrorCode,
	withErrorHandling,
	withErrorRecovery,
	withErrorRecoverySync,
	withErrorRecoveryResult,
	withErrorRecoverySyncResult
} from '../utils/errors';

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

// ── withErrorRecoverySync tests ───────────────────────────────────────────

test('withErrorRecoverySync returns fn result on success', () => {
	const result = withErrorRecoverySync(() => 42, 0, 'test context');
	assert.equal(result, 42);
});

test('withErrorRecoverySync returns fallback when fn throws', () => {
	const result = withErrorRecoverySync(() => { throw new Error('boom'); }, 99, 'test context');
	assert.equal(result, 99);
});

test('withErrorRecoverySync returns fallback with no context when context is omitted', () => {
	const result = withErrorRecoverySync(() => { throw new Error('boom'); }, 'default');
	assert.equal(result, 'default');
});

test('withErrorRecoverySync returns array fallback when fn throws', () => {
	const result = withErrorRecoverySync(() => { throw new Error('oops'); }, [] as string[]);
	assert.deepEqual(result, []);
});

test('withErrorRecoverySync returns null fallback when fn throws', () => {
	const result = withErrorRecoverySync(() => { throw new Error('fail'); }, null);
	assert.equal(result, null);
});

// ── withErrorRecovery tests (async) ──────────────────────────────────────

test('withErrorRecovery returns fn result on success (sync fn)', async () => {
	const result = await withErrorRecovery(() => 'hello', 'fallback', 'ctx');
	assert.equal(result, 'hello');
});

test('withErrorRecovery returns fn result on success (async fn)', async () => {
	const result = await withErrorRecovery(async () => 'world', 'fallback', 'ctx');
	assert.equal(result, 'world');
});

test('withErrorRecovery returns fallback when sync fn throws', async () => {
	const result = await withErrorRecovery(() => { throw new Error('boom'); }, 'default', 'ctx');
	assert.equal(result, 'default');
});

test('withErrorRecovery returns fallback when async fn rejects', async () => {
	const result = await withErrorRecovery(async () => { throw new Error('async boom'); }, 0, 'ctx');
	assert.equal(result, 0);
});

test('withErrorRecovery returns array fallback when fn throws', async () => {
	const result = await withErrorRecovery(() => { throw new Error('fail'); }, [] as number[]);
	assert.deepEqual(result, []);
});

test('withErrorRecovery returns null fallback when fn throws', async () => {
	const result = await withErrorRecovery(async () => { throw new Error('fail'); }, null);
	assert.equal(result, null);
});

// ── withErrorRecoverySyncResult tests ─────────────────────────────────────

test('withErrorRecoverySyncResult returns ok:true with value on success', () => {
	const result = withErrorRecoverySyncResult(() => 42, 'ctx');
	assert.ok(result.ok);
	if (result.ok) { assert.equal(result.value, 42); }
});

test('withErrorRecoverySyncResult returns ok:false with error on throw', () => {
	const thrown = new Error('sync-fail');
	const result = withErrorRecoverySyncResult(() => { throw thrown; }, 'ctx');
	assert.equal(result.ok, false);
	if (!result.ok) { assert.equal(result.error, thrown); }
});

test('withErrorRecoverySyncResult captures non-Error thrown values', () => {
	const result = withErrorRecoverySyncResult(() => { throw 'oops'; }, 'ctx');
	assert.equal(result.ok, false);
	if (!result.ok) { assert.equal(result.error, 'oops'); }
});

test('withErrorRecoverySyncResult works without context argument', () => {
	const result = withErrorRecoverySyncResult(() => { throw new Error('no-ctx'); });
	assert.equal(result.ok, false);
});

// ── withErrorRecoveryResult tests (async) ────────────────────────────────

test('withErrorRecoveryResult returns ok:true with value for sync fn', async () => {
	const result = await withErrorRecoveryResult(() => 'hello', 'ctx');
	assert.ok(result.ok);
	if (result.ok) { assert.equal(result.value, 'hello'); }
});

test('withErrorRecoveryResult returns ok:true with value for async fn', async () => {
	const result = await withErrorRecoveryResult(async () => 'world', 'ctx');
	assert.ok(result.ok);
	if (result.ok) { assert.equal(result.value, 'world'); }
});

test('withErrorRecoveryResult returns ok:false when sync fn throws', async () => {
	const thrown = new Error('sync-async-fail');
	const result = await withErrorRecoveryResult(() => { throw thrown; }, 'ctx');
	assert.equal(result.ok, false);
	if (!result.ok) { assert.equal(result.error, thrown); }
});

test('withErrorRecoveryResult returns ok:false when async fn rejects', async () => {
	const thrown = new Error('async-fail');
	const result = await withErrorRecoveryResult(async () => { throw thrown; }, 'ctx');
	assert.equal(result.ok, false);
	if (!result.ok) { assert.equal(result.error, thrown); }
});

test('withErrorRecoveryResult captures non-Error thrown values', async () => {
	const result = await withErrorRecoveryResult(async () => { throw 'string-error'; }, 'ctx');
	assert.equal(result.ok, false);
	if (!result.ok) { assert.equal(result.error, 'string-error'); }
});

test('withErrorRecoveryResult works without context argument', async () => {
	const result = await withErrorRecoveryResult(async () => { throw new Error('no-ctx'); });
	assert.equal(result.ok, false);
});


// ── getErrorStatusCode ─────────────────────────────────────────────────────

test('getErrorStatusCode: returns undefined for null and non-objects', () => {
assert.equal(getErrorStatusCode(null), undefined);
assert.equal(getErrorStatusCode(undefined), undefined);
assert.equal(getErrorStatusCode('string error'), undefined);
assert.equal(getErrorStatusCode(42), undefined);
});

test('getErrorStatusCode: returns undefined when statusCode is absent', () => {
assert.equal(getErrorStatusCode({}), undefined);
assert.equal(getErrorStatusCode(new Error('oops')), undefined);
});

test('getErrorStatusCode: returns statusCode when it is a number', () => {
assert.equal(getErrorStatusCode({ statusCode: 404 }), 404);
assert.equal(getErrorStatusCode({ statusCode: 401 }), 401);
assert.equal(getErrorStatusCode({ statusCode: 500 }), 500);
});

test('getErrorStatusCode: returns undefined when statusCode is a string', () => {
assert.equal(getErrorStatusCode({ statusCode: '404' }), undefined);
});

// ── getErrorCode ───────────────────────────────────────────────────────────

test('getErrorCode: returns undefined for null and non-objects', () => {
assert.equal(getErrorCode(null), undefined);
assert.equal(getErrorCode(undefined), undefined);
assert.equal(getErrorCode('string'), undefined);
assert.equal(getErrorCode(42), undefined);
});

test('getErrorCode: returns undefined when code is absent', () => {
assert.equal(getErrorCode({}), undefined);
assert.equal(getErrorCode({ message: 'oops' }), undefined);
});

test('getErrorCode: returns string code', () => {
assert.equal(getErrorCode({ code: 'NOT_FOUND' }), 'NOT_FOUND');
assert.equal(getErrorCode({ code: 'REQUEST_DISALLOWED' }), 'REQUEST_DISALLOWED');
});

test('getErrorCode: returns numeric code', () => {
assert.equal(getErrorCode({ code: 404 }), 404);
assert.equal(getErrorCode({ code: 0 }), 0);
});

test('getErrorCode: returns undefined when code is boolean or object', () => {
assert.equal(getErrorCode({ code: true }), undefined);
assert.equal(getErrorCode({ code: null }), undefined);
assert.equal(getErrorCode({ code: {} }), undefined);
});

// ── isAuthError tests ─────────────────────────────────────────────────────

test('isAuthError: returns true for statusCode 403', () => {
assert.equal(isAuthError({ statusCode: 403 }), true);
});

test('isAuthError: returns true for AUTHORIZATION_PERMISSION_MISMATCH code', () => {
assert.equal(isAuthError({ code: 'AuthorizationPermissionMismatch' }), true);
});

test('isAuthError: returns true when message contains 403', () => {
assert.equal(isAuthError({ message: 'Error 403 Forbidden' } as any), true);
});

test('isAuthError: returns true when message contains Forbidden', () => {
assert.equal(isAuthError({ message: 'Access Forbidden' } as any), true);
});

test('isAuthError: returns false for non-auth errors', () => {
assert.equal(isAuthError({ statusCode: 404 }), false);
assert.equal(isAuthError({ message: 'Not found' } as any), false);
assert.equal(isAuthError(null), false);
assert.equal(isAuthError(undefined), false);
});

// ── isNotFoundError tests ─────────────────────────────────────────────────

test('isNotFoundError: returns true for statusCode 404', () => {
assert.equal(isNotFoundError({ statusCode: 404 }), true);
});

test('isNotFoundError: returns true when message contains 404', () => {
assert.equal(isNotFoundError({ message: 'Error 404 not found' } as any), true);
});

test('isNotFoundError: returns true when message contains NotFound', () => {
assert.equal(isNotFoundError({ message: 'Resource NotFound' } as any), true);
});

test('isNotFoundError: returns false for non-404 errors', () => {
assert.equal(isNotFoundError({ statusCode: 200 }), false);
assert.equal(isNotFoundError({ statusCode: 500 }), false);
assert.equal(isNotFoundError(null), false);
});

// ── isConflictError tests ─────────────────────────────────────────────────

test('isConflictError: returns true for statusCode 409', () => {
assert.equal(isConflictError({ statusCode: 409 }), true);
});

test('isConflictError: returns true for TABLE_ALREADY_EXISTS code', () => {
assert.equal(isConflictError({ code: 'TableAlreadyExists' }), true);
});

test('isConflictError: returns true for numeric 409 code', () => {
assert.equal(isConflictError({ code: 409 }), true);
});

test('isConflictError: returns false for non-conflict errors', () => {
assert.equal(isConflictError({ statusCode: 200 }), false);
assert.equal(isConflictError({ code: 'SomethingElse' }), false);
assert.equal(isConflictError(null), false);
});

// ── isRetryableError tests ────────────────────────────────────────────────

test('isRetryableError: returns true for TOO_MANY_REQUESTS (429)', () => {
assert.equal(isRetryableError({ statusCode: 429 }), true);
});

test('isRetryableError: returns true for SERVICE_UNAVAILABLE (503)', () => {
assert.equal(isRetryableError({ statusCode: 503 }), true);
});

test('isRetryableError: returns true for ETIMEDOUT code', () => {
assert.equal(isRetryableError({ code: 'ETIMEDOUT' }), true);
});

test('isRetryableError: returns false for non-retryable errors', () => {
assert.equal(isRetryableError({ statusCode: 400 }), false);
assert.equal(isRetryableError({ code: 'ECONNREFUSED' }), false);
assert.equal(isRetryableError(null), false);
});

// ── isNetworkError tests ──────────────────────────────────────────────────

test('isNetworkError: returns true for ENOTFOUND code', () => {
assert.equal(isNetworkError({ code: 'ENOTFOUND' }), true);
});

test('isNetworkError: returns true for ETIMEDOUT code', () => {
assert.equal(isNetworkError({ code: 'ETIMEDOUT' }), true);
});

test('isNetworkError: returns true for ECONNREFUSED code', () => {
assert.equal(isNetworkError({ code: 'ECONNREFUSED' }), true);
});

test('isNetworkError: returns true when message contains ENOTFOUND', () => {
assert.equal(isNetworkError({ message: 'DNS lookup ENOTFOUND' } as any), true);
});

test('isNetworkError: returns true when message contains ETIMEDOUT', () => {
assert.equal(isNetworkError({ message: 'Connection ETIMEDOUT' } as any), true);
});

test('isNetworkError: returns true when message contains ECONNREFUSED', () => {
assert.equal(isNetworkError({ message: 'Connection ECONNREFUSED' } as any), true);
});

test('isNetworkError: returns false for non-network errors', () => {
assert.equal(isNetworkError({ statusCode: 404 }), false);
assert.equal(isNetworkError({ code: 'NOT_FOUND' }), false);
assert.equal(isNetworkError(null), false);
});
