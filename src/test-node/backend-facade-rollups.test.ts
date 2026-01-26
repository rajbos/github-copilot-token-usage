import test from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { BackendFacade } from '../backend/facade';
import type { DailyRollupMapEntryLike } from '../backend/rollups';

test('BackendFacade computes daily rollups from JSONL and JSON sessions (and skips malformed/out-of-range)', async () => {
	const warnings: string[] = [];
	const now = Date.now();
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctt-rollups-'));

	const jsonlPath = path.join(tmpDir, '.copilot', 'session-state', 's.jsonl');
	fs.mkdirSync(path.dirname(jsonlPath), { recursive: true });
	fs.writeFileSync(
		jsonlPath,
		[
			JSON.stringify({
				timestamp: new Date(now).toISOString(),
				type: 'user.message',
				model: 'gpt-4.1',
				data: { content: 'hi' }
			}),
			JSON.stringify({
				timestamp: new Date(now).toISOString(),
				type: 'assistant.message',
				model: 'gpt-4.1',
				data: { content: 'yo' }
			}),
			JSON.stringify({
				timestamp: new Date(now).toISOString(),
				type: 'tool.result',
				model: 'gpt-4.1',
				data: { output: 'out' }
			}),
			'{ not valid json',
			JSON.stringify({
				timestamp: new Date(now - 1000 * 60 * 60 * 24 * 365).toISOString(),
				type: 'user.message',
				model: 'gpt-4.1',
				data: { content: 'too old' }
			})
		].join('\n') + '\n',
		'utf8'
	);

	const jsonPath = path.join(
		tmpDir,
		'Code',
		'User',
		'workspaceStorage',
		'abc123',
		'github.copilot-chat',
		'chatSessions',
		's.json'
	);
	fs.mkdirSync(path.dirname(jsonPath), { recursive: true });
	fs.writeFileSync(
		jsonPath,
		JSON.stringify({
			lastMessageDate: now,
			requests: [
				{
					// No per-request timestamp: should fall back to lastMessageDate
					message: { parts: [{ text: 'abc' }] },
					response: [{ value: 'def' }],
					model: 'gpt-4o'
				},
				{
					timestamp: now,
					message: { parts: [{ text: '' }] },
					response: [{ value: '' }]
				}
			]
		}),
		'utf8'
	);

	const invalidJsonPath = path.join(tmpDir, 'broken.json');
	fs.writeFileSync(invalidJsonPath, '{', 'utf8');

	const missingPath = path.join(tmpDir, 'missing.json');

	const facade: any = new BackendFacade({
		context: undefined,
		log: () => undefined,
		warn: (m) => warnings.push(String(m)),
		calculateEstimatedCost: () => 0,
		co2Per1kTokens: 0.2,
		waterUsagePer1kTokens: 0.3,
		co2AbsorptionPerTreePerYear: 21000,
		getCopilotSessionFiles: async () => [jsonlPath, jsonPath, invalidJsonPath, missingPath],
		estimateTokensFromText: (text: string) => (text ?? '').length,
		getModelFromRequest: (request: any) => (request?.model ?? 'gpt-4o').toString()
	});

	const { rollups } = await facade.computeDailyRollupsFromLocalSessions({ lookbackDays: 1, userId: 'u1' });
	const entries = Array.from(rollups.values()) as DailyRollupMapEntryLike[];
	assert.ok(entries.length >= 2);

	const cliEntry = entries.find((e) => e.key.workspaceId === 'copilot-cli' && e.key.model === 'gpt-4.1');
	assert.ok(cliEntry);
	assert.equal(cliEntry.value.interactions, 1);
	assert.equal(cliEntry.value.inputTokens, 'hi'.length + 'out'.length);
	assert.equal(cliEntry.value.outputTokens, 'yo'.length);

	const vscodeEntry = entries.find((e) => e.key.workspaceId === 'abc123' && e.key.model === 'gpt-4o');
	assert.ok(vscodeEntry);
	assert.equal(vscodeEntry.value.interactions, 1);
	assert.equal(vscodeEntry.value.inputTokens, 'abc'.length);
	assert.equal(vscodeEntry.value.outputTokens, 'def'.length);

	assert.ok(warnings.some((w) => w.includes('failed to parse JSON session file')));
	// After cache integration, missing files are caught at stat stage
	assert.ok(warnings.some((w) => w.includes('failed to stat session file') || w.includes('failed to read session file')));
});
