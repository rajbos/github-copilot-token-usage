import test from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { parseSessionFileContent } from '../../src/sessionParser';

/**
 * Integration tests that feed real sample session files through parseSessionFileContent.
 *
 * These exercise the full JSON parsing pipeline end-to-end using the sample
 * data in test/fixtures/sample-session-data/chatSessions/.
 */

const SAMPLES_DIR = path.resolve(__dirname, '..', '..', '..', 'test', 'fixtures', 'sample-session-data', 'chatSessions');

function estimateTokensByLength(text: string): number {
	return text.length;
}

/**
 * A model-extractor callback that reads modelId (with copilot/ prefix) from
 * the request, mimicking what CopilotTokenTracker would supply.  This lets us
 * verify that the callback path works correctly for JSON session files.
 */
function getModelFromRequest(req: any): string {
	const raw = req?.modelId ?? req?.model;
	if (typeof raw !== 'string' || !raw) {
		return 'gpt-4o';
	}
	return raw.startsWith('copilot/') ? raw.substring('copilot/'.length) : raw;
}

// ── Smoke test: all 5 sample files parse without error ──────────────────

const sampleFiles = fs.existsSync(SAMPLES_DIR)
	? fs.readdirSync(SAMPLES_DIR).filter(f => f.endsWith('.json'))
	: [];

for (const fileName of sampleFiles) {
	test(`integration: ${fileName} parses without error and returns non-zero tokens`, () => {
		const filePath = path.join(SAMPLES_DIR, fileName);
		const content = fs.readFileSync(filePath, 'utf-8');
		const result = parseSessionFileContent(filePath, content, estimateTokensByLength, getModelFromRequest);

		assert.ok(result.tokens > 0, `expected non-zero tokens for ${fileName}`);
		assert.ok(result.interactions > 0, `expected non-zero interactions for ${fileName}`);
		assert.ok(Object.keys(result.modelUsage).length > 0, 'expected at least one model in modelUsage');
		assert.equal(typeof result.thinkingTokens, 'number');
	});
}

// ── session-01-today.json specifics ─────────────────────────────────────

test('integration: session-01-today.json has 5 interactions and multi-model usage', () => {
	const filePath = path.join(SAMPLES_DIR, 'session-01-today.json');
	if (!fs.existsSync(filePath)) {
		return; // skip if sample data not available
	}
	const content = fs.readFileSync(filePath, 'utf-8');
	const result = parseSessionFileContent(filePath, content, estimateTokensByLength, getModelFromRequest);

	assert.equal(result.interactions, 5);
	// session-01 uses claude-sonnet-4.5, gpt-4o, o3-mini
	assert.ok(result.modelUsage['claude-sonnet-4.5'], 'should have claude-sonnet-4.5');
	assert.ok(result.modelUsage['gpt-4o'], 'should have gpt-4o');
	assert.ok(result.modelUsage['o3-mini'], 'should have o3-mini');
});

// ── Verify model detection WITHOUT callback ─────────────────────────────
// The unified processRequest helper reads request.modelId, request.selectedModel.identifier,
// and request.model — so real models are resolved even without a callback.

test('integration: session-01-today.json WITHOUT getModelFromRequest callback resolves models from modelId', () => {
	const filePath = path.join(SAMPLES_DIR, 'session-01-today.json');
	if (!fs.existsSync(filePath)) {
		return;
	}
	const content = fs.readFileSync(filePath, 'utf-8');
	// No callback — the parser now reads request.modelId directly
	const result = parseSessionFileContent(filePath, content, estimateTokensByLength);

	// Real model names should be present because processRequest reads request.modelId
	const models = Object.keys(result.modelUsage);
	assert.ok(!models.includes('unknown') || models.length > 1, 'without callback, modelId is still read — real models should appear');
	assert.ok(result.tokens > 0, 'tokens should be non-zero');
});

// ── Verify message.parts parsing ────────────────────────────────────────

test('integration: session files with message.parts have input tokens counted from parts', () => {
	const filePath = path.join(SAMPLES_DIR, 'session-01-today.json');
	if (!fs.existsSync(filePath)) {
		return;
	}
	const content = fs.readFileSync(filePath, 'utf-8');
	const session = JSON.parse(content);

	// Calculate expected input tokens from parts
	let expectedInputTokens = 0;
	for (const req of session.requests) {
		if (req.message?.parts) {
			for (const part of req.message.parts) {
				if (typeof part.text === 'string' && part.text) {
					expectedInputTokens += part.text.length;
				}
			}
		}
	}

	const result = parseSessionFileContent(filePath, content, estimateTokensByLength, getModelFromRequest);

	// Sum up all input tokens across models
	let totalInputTokens = 0;
	for (const usage of Object.values(result.modelUsage)) {
		totalInputTokens += usage.inputTokens;
	}

	assert.equal(totalInputTokens, expectedInputTokens, 'input tokens should match sum of message.parts text lengths');
});

// ── Verify response content.value extraction ────────────────────────────
// The unified processRequest now calls extractResponseAndThinkingText for both
// the JSON and delta paths, so content.value responses are correctly extracted.

test('integration: JSON path extracts output from response content.value pattern', () => {
	const filePath = path.join(SAMPLES_DIR, 'session-01-today.json');
	if (!fs.existsSync(filePath)) {
		return;
	}
	const content = fs.readFileSync(filePath, 'utf-8');
	const result = parseSessionFileContent(filePath, content, estimateTokensByLength, getModelFromRequest);

	let totalOutputTokens = 0;
	for (const usage of Object.values(result.modelUsage)) {
		totalOutputTokens += usage.outputTokens;
	}

	// The refactored path uses extractResponseAndThinkingText which handles content.value
	assert.ok(totalOutputTokens > 0, 'JSON path should extract output from response content.value');
});
