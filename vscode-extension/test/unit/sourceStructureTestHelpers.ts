/**
 * Shared helpers for structural source-text assertions (used where a class like
 * `CopilotTokenTracker` can't be instantiated in a unit test without a full VS Code host, so tests
 * instead assert invariants directly on `extension.ts`'s raw source — see instantCacheBoot.test.ts,
 * retryRefreshFlow.test.ts and analysisUpdateStatsPayload.test.ts for the pattern).
 *
 * Kept in one place so a robustness fix (or a new helper) only needs to be made once instead of
 * drifting across the files that duplicated it.
 */
import * as assert from 'node:assert/strict';

/** Extract the full `{ ... }` block starting at the first `{` found after `marker` (brace-balanced). */
export function extractBracesBlock(source: string, marker: string): string {
	const markerIndex = source.indexOf(marker);
	assert.notEqual(markerIndex, -1, `marker not found in extension.ts: ${marker}`);
	const braceStart = source.indexOf('{', markerIndex);
	assert.notEqual(braceStart, -1, `no '{' found after marker in extension.ts: ${marker}`);
	let depth = 0;
	for (let i = braceStart; i < source.length; i++) {
		if (source[i] === '{') { depth++; }
		else if (source[i] === '}') {
			depth--;
			if (depth === 0) { return source.slice(markerIndex, i + 1); }
		}
	}
	throw new Error(`unbalanced braces while scanning for marker: ${marker}`);
}
