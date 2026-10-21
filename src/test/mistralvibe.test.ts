import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { MistralVibeDataAccess } from '../mistralvibe';

/** Writes a synthetic meta.json (no real session data) and returns its path plus cleanup. */
function writeMeta(meta: unknown): { metaPath: string; cleanup: () => void } {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-meta-'));
	const metaPath = path.join(dir, 'meta.json');
	fs.writeFileSync(metaPath, JSON.stringify(meta));
	return { metaPath, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const da = new MistralVibeDataAccess();

test('getSessionStats: reads every extra stat, converting last_turn_duration seconds to ms', async () => {
	const { metaPath, cleanup } = writeMeta({ stats: {
		tokens_per_second: 100.5, last_turn_duration: 2.5, session_cost: 0.0123, steps: 12,
		tool_calls_succeeded: 9, tool_calls_failed: 1, tool_calls_rejected: 2, tool_calls_agreed: 3, tool_calls_hook_denied: 4,
	} });
	try {
		assert.deepEqual(await da.getSessionStats(metaPath), {
			tokensPerSecond: 100.5, lastTurnDurationMs: 2500, sessionCostReported: 0.0123, steps: 12,
			toolCallsSucceeded: 9, toolCallsFailed: 1, toolCallsRejected: 2, toolCallsAgreed: 3, toolCallsHookDenied: 4,
		});
	} finally { cleanup(); }
});

test('getSessionStats: absent fields are undefined, never 0', async () => {
	const { metaPath, cleanup } = writeMeta({ stats: { session_prompt_tokens: 10 } });
	try {
		const s = await da.getSessionStats(metaPath);
		for (const value of Object.values(s)) { assert.equal(value, undefined); }
	} finally { cleanup(); }
});

test('getSessionStats: malformed values are ignored; a real 0 is kept', async () => {
	const { metaPath, cleanup } = writeMeta({ stats: {
		tokens_per_second: '50', last_turn_duration: -1, session_cost: null, steps: Number.MAX_VALUE * 2,
		tool_calls_succeeded: 0, tool_calls_failed: {}, tool_calls_rejected: [], tool_calls_agreed: true,
	} });
	try {
		const s = await da.getSessionStats(metaPath);
		assert.equal(s.tokensPerSecond, undefined);
		assert.equal(s.lastTurnDurationMs, undefined);
		assert.equal(s.sessionCostReported, undefined);
		assert.equal(s.steps, undefined);
		assert.equal(s.toolCallsSucceeded, 0);
		assert.equal(s.toolCallsFailed, undefined);
		assert.equal(s.toolCallsRejected, undefined);
		assert.equal(s.toolCallsAgreed, undefined);
	} finally { cleanup(); }
});

test('getSessionStats: missing file, missing stats and non-object stats yield an empty result', async () => {
	assert.deepEqual(await da.getSessionStats(path.join(os.tmpdir(), 'no-such-vibe', 'meta.json')), {});
	const a = writeMeta({ config: {} });
	const b = writeMeta({ stats: 'oops' });
	try {
		assert.deepEqual(await da.getSessionStats(a.metaPath), {});
		assert.deepEqual(await da.getSessionStats(b.metaPath), {});
	} finally { a.cleanup(); b.cleanup(); }
});

test('getModelUsage: cached-token clamp and session_cost do not change the token attribution', async () => {
	const { metaPath, cleanup } = writeMeta({
		config: { active_model: 'm' },
		stats: { session_prompt_tokens: 100, session_completion_tokens: 5, session_cached_tokens: 900, session_cost: 99 },
	});
	try {
		const usage = await da.getModelUsage(metaPath);
		assert.equal(usage['m'].cachedReadTokens, 100);
		assert.equal(usage['m'].inputTokens, 100);
		assert.equal(usage['m'].outputTokens, 5);
	} finally { cleanup(); }
});
