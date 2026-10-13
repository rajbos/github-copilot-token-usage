// @ts-nocheck
import test from 'node:test';
import * as assert from 'node:assert/strict';

import {
	HTTP_STATUS,
	AZURE_ERROR_CODES,
	isAzurePolicyDisallowedError,
	isStorageLocalAuthDisallowedByPolicyError,
	isAuthError,
	isNotFoundError,
	isConflictError,
	isRetryableError,
	isNetworkError
} from '../utils/azureErrorClassifier';

// Test HTTP_STATUS constants
test('HTTP_STATUS constants have correct values', () => {
	assert.equal(HTTP_STATUS.FORBIDDEN, 403);
	assert.equal(HTTP_STATUS.NOT_FOUND, 404);
	assert.equal(HTTP_STATUS.CONFLICT, 409);
	assert.equal(HTTP_STATUS.TOO_MANY_REQUESTS, 429);
	assert.equal(HTTP_STATUS.SERVICE_UNAVAILABLE, 503);
});

// Test AZURE_ERROR_CODES constants
test('AZURE_ERROR_CODES constants have correct values', () => {
	assert.equal(AZURE_ERROR_CODES.AUTHORIZATION_PERMISSION_MISMATCH, 'AuthorizationPermissionMismatch');
	assert.equal(AZURE_ERROR_CODES.TABLE_ALREADY_EXISTS, 'TableAlreadyExists');
	assert.equal(AZURE_ERROR_CODES.ENOTFOUND, 'ENOTFOUND');
	assert.equal(AZURE_ERROR_CODES.ETIMEDOUT, 'ETIMEDOUT');
	assert.equal(AZURE_ERROR_CODES.ECONNREFUSED, 'ECONNREFUSED');
});

// Test isAzurePolicyDisallowedError
test('isAzurePolicyDisallowedError returns true for RequestDisallowedByPolicy code', () => {
	const error1 = { code: 'RequestDisallowedByPolicy', message: 'Some message' };
	assert.ok(isAzurePolicyDisallowedError(error1));
});

test('isAzurePolicyDisallowedError returns true for policy assignment in message', () => {
	const error1 = { code: 'OtherCode', message: 'RequestDisallowedByPolicy occurred' };
	assert.ok(isAzurePolicyDisallowedError(error1));
});

test('isAzurePolicyDisallowedError returns true for policy assignment in message', () => {
	const error1 = { code: 'OtherCode', message: 'policy assignment failed' };
	assert.ok(isAzurePolicyDisallowedError(error1));
});

test('isAzurePolicyDisallowedError returns false for non-policy errors', () => {
	const error1 = { code: 'OtherError', message: 'Something else' };
	assert.ok(!isAzurePolicyDisallowedError(error1));
});

test('isAzurePolicyDisallowedError returns false for null/undefined', () => {
	assert.ok(!isAzurePolicyDisallowedError(null));
	assert.ok(!isAzurePolicyDisallowedError(undefined));
	assert.ok(!isAzurePolicyDisallowedError('string'));
	assert.ok(!isAzurePolicyDisallowedError(123));
});

// Test isStorageLocalAuthDisallowedByPolicyError
test('isStorageLocalAuthDisallowedByPolicyError returns true for allowsharedkeyaccess in message', () => {
	const error1 = { message: 'allowsharedkeyaccess is disabled' };
	assert.ok(isStorageLocalAuthDisallowedByPolicyError(error1));
});

test('isStorageLocalAuthDisallowedByPolicyError returns true for local authentication in message', () => {
	const error1 = { message: 'local authentication not allowed' };
	assert.ok(isStorageLocalAuthDisallowedByPolicyError(error1));
});

test('isStorageLocalAuthDisallowedByPolicyError returns true for shared key and policy in message', () => {
	const error1 = { message: 'shared key access blocked by policy' };
	assert.ok(isStorageLocalAuthDisallowedByPolicyError(error1));
});

test('isStorageLocalAuthDisallowedByPolicyError returns false for non-matching errors', () => {
	const error1 = { message: 'Some other error' };
	assert.ok(!isStorageLocalAuthDisallowedByPolicyError(error1));
});

test('isStorageLocalAuthDisallowedByPolicyError handles case-insensitive matching', () => {
	const error1 = { message: 'ALLOWSHAREDKEYACCESS is required' };
	assert.ok(isStorageLocalAuthDisallowedByPolicyError(error1));
});

// Test isAuthError
test('isAuthError returns true for FORBIDDEN status code', () => {
	const error1 = { statusCode: 403, message: 'Forbidden' };
	assert.ok(isAuthError(error1));
});

test('isAuthError returns true for AUTHORIZATION_PERMISSION_MISMATCH code', () => {
	const error1 = { code: 'AuthorizationPermissionMismatch', statusCode: 403 };
	assert.ok(isAuthError(error1));
});

test('isAuthError returns true for 403 in message', () => {
	const error1 = { message: 'HTTP 403 Forbidden' };
	assert.ok(isAuthError(error1));
});

test('isAuthError returns true for Forbidden in message', () => {
	const error1 = { message: 'Access Forbidden' };
	assert.ok(isAuthError(error1));
});

test('isAuthError returns false for non-auth errors', () => {
	const error1 = { statusCode: 404, message: 'Not Found' };
	assert.ok(!isAuthError(error1));
});

// Test isNotFoundError
test('isNotFoundError returns true for NOT_FOUND status code', () => {
	const error1 = { statusCode: 404, message: 'Not Found' };
	assert.ok(isNotFoundError(error1));
});

test('isNotFoundError returns true for 404 in message', () => {
	const error1 = { message: 'Error 404' };
	assert.ok(isNotFoundError(error1));
});

test('isNotFoundError returns true for NotFound in message', () => {
	const error1 = { message: 'Resource NotFound' };
	assert.ok(isNotFoundError(error1));
});

test('isNotFoundError returns false for non-404 errors', () => {
	const error1 = { statusCode: 200, message: 'OK' };
	assert.ok(!isNotFoundError(error1));
});

// Test isConflictError
test('isConflictError returns true for CONFLICT status code', () => {
	const error1 = { statusCode: 409, message: 'Conflict' };
	assert.ok(isConflictError(error1));
});

test('isConflictError returns true for TABLE_ALREADY_EXISTS code', () => {
	const error1 = { code: 'TableAlreadyExists', statusCode: 409 };
	assert.ok(isConflictError(error1));
});

test('isConflictError returns true for 409 string code', () => {
	const error1 = { code: '409', statusCode: 409 };
	assert.ok(isConflictError(error1));
});

test('isConflictError returns false for non-conflict errors', () => {
	const error1 = { statusCode: 200, message: 'OK' };
	assert.ok(!isConflictError(error1));
});

// Test isRetryableError
test('isRetryableError returns true for TOO_MANY_REQUESTS status code', () => {
	const error1 = { statusCode: 429, message: 'Rate limited' };
	assert.ok(isRetryableError(error1));
});

test('isRetryableError returns true for SERVICE_UNAVAILABLE status code', () => {
	const error1 = { statusCode: 503, message: 'Service Unavailable' };
	assert.ok(isRetryableError(error1));
});

test('isRetryableError returns true for ETIMEDOUT code', () => {
	const error1 = { code: 'ETIMEDOUT', statusCode: 500 };
	assert.ok(isRetryableError(error1));
});

test('isRetryableError returns false for non-retryable errors', () => {
	const error1 = { statusCode: 400, message: 'Bad Request' };
	assert.ok(!isRetryableError(error1));
});

// Test isNetworkError
test('isNetworkError returns true for ENOTFOUND code', () => {
	const error1 = { code: 'ENOTFOUND', message: 'DNS lookup failed' };
	assert.ok(isNetworkError(error1));
});

test('isNetworkError returns true for ETIMEDOUT code', () => {
	const error1 = { code: 'ETIMEDOUT', message: 'Connection timed out' };
	assert.ok(isNetworkError(error1));
});

test('isNetworkError returns true for ECONNREFUSED code', () => {
	const error1 = { code: 'ECONNREFUSED', message: 'Connection refused' };
	assert.ok(isNetworkError(error1));
});

test('isNetworkError returns true for ENOTFOUND in message', () => {
	const error1 = { message: 'Error: ENOTFOUND' };
	assert.ok(isNetworkError(error1));
});

test('isNetworkError returns true for ETIMEDOUT in message', () => {
	const error1 = { message: 'Error: ETIMEDOUT' };
	assert.ok(isNetworkError(error1));
});

test('isNetworkError returns true for ECONNREFUSED in message', () => {
	const error1 = { message: 'Error: ECONNREFUSED' };
	assert.ok(isNetworkError(error1));
});

test('isNetworkError returns false for non-network errors', () => {
	const error1 = { statusCode: 400, message: 'Bad Request' };
	assert.ok(!isNetworkError(error1));
});

// Test edge cases with numeric codes
test('isConflictError handles numeric code 409', () => {
	const error1 = { code: 409 };
	assert.ok(isConflictError(error1));
});

test('isAuthError handles numeric statusCode', () => {
	const error1 = { statusCode: 403 };
	assert.ok(isAuthError(error1));
});

// Test with Error objects
test('isAuthError works with Error objects containing statusCode', () => {
	const error1 = new Error('Forbidden') as any;
	error1.statusCode = 403;
	assert.ok(isAuthError(error1));
});

test('isNetworkError works with Error objects containing code', () => {
	const error1 = new Error('Connection refused') as any;
	error1.code = 'ECONNREFUSED';
	assert.ok(isNetworkError(error1));
});
