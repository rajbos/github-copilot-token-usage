/**
 * Error utilities for the Copilot Token Tracker extension.
 * Provides custom error types, error handling, and secret redaction.
 */

// Custom error types for backend operations
export class BackendError extends Error {
	constructor(message: string, public readonly cause?: unknown) {
		super(message);
		this.name = 'BackendError';
	}
}

export class BackendConfigError extends BackendError {
	constructor(message: string, cause?: unknown) {
		super(message, cause);
		this.name = 'BackendConfigError';
	}
}

export class BackendAuthError extends BackendError {
	constructor(message: string, cause?: unknown) {
		super(message, cause);
		this.name = 'BackendAuthError';
	}
}

export class BackendSyncError extends BackendError {
	constructor(message: string, cause?: unknown) {
		super(message, cause);
		this.name = 'BackendSyncError';
	}
}

/**
 * Redacts secrets from text to prevent exposure in logs or error messages.
 * @param text - The text to redact
 * @param secretsToRedact - Array of secret strings to redact
 * @returns Text with secrets replaced by [REDACTED]
 */
export function redactSecretsInText(text: string, secretsToRedact: string[]): string {
	if (!text || !secretsToRedact || secretsToRedact.length === 0) {
		return text;
	}
	let result = text;
	for (const secret of secretsToRedact) {
		if (!secret || !secret.trim()) {
			continue;
		}
		// Escape special regex characters
		const escaped = secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
		result = result.replace(new RegExp(escaped, 'g'), '[REDACTED]');
	}
	return result;
}

/**
 * Safely converts an error to a string, with optional secret redaction.
 * @param error - The error to stringify
 * @param secretsToRedact - Optional array of secrets to redact from the error message
 * @returns A safe string representation of the error
 */
export function safeStringifyError(error: unknown, secretsToRedact?: string[]): string {
	let message: string;
	
	if (error instanceof Error) {
		// Include stack trace if available (useful for debugging)
		if (error.stack) {
			let stack = error.stack;
			if (secretsToRedact && secretsToRedact.length > 0) {
				stack = redactSecretsInText(stack, secretsToRedact);
			}
			message = stack;
		} else {
			message = error.message || error.toString();
		}
	} else if (typeof error === 'string') {
		message = error;
	} else if (error && typeof error === 'object') {
		// Try to extract message from object
		const errorObj = error as any;
		try {
			message = errorObj.message || errorObj.error || JSON.stringify(error);
		} catch {
			// Guard against circular structures
			message = errorObj.message || errorObj.error || '[object Object]';
		}
	} else {
		message = String(error);
	}

	// Redact secrets if provided (for non-stack trace messages)
	if (secretsToRedact && secretsToRedact.length > 0) {
		message = redactSecretsInText(message, secretsToRedact);
	}

	return message;
}

/**
 * Checks if an error is an Azure Policy "RequestDisallowedByPolicy" error.
 * @param error - The error to check
 * @returns True if this is an Azure Policy disallowed error
 */
export function isAzurePolicyDisallowedError(error: unknown): boolean {
	if (!error || typeof error !== 'object') {
		return false;
	}
	const e = error as any;
	// Azure Resource Manager returns this error code when policy blocks an operation
	if (e.code === 'RequestDisallowedByPolicy') {
		return true;
	}
	// Also check in message
	const message = e.message || '';
	return message.includes('RequestDisallowedByPolicy') || message.includes('policy assignment');
}

/**
 * Checks if an error indicates Storage account local auth (Shared Key) is disabled by Azure Policy.
 * @param error - The error to check
 * @returns True if this is a Storage local auth disabled error
 */
export function isStorageLocalAuthDisallowedByPolicyError(error: unknown): boolean {
	if (!error || typeof error !== 'object') {
		return false;
	}
	const e = error as any;
	const message = (e.message || '').toLowerCase();
	
	// Common patterns in policy error messages
	return (
		message.includes('allowsharedkeyaccess') ||
		message.includes('local authentication') ||
		message.includes('shared key') && message.includes('policy')
	);
}

/**
 * Wraps an async function with error handling and optional retry logic.
 * @param fn - The async function to wrap
 * @param errorPrefix - Prefix for error messages
 * @param secretsToRedact - Optional secrets to redact from error messages
 * @returns The result of the function or throws a BackendError
 */
export async function withErrorHandling<T>(
	fn: () => Promise<T>,
	errorPrefix: string,
	secretsToRedact?: string[]
): Promise<T> {
	try {
		return await fn();
	} catch (error) {
		const message = `${errorPrefix}: ${safeStringifyError(error, secretsToRedact)}`;
		throw new BackendError(message, error);
	}
}
