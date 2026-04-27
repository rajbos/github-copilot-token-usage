import test from 'node:test';
import * as assert from 'node:assert/strict';

import { getModelDisplayName } from '../../src/webview/shared/modelUtils';
import {
	setFormatLocale,
	getEditorIcon,
	getCharsPerToken,
	formatFixed,
	formatPercent,
	formatNumber,
	formatCost
} from '../../src/webview/shared/formatUtils';

// ── getModelDisplayName ─────────────────────────────────────────────────

test('getModelDisplayName: returns display name for known models', () => {
	assert.equal(getModelDisplayName('gpt-4o'), 'GPT-4o');
	assert.equal(getModelDisplayName('claude-sonnet-4.5'), 'Claude Sonnet 4.5');
	assert.equal(getModelDisplayName('o3-mini'), 'o3-mini');
	assert.equal(getModelDisplayName('gpt-5'), 'GPT-5');
});

test('getModelDisplayName: returns raw model ID for unknown models', () => {
	assert.equal(getModelDisplayName('some-future-model-99'), 'some-future-model-99');
	assert.equal(getModelDisplayName(''), '');
});

// ── getEditorIcon ───────────────────────────────────────────────────────

test('getEditorIcon: returns correct icons for known editors', () => {
	assert.equal(getEditorIcon('VS Code'), '💙');
	assert.equal(getEditorIcon('Cursor'), '⚡');
	assert.equal(getEditorIcon('OpenCode'), '🟢');
	assert.equal(getEditorIcon('Unknown'), '❓');
});

test('getEditorIcon: returns fallback icon for unrecognized editors', () => {
	assert.equal(getEditorIcon('SomeNewEditor'), '📝');
});

// ── getCharsPerToken ────────────────────────────────────────────────────

test('getCharsPerToken: returns a positive number for known models', () => {
	const result = getCharsPerToken('gpt-4o');
	assert.ok(result > 0, 'chars per token should be positive');
	assert.ok(result < 20, 'chars per token should be reasonable');
});

test('getCharsPerToken: returns default for unknown models', () => {
	const result = getCharsPerToken('nonexistent-model-xyz');
	// Default ratio is 0.25, so 1/0.25 = 4
	assert.equal(result, 4);
});

// ── formatFixed ─────────────────────────────────────────────────────────

test('formatFixed: formats to specified decimal places', () => {
	setFormatLocale('en-US');
	assert.equal(formatFixed(3.14159, 2), '3.14');
	assert.equal(formatFixed(1000, 0), '1,000');
	assert.equal(formatFixed(0.5, 3), '0.500');
});

// ── formatPercent ───────────────────────────────────────────────────────

test('formatPercent: formats as percentage with default 1 decimal', () => {
	setFormatLocale('en-US');
	assert.equal(formatPercent(42.567), '42.6%');
	assert.equal(formatPercent(100, 0), '100%');
	assert.equal(formatPercent(0), '0.0%');
});

// ── formatNumber ────────────────────────────────────────────────────────

test('formatNumber: adds thousand separators', () => {
	setFormatLocale('en-US');
	assert.equal(formatNumber(1234567), '1,234,567');
	assert.equal(formatNumber(42), '42');
	assert.equal(formatNumber(0), '0');
});

// ── formatCost ──────────────────────────────────────────────────────────

test('formatCost: formats as USD with 2 decimal places', () => {
	setFormatLocale('en-US');
	const result = formatCost(1.23456789);
	assert.ok(result.includes('$'), 'should contain dollar sign');
	assert.ok(result.includes('1.23'), 'should round to 2 decimal places');
});

test('formatCost: zero cost', () => {
	setFormatLocale('en-US');
	const result = formatCost(0);
	assert.ok(result.includes('$'), 'should contain dollar sign');
	assert.ok(result.includes('0.00'), 'should show two decimal zeros');
});
