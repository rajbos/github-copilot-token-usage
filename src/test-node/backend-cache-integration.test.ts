import './vscode-shim-register';
import test from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { BackendFacade } from '../backend/facade';
import type { SessionFileCache } from '../backend/types';

/**
 * Comprehensive tests for cache integration in backend sync.
 * Covers: cache hits, cache misses, validation, error handling, interaction counting.
 */

test('Backend cache integration: uses cached data when available', async () => {
	const warnings: string[] = [];
	const logs: string[] = [];
	const now = Date.now();
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctt-cache-test-'));

	const sessionFile = path.join(tmpDir, 'test.json');
	fs.writeFileSync(
		sessionFile,
		JSON.stringify({
			lastMessageDate: now,
			requests: [
				{
					message: { parts: [{ text: 'hello' }] },
					response: [{ value: 'world' }],
					model: 'gpt-4o'
				}
			]
		}),
		'utf8'
	);

	let cacheHitCount = 0;

	const facade: any = new BackendFacade({
		context: undefined,
		log: (m) => logs.push(String(m)),
		warn: (m) => warnings.push(String(m)),
		calculateEstimatedCost: () => 0,
		co2Per1kTokens: 0.2,
		waterUsagePer1kTokens: 0.3,
		co2AbsorptionPerTreePerYear: 21000,
		getCopilotSessionFiles: async () => [sessionFile],
		estimateTokensFromText: (text: string) => (text ?? '').length,
		getModelFromRequest: (request: any) => (request?.model ?? 'gpt-4o').toString(),
		getSessionFileDataCached: async (filePath: string, mtime: number): Promise<SessionFileCache> => {
			cacheHitCount++;
			// Simulate pre-computed cache data
			return {
				tokens: 'hello'.length + 'world'.length,
				interactions: 1,
				modelUsage: {
					'gpt-4o': {
						inputTokens: 'hello'.length,
						outputTokens: 'world'.length
					}
				},
				mtime
			};
		},
		statSessionFile: async (f: string) => fs.promises.stat(f)
	});

	const { rollups } = await facade.computeDailyRollupsFromLocalSessions({ lookbackDays: 1, userId: 'u1' });
	const entries = Array.from(rollups.values());

	assert.equal(cacheHitCount, 1, 'Cache should be hit once');
	assert.ok(entries.length >= 1, 'Should have at least one rollup entry');

	const entry = entries.find((e: any) => e.key.model === 'gpt-4o');
	assert.ok(entry, 'Should have gpt-4o entry');
	assert.equal((entry as any).value.inputTokens, 'hello'.length);
	assert.equal((entry as any).value.outputTokens, 'world'.length);
	assert.equal((entry as any).value.interactions, 1, 'Should have exactly 1 interaction');

	// Verify cache performance log
	assert.ok(logs.some(l => l.includes('Cache performance')), 'Should log cache performance stats');
	assert.ok(logs.some(l => l.includes('Hits: 1')), 'Should show 1 cache hit');
});

test('Backend cache integration: falls back to parsing on cache miss', async () => {
	const warnings: string[] = [];
	const logs: string[] = [];
	const now = Date.now();
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctt-cache-miss-'));

	const sessionFile = path.join(tmpDir, 'test.json');
	fs.writeFileSync(
		sessionFile,
		JSON.stringify({
			lastMessageDate: now,
			requests: [
				{
					message: { parts: [{ text: 'test' }] },
					response: [{ value: 'result' }],
					model: 'gpt-4o'
				}
			]
		}),
		'utf8'
	);

	let cacheMissCount = 0;

	const facade: any = new BackendFacade({
		context: undefined,
		log: (m) => logs.push(String(m)),
		warn: (m) => warnings.push(String(m)),
		calculateEstimatedCost: () => 0,
		co2Per1kTokens: 0.2,
		waterUsagePer1kTokens: 0.3,
		co2AbsorptionPerTreePerYear: 21000,
		getCopilotSessionFiles: async () => [sessionFile],
		estimateTokensFromText: (text: string) => (text ?? '').length,
		getModelFromRequest: (request: any) => (request?.model ?? 'gpt-4o').toString(),
		getSessionFileDataCached: async (filePath: string, mtime: number): Promise<SessionFileCache> => {
			cacheMissCount++;
			throw new Error('ENOENT: file not found'); // Simulate cache miss
		},
		statSessionFile: async (f: string) => fs.promises.stat(f)
	});

	const { rollups } = await facade.computeDailyRollupsFromLocalSessions({ lookbackDays: 1, userId: 'u1' });
	const entries = Array.from(rollups.values());

	assert.equal(cacheMissCount, 1, 'Cache should be attempted once');
	assert.ok(entries.length >= 1, 'Should still have rollup entries (parsed from file)');

	const entry = entries.find((e: any) => e.key.model === 'gpt-4o');
	assert.ok(entry, 'Should have gpt-4o entry from fallback parsing');
	assert.equal((entry as any).value.inputTokens, 'test'.length);
	assert.equal((entry as any).value.outputTokens, 'result'.length);

	// Verify cache performance log shows cache miss
	assert.ok(logs.some(l => l.includes('Cache performance')), 'Should log cache performance');
	assert.ok(logs.some(l => l.includes('Misses: 1')), 'Should show 1 cache miss');
});

test('Backend cache integration: validates cached data and rejects invalid structures', async () => {
	const warnings: string[] = [];
	const logs: string[] = [];
	const now = Date.now();
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctt-cache-validation-'));

	// Create a session file with at least one request to trigger per-model validation
	const sessionFile = path.join(tmpDir, 'test.json');
	fs.writeFileSync(
		sessionFile,
		JSON.stringify({
			lastMessageDate: now,
			requests: [
				{
					message: { parts: [{ text: 'test' }] },
					response: [{ value: 'response' }],
					model: 'gpt-4o',
					timestamp: now
				}
			]
		}),
		'utf8'
	);

	const invalidCacheValues = [
		null, // null data
		undefined, // undefined data
		'invalid', // string instead of object
		{ modelUsage: null, interactions: 1 }, // null modelUsage
		{ modelUsage: 'invalid', interactions: 1 }, // string modelUsage
		{ modelUsage: {}, interactions: -1 }, // negative interactions
		{ modelUsage: {}, interactions: NaN }, // NaN interactions
		{ modelUsage: {}, interactions: Infinity }, // Infinity interactions
		{ modelUsage: { 'gpt-4o': { inputTokens: -1, outputTokens: 5 } }, interactions: 1 }, // negative tokens
		{ modelUsage: { 'gpt-4o': { inputTokens: NaN, outputTokens: 5 } }, interactions: 1 }, // NaN tokens
		// Note: { modelUsage: { 'gpt-4o': null } } is silently skipped (not null/missing usage objects)
		// as they simply mean the model wasn't used in this cache entry
		{ modelUsage: { 'gpt-4o': 'invalid' }, interactions: 1 } // string usage object triggers .inputTokens check
	];

	for (const invalidCache of invalidCacheValues) {
		warnings.length = 0; // Clear warnings
		logs.length = 0;

		const facade: any = new BackendFacade({
			context: undefined,
			log: (m) => logs.push(String(m)),
			warn: (m) => warnings.push(String(m)),
			calculateEstimatedCost: () => 0,
			co2Per1kTokens: 0.2,
			waterUsagePer1kTokens: 0.3,
			co2AbsorptionPerTreePerYear: 21000,
			getCopilotSessionFiles: async () => [sessionFile],
			estimateTokensFromText: (text: string) => (text ?? '').length,
			getModelFromRequest: (request: any) => (request?.model ?? 'gpt-4o').toString(),
			getSessionFileDataCached: async (): Promise<SessionFileCache> => {
				return invalidCache as any; // Return invalid cache data
			}
		,
		statSessionFile: async (f: string) => fs.promises.stat(f)
	});
		// Should fall back to parsing when cache validation fails
		// Empty requests array means no rollups from fallback, but validation warning should be logged
		assert.ok(
			warnings.some(w => w.includes('invalid')),
			`Should warn about invalid cached data (invalidCache: ${JSON.stringify(invalidCache)})`
		);
	}
});

test('Backend cache integration: counts interactions only once for multi-model files', async () => {
	const warnings: string[] = [];
	const logs: string[] = [];
	const now = Date.now();
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctt-cache-multimodel-'));

	// Create session file with requests for each model - the code requires parsing requests
	// to determine day/model combinations, then uses cache for token counts
	const sessionFile = path.join(tmpDir, 'test.json');
	fs.writeFileSync(
		sessionFile,
		JSON.stringify({
			lastMessageDate: now,
			requests: [
				// 2 requests for claude
				{ message: { parts: [{ text: 'q1' }] }, response: [{ value: 'a1' }], model: 'claude-3-5-sonnet', timestamp: now },
				{ message: { parts: [{ text: 'q2' }] }, response: [{ value: 'a2' }], model: 'claude-3-5-sonnet', timestamp: now },
				// 2 requests for gpt-4o
				{ message: { parts: [{ text: 'q3' }] }, response: [{ value: 'a3' }], model: 'gpt-4o', timestamp: now },
				{ message: { parts: [{ text: 'q4' }] }, response: [{ value: 'a4' }], model: 'gpt-4o', timestamp: now },
				// 1 request for gpt-4o-mini
				{ message: { parts: [{ text: 'q5' }] }, response: [{ value: 'a5' }], model: 'gpt-4o-mini', timestamp: now }
			]
		}),
		'utf8'
	);

	const facade: any = new BackendFacade({
		context: undefined,
		log: (m) => logs.push(String(m)),
		warn: (m) => warnings.push(String(m)),
		calculateEstimatedCost: () => 0,
		co2Per1kTokens: 0.2,
		waterUsagePer1kTokens: 0.3,
		co2AbsorptionPerTreePerYear: 21000,
		getCopilotSessionFiles: async () => [sessionFile],
		estimateTokensFromText: (text: string) => (text ?? '').length,
		getModelFromRequest: (request: any) => (request?.model ?? 'gpt-4o').toString(),
		statSessionFile: async (f: string) => fs.promises.stat(f),
		getSessionFileDataCached: async (): Promise<SessionFileCache> => {
			// Simulate cached token data for the 3 models
			return {
				tokens: 100,
				interactions: 5, // Total interactions in file
				modelUsage: {
					'claude-3-5-sonnet': { inputTokens: 10, outputTokens: 5 },
					'gpt-4o': { inputTokens: 30, outputTokens: 20 },
					'gpt-4o-mini': { inputTokens: 25, outputTokens: 15 }
				},
				mtime: now
			};
		}
	});

	const { rollups } = await facade.computeDailyRollupsFromLocalSessions({ lookbackDays: 1, userId: 'u1' });
	const entries = Array.from(rollups.values());

	// Should have 3 model entries
	assert.equal(entries.length, 3, 'Should have 3 models');

	// Calculate total interactions across all models
	const totalInteractions = entries.reduce((sum: number, e: any) => sum + e.value.interactions, 0);

	// Total interactions should equal the number of requests parsed (5)
	assert.equal(totalInteractions, 5, 'Total interactions should be 5');

	// Sort by model name to ensure consistent ordering
	const sortedEntries = entries.sort((a: any, b: any) => a.key.model.localeCompare(b.key.model));
	
	// Each model should have its actual interaction count from parsing
	assert.equal((sortedEntries[0] as any).value.interactions, 2, 'claude-3-5-sonnet should have 2 interactions');
	assert.equal((sortedEntries[1] as any).value.interactions, 2, 'gpt-4o should have 2 interactions');
	assert.equal((sortedEntries[2] as any).value.interactions, 1, 'gpt-4o-mini should have 1 interaction');
	
	// Verify token counts are from cache (not estimated from text)
	assert.equal((sortedEntries[0] as any).value.inputTokens, 10);
	assert.equal((sortedEntries[1] as any).value.inputTokens, 30);
	assert.equal((sortedEntries[2] as any).value.inputTokens, 25);
});

test('Backend cache integration: handles cache errors gracefully', async () => {
	const warnings: string[] = [];
	const logs: string[] = [];
	const now = Date.now();
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctt-cache-error-'));

	const sessionFile = path.join(tmpDir, 'test.json');
	fs.writeFileSync(
		sessionFile,
		JSON.stringify({
			lastMessageDate: now,
			requests: [
				{
					message: { parts: [{ text: 'x' }] },
					response: [{ value: 'y' }],
					model: 'gpt-4o'
				}
			]
		}),
		'utf8'
	);

	const facade: any = new BackendFacade({
		context: undefined,
		log: (m) => logs.push(String(m)),
		warn: (m) => warnings.push(String(m)),
		calculateEstimatedCost: () => 0,
		co2Per1kTokens: 0.2,
		waterUsagePer1kTokens: 0.3,
		co2AbsorptionPerTreePerYear: 21000,
		getCopilotSessionFiles: async () => [sessionFile],
		estimateTokensFromText: (text: string) => (text ?? '').length,
		getModelFromRequest: (request: any) => (request?.model ?? 'gpt-4o').toString(),
		getSessionFileDataCached: async (): Promise<SessionFileCache> => {
			throw new Error('Network timeout'); // Unexpected error
		}
	,
		statSessionFile: async (f: string) => fs.promises.stat(f)
	});

	const { rollups } = await facade.computeDailyRollupsFromLocalSessions({ lookbackDays: 1, userId: 'u1' });
	const entries = Array.from(rollups.values());

	// Should still have entries from fallback parsing
	assert.ok(entries.length >= 1, 'Should have entries from fallback parsing');

	// Should log cache error as warning
	assert.ok(
		warnings.some(w => w.includes('cache error') && w.includes('Network timeout')),
		'Should warn about cache error'
	);
});
