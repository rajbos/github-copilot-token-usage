/**
 * Unit tests for the `memory-files` CLI command's threshold parsing.
 * Tests resolveMemoryFilesThresholds() in cli/src/commands/memory-files.ts
 */

import test from 'node:test';
import * as assert from 'node:assert/strict';

import { resolveMemoryFilesThresholds } from '../commands/memory-files';
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
