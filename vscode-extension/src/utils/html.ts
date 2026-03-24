/**
 * HTML utility functions for safe string escaping.
 */

/**
 * Escapes HTML special characters to prevent XSS.
 * @param value - The value to escape
 * @returns HTML-escaped string
 */
export function escapeHtml(value: unknown): string {
	return String(value ?? '')
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

/**
 * Escapes a value for safe use in HTML attributes.
 * @param value - The value to escape
 * @returns Attribute-safe escaped string
 */
export function escapeAttr(value: unknown): string {
	return escapeHtml(value);
}

/**
 * Safely encodes JSON for embedding in inline <script> tags.
 * Prevents breaking out of script context via </script> or other injection vectors.
 * @param value - The value to encode
 * @returns Safely encoded JSON string
 */
export function safeJsonForInlineScript(value: unknown): string {
	return JSON.stringify(value)
		.replace(/</g, '\\u003c')
		.replace(/>/g, '\\u003e')
		.replace(/&/g, '\\u0026')
		.replace(/\u2028/g, '\\u2028')
		.replace(/\u2029/g, '\\u2029');
}
