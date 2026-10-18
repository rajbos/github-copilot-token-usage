/**
 * Boundary / guard tests for src/claudecode.ts, written to kill surviving Stryker
 * mutants (issue #2341): directory-walk depth, token-field validation, subagent path
 * detection, metadata extraction guards and the Windows project-hash reversal.
 */
import test, { mock } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import { ClaudeCodeDataAccess, normalizeClaudeModelId } from '../../../src/claudecode';
import { toLocalDayKey } from '../../../src/utils/dayKeys';

const claudeCode = new ClaudeCodeDataAccess();

class TestableClaudeCodeDataAccess extends ClaudeCodeDataAccess {
	constructor(private readonly testDataDir: string) { super(); }
	override getClaudeCodeDataDir(): string { return this.testDataDir; }
}

function makeTmp(prefix = 'claude-boundary-test-'): string {
	return fs.mkdtempSync(path.join(process.cwd(), prefix));
}

function writeJsonl(file: string, events: any[]): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, events.map(e => JSON.stringify(e)).join('\n'), 'utf8');
}

function assistant(usage: any, extra: any = {}, message: any = {}): any {
	return { type: 'assistant', ...extra, message: { id: undefined, model: 'claude-sonnet-4-6', usage, ...message } };
}

async function withSession<T>(events: any[], fn: (file: string) => Promise<T>): Promise<T> {
	const tmp = makeTmp();
	try {
		const file = path.join(tmp, '.claude', 'projects', 'p', 's.jsonl');
		writeJsonl(file, events);
		return await fn(file);
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
}

// ----- normalizeClaudeModelId -----

test('normalizeClaudeModelId: undefined/empty input is returned as-is without throwing', () => {
	assert.equal(normalizeClaudeModelId(undefined as any), undefined);
	assert.equal(normalizeClaudeModelId(''), '');
});

test('normalizeClaudeModelId: dotted version followed by extra -d-d is left untouched (dotted check wins)', () => {
	// Only the early "already dotted" return protects these from the hyphen rewrite below.
	assert.equal(normalizeClaudeModelId('claude-sonnet-4.5-1-2'), 'claude-sonnet-4.5-1-2');
	assert.equal(normalizeClaudeModelId('claude-sonnet-12.5-1-2'), 'claude-sonnet-12.5-1-2');
	assert.equal(normalizeClaudeModelId('claude-a-b-c-4.5-1-2'), 'claude-a-b-c-4.5-1-2');
});

test('normalizeClaudeModelId: hyphen rewrite is anchored at both ends and needs a full 8-digit date', () => {
	assert.equal(normalizeClaudeModelId('myclaude-sonnet-4-6'), 'myclaude-sonnet-4-6');
	assert.equal(normalizeClaudeModelId('claude-sonnet-4-6-beta'), 'claude-sonnet-4-6-beta');
	assert.equal(normalizeClaudeModelId('claude-sonnet-4-6-2025092'), 'claude-sonnet-4-6-2025092');
	assert.equal(normalizeClaudeModelId('claude-sonnet-4-6-202509291'), 'claude-sonnet-4-6-202509291');
	assert.equal(normalizeClaudeModelId('claude-sonnet-4-6-20250929'), 'claude-sonnet-4.6');
});

// ----- isClaudeCodeSessionFile -----

test('isClaudeCodeSessionFile: requires BOTH the projects dir prefix and a .jsonl suffix', () => {
	const projects = claudeCode.getClaudeCodeProjectsDir();
	assert.equal(claudeCode.isClaudeCodeSessionFile(path.join(projects, 'h', 's.jsonl')), true);
	// Under projects/ but wrong extension
	assert.equal(claudeCode.isClaudeCodeSessionFile(path.join(projects, 'h', 's.json')), false);
	// Right extension but outside projects/
	assert.equal(claudeCode.isClaudeCodeSessionFile(path.join(os.homedir(), 'elsewhere', 's.jsonl')), false);
});

test('getClaudeCodeProjectsDir: is the "projects" folder under the data dir', () => {
	assert.equal(claudeCode.getClaudeCodeProjectsDir(), path.join(claudeCode.getClaudeCodeDataDir(), 'projects'));
	// A .jsonl directly under ~/.claude (not projects/) is not a session file.
	assert.equal(claudeCode.isClaudeCodeSessionFile(path.join(claudeCode.getClaudeCodeDataDir(), 'other', 's.jsonl')), false);
});

// ----- getClaudeCodeSessionFiles / directory walk -----

test('getClaudeCodeSessionFiles: returns [] when the projects dir does not exist', async () => {
	const tmp = makeTmp();
	try {
		const cc = new TestableClaudeCodeDataAccess(path.join(tmp, '.claude'));
		assert.deepEqual(await cc.getClaudeCodeSessionFiles(), []);
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
});

test('getClaudeCodeSessionFiles: returns [] (and logs) when the projects path is not a directory', async () => {
	const tmp = makeTmp();
	const errors = mock.method(console, 'error', () => { /* silence */ });
	try {
		const dataDir = path.join(tmp, '.claude');
		fs.mkdirSync(dataDir, { recursive: true });
		fs.writeFileSync(path.join(dataDir, 'projects'), 'not a dir', 'utf8');
		const cc = new TestableClaudeCodeDataAccess(dataDir);
		assert.deepEqual(await cc.getClaudeCodeSessionFiles(), []);
		assert.ok(errors.mock.callCount() >= 1);
		assert.equal(errors.mock.calls[0].arguments[0], '[claudecode] Failed to read projects dir:');
	} finally {
		errors.mock.restore();
		fs.rmSync(tmp, { recursive: true, force: true });
	}
});

test('getClaudeCodeSessionFiles: walks exactly 6 directory levels below a project, not 7', async () => {
	const tmp = makeTmp();
	try {
		const dataDir = path.join(tmp, '.claude');
		const project = path.join(dataDir, 'projects', 'proj');
		const atLimitDir = path.join(project, 'a', 'b', 'c', 'd', 'e', 'f'); // depth 6
		const beyondDir = path.join(atLimitDir, 'g'); // depth 7
		fs.mkdirSync(beyondDir, { recursive: true });
		const atLimit = path.join(atLimitDir, 'at-limit.jsonl');
		const beyond = path.join(beyondDir, 'beyond.jsonl');
		const top = path.join(project, 'top.jsonl');
		for (const f of [atLimit, beyond, top]) { fs.writeFileSync(f, '{"type":"user"}', 'utf8'); }

		const cc = new TestableClaudeCodeDataAccess(dataDir);
		const files = (await cc.getClaudeCodeSessionFiles()).map(f => path.normalize(f)).sort();
		assert.deepEqual(files, [path.normalize(atLimit), path.normalize(top)].sort());
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
});

test('getClaudeCodeSessionFiles: ignores non-.jsonl files even when non-empty', async () => {
	const tmp = makeTmp();
	try {
		const dataDir = path.join(tmp, '.claude');
		const project = path.join(dataDir, 'projects', 'proj');
		fs.mkdirSync(project, { recursive: true });
		fs.writeFileSync(path.join(project, 'notes.txt'), 'hello', 'utf8');
		fs.writeFileSync(path.join(project, 'sessions.json'), '{}', 'utf8');
		fs.writeFileSync(path.join(project, 'real.jsonl'), '{}', 'utf8');
		const cc = new TestableClaudeCodeDataAccess(dataDir);
		const files = await cc.getClaudeCodeSessionFiles();
		assert.deepEqual(files.map(f => path.basename(f)), ['real.jsonl']);
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
});

// ----- subagent path detection -----

test('resolveSessionFamilyRoot: subagents only counts as a marker when it has a parent segment', () => {
	const cc = claudeCode as any;
	const s = path.sep;
	// Not a subagent path → the file itself is the top-level session.
	assert.deepEqual(cc.resolveSessionFamilyRoot(['proj', 'sess.jsonl'].join(s)), { sessionId: 'sess', projectDir: 'proj' });
	// 'subagents' as the first segment has no session segment before it → treated as plain.
	assert.deepEqual(cc.resolveSessionFamilyRoot(['subagents', 'x.jsonl'].join(s)), { sessionId: 'x', projectDir: 'subagents' });
	// 'subagents' in the middle → session id is the segment before it.
	assert.deepEqual(
		cc.resolveSessionFamilyRoot(['root', 'proj', 'sid', 'subagents', 'agent.jsonl'].join(s)),
		{ sessionId: 'sid', projectDir: ['root', 'proj'].join(s) }
	);
	// Last occurrence wins.
	assert.deepEqual(
		cc.resolveSessionFamilyRoot(['root', 'subagents', 'sid', 'subagents', 'agent.jsonl'].join(s)),
		{ sessionId: 'sid', projectDir: ['root', 'subagents'].join(s) }
	);
	// 'subagents' as the very last segment (a directory path) still resolves.
	assert.deepEqual(
		cc.resolveSessionFamilyRoot(['root', 'sid', 'subagents'].join(s)),
		{ sessionId: 'sid', projectDir: 'root' }
	);
});

test('getPriorFamilyMessageIds: skips all family lookups unless subagents has a parent segment', async () => {
	const cc = new ClaudeCodeDataAccess() as any;
	let lookups = 0;
	cc.getSessionFamilyFiles = async () => { lookups++; return []; };
	const s = path.sep;

	assert.equal((await cc.getPriorFamilyMessageIds(['proj', 'sess.jsonl'].join(s))).size, 0);
	assert.equal(lookups, 0, 'absent subagents segment → fast path');

	assert.equal((await cc.getPriorFamilyMessageIds(['subagents', 'x.jsonl'].join(s))).size, 0);
	assert.equal(lookups, 0, 'subagents as first segment → fast path');

	await cc.getPriorFamilyMessageIds(['proj', 'sid', 'subagents', 'a.jsonl'].join(s));
	assert.equal(lookups, 1, 'subagents in the middle → family lookup');
});

test('getSessionFamilyFiles: lists the top-level file first, then subagent files from <sessionId>/subagents', async () => {
	const tmp = makeTmp();
	try {
		const proj = path.join(tmp, 'proj');
		const sub = path.join(proj, 'sid', 'subagents');
		const other = path.join(proj, 'sid', 'other'); // must NOT be scanned
		writeJsonl(path.join(sub, 'b.jsonl'), [{ type: 'user' }]);
		writeJsonl(path.join(sub, 'a.jsonl'), [{ type: 'user' }]);
		writeJsonl(path.join(other, 'c.jsonl'), [{ type: 'user' }]);
		const family: string[] = await (claudeCode as any).getSessionFamilyFiles(path.join(sub, 'b.jsonl'));
		assert.deepEqual(family.map(f => path.normalize(f)), [
			path.normalize(path.join(proj, 'sid.jsonl')),
			path.normalize(path.join(sub, 'a.jsonl')),
			path.normalize(path.join(sub, 'b.jsonl')),
		]);
		// With no subagents dir, only the top-level file is listed.
		const solo: string[] = await (claudeCode as any).getSessionFamilyFiles(path.join(proj, 'solo.jsonl'));
		assert.deepEqual(solo.map(f => path.normalize(f)), [path.normalize(path.join(proj, 'solo.jsonl'))]);
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
});

test('getTokensFromClaudeCodeSession: a second subagent file excludes messages claimed by an earlier sibling and the parent', async () => {
	const tmp = makeTmp();
	try {
		const proj = path.join(tmp, '.claude', 'projects', 'p');
		const U = (n: number) => ({ input_tokens: n, output_tokens: 0 });
		const top = path.join(proj, 'sid.jsonl');
		const a1 = path.join(proj, 'sid', 'subagents', 'agent-1.jsonl');
		const a2 = path.join(proj, 'sid', 'subagents', 'agent-2.jsonl');
		writeJsonl(top, [assistant(U(1), {}, { id: 'm_top' })]);
		writeJsonl(a1, [assistant(U(10), {}, { id: 'm_a1' }), assistant(U(1), {}, { id: 'm_top' })]);
		writeJsonl(a2, [assistant(U(100), {}, { id: 'm_a2' }), assistant(U(10), {}, { id: 'm_a1' }), assistant(U(1), {}, { id: 'm_top' })]);
		assert.equal((await claudeCode.getTokensFromClaudeCodeSession(top)).tokens, 1);
		assert.equal((await claudeCode.getTokensFromClaudeCodeSession(a1)).tokens, 10);
		assert.equal((await claudeCode.getTokensFromClaudeCodeSession(a2)).tokens, 100);
		const usage2 = await claudeCode.getClaudeCodeModelUsage(a2);
		assert.equal(usage2['claude-sonnet-4.6'].inputTokens, 100);
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
});

test('getClaudeCodeDailyFractions: a subagent file does not bucket messages already claimed by the parent', async () => {
	const tmp = makeTmp();
	try {
		const proj = path.join(tmp, '.claude', 'projects', 'p');
		const top = path.join(proj, 'sid.jsonl');
		const sub = path.join(proj, 'sid', 'subagents', 'agent-1.jsonl');
		const dayA = '2026-03-10T12:00:00.000Z';
		const dayB = '2026-03-12T12:00:00.000Z';
		writeJsonl(top, [assistant({ input_tokens: 50 }, { timestamp: dayA }, { id: 'm_shared' })]);
		writeJsonl(sub, [
			assistant({ input_tokens: 50 }, { timestamp: dayA }, { id: 'm_shared' }),
			assistant({ input_tokens: 10 }, { timestamp: dayB }, { id: 'm_own' }),
		]);
		const fractions = await claudeCode.getClaudeCodeDailyFractions(sub);
		assert.deepEqual(fractions, { [toLocalDayKey(new Date(dayB))]: 1 });
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
});

// ----- token field validation -----

test('getTokensFromClaudeCodeSession: each usage field contributes only when it is a number (0 and negatives included)', async () => {
	const cases: Array<[any, number]> = [
		[{ input_tokens: 5, output_tokens: 7, cache_creation_input_tokens: 11, cache_read_input_tokens: 13 }, 36],
		[{ input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }, 0],
		[{ input_tokens: -1, output_tokens: 0 }, -1],
		[{ input_tokens: 0, output_tokens: -1 }, -1],
		[{ input_tokens: 0, cache_creation_input_tokens: -1 }, -1],
		[{ input_tokens: 0, cache_read_input_tokens: -1 }, -1],
		// non-number values must be ignored, not coerced
		[{ input_tokens: '5', output_tokens: 7 }, 7],
		[{ input_tokens: 5, output_tokens: '7' }, 5],
		[{ input_tokens: 5, output_tokens: null }, 5],
		[{ input_tokens: 5, cache_creation_input_tokens: '11' }, 5],
		[{ input_tokens: 5, cache_read_input_tokens: '13' }, 5],
		[{ input_tokens: 5, cache_creation_input_tokens: null, cache_read_input_tokens: null }, 5],
	];
	for (const [usage, expected] of cases) {
		await withSession([assistant(usage, {}, { id: 'm1' })], async file => {
			const r = await claudeCode.getTokensFromClaudeCodeSession(file);
			assert.equal(r.tokens, expected, `usage ${JSON.stringify(usage)}`);
		});
	}
});

test('getClaudeCodeModelUsage: zero cache fields record no cache keys; positive ones do, with exact totals', async () => {
	await withSession([assistant({ input_tokens: 4, output_tokens: 6, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, cache_creation: { ephemeral_1h_input_tokens: 0 } }, {}, { id: 'm1' })], async file => {
		const u = (await claudeCode.getClaudeCodeModelUsage(file))['claude-sonnet-4.6'];
		assert.equal(u.inputTokens, 4);
		assert.equal(u.outputTokens, 6);
		assert.equal('cacheCreationTokens' in u, false);
		assert.equal('cacheCreation1hTokens' in u, false);
		assert.equal('cachedReadTokens' in u, false);
	});

	await withSession([assistant({ input_tokens: 4, output_tokens: 6, cache_creation_input_tokens: 20, cache_read_input_tokens: 30, cache_creation: { ephemeral_1h_input_tokens: 8 } }, {}, { id: 'm1' })], async file => {
		const u = (await claudeCode.getClaudeCodeModelUsage(file))['claude-sonnet-4.6'];
		assert.equal(u.inputTokens, 4 + 20 + 30);
		assert.equal(u.outputTokens, 6);
		assert.equal(u.cacheCreationTokens, 20);
		assert.equal(u.cacheCreation1hTokens, 8);
		assert.equal(u.cachedReadTokens, 30);
	});
});

test('getClaudeCodeModelUsage: negative cache fields are not recorded as cache keys', async () => {
	await withSession([assistant({ input_tokens: 4, output_tokens: 6, cache_creation_input_tokens: -1, cache_read_input_tokens: -1, cache_creation: { ephemeral_1h_input_tokens: -1 } }, {}, { id: 'm1' })], async file => {
		const u = (await claudeCode.getClaudeCodeModelUsage(file))['claude-sonnet-4.6'];
		assert.equal('cacheCreationTokens' in u, false);
		assert.equal('cacheCreation1hTokens' in u, false);
		assert.equal('cachedReadTokens' in u, false);
	});
});

test('getClaudeCodeModelUsage: non-numeric cache/output fields are ignored rather than coerced', async () => {
	const usage = { input_tokens: 4, output_tokens: '6', cache_creation_input_tokens: '20', cache_read_input_tokens: '30', cache_creation: { ephemeral_1h_input_tokens: '8' } };
	await withSession([assistant(usage, {}, { id: 'm1' })], async file => {
		const u = (await claudeCode.getClaudeCodeModelUsage(file))['claude-sonnet-4.6'];
		assert.equal(u.inputTokens, 4);
		assert.equal(u.outputTokens, 0);
		assert.equal('cacheCreationTokens' in u, false);
		assert.equal('cacheCreation1hTokens' in u, false);
		assert.equal('cachedReadTokens' in u, false);
	});
});

test('getClaudeCodeModelUsage: missing model falls back to "unknown"; unsafe keys are skipped', async () => {
	await withSession([
		assistant({ input_tokens: 3 }, {}, { id: 'm1', model: undefined }),
		assistant({ input_tokens: 5 }, {}, { id: 'm2', model: '__proto__' }),
		assistant({ input_tokens: 7 }, {}, { id: 'm3', model: 'constructor' }),
		assistant({ input_tokens: 9 }, {}, { id: 'm4', model: 'prototype' }),
	], async file => {
		const usage = await claudeCode.getClaudeCodeModelUsage(file);
		assert.deepEqual(Object.keys(usage), ['unknown']);
		assert.equal(usage['unknown'].inputTokens, 3);
		assert.equal(({} as any).inputTokens, undefined, 'Object.prototype must not be polluted');
	});
});

test('deduplicateAssistantEvents: assistant events without a message are skipped, not thrown on', async () => {
	await withSession([
		{ type: 'assistant' },
		assistant({ input_tokens: 2 }, {}, { id: 'm1' }),
	], async file => {
		assert.equal((await claudeCode.getTokensFromClaudeCodeSession(file)).tokens, 2);
	});
});

// ----- daily fractions -----

test('getClaudeCodeDailyFractions: zero, negative and bad-timestamp events are not bucketed', async () => {
	const dayA = '2026-03-10T12:00:00.000Z';
	const dayB = '2026-03-12T12:00:00.000Z';
	const dayC = '2026-03-14T12:00:00.000Z';
	await withSession([
		assistant({ input_tokens: 0, output_tokens: 0 }, { timestamp: dayA }, { id: 'zero' }),
		assistant({ input_tokens: -5 }, { timestamp: dayC }, { id: 'neg' }),
		assistant({ input_tokens: 40 }, { timestamp: 'not-a-date' }, { id: 'badts' }),
		assistant({ input_tokens: 40 }, {}, { id: 'nots' }),
		assistant({ input_tokens: 10 }, { timestamp: dayB }, { id: 'ok' }),
	], async file => {
		const fractions = await claudeCode.getClaudeCodeDailyFractions(file);
		assert.deepEqual(fractions, { [toLocalDayKey(new Date(dayB))]: 1 });
	});
});

test('getClaudeCodeDailyFractions: an empty session falls back to today without throwing', async () => {
	await withSession([], async file => {
		const fractions = await claudeCode.getClaudeCodeDailyFractions(file);
		assert.deepEqual(fractions, { [toLocalDayKey(new Date())]: 1 });
	});
});

// ----- countClaudeCodeInteractions guards -----

test('countClaudeCodeInteractions: ignores sidechain turns, non-user roles and events without a message', async () => {
	const human = { type: 'user', message: { role: 'user', content: 'hello' } };
	await withSession([
		human,
		{ type: 'user', isSidechain: true, message: { role: 'user', content: 'sidechain' } },
		{ type: 'user', message: { role: 'assistant', content: 'wrong role' } },
		{ type: 'user' },
		{ type: 'assistant', message: { role: 'user', content: 'wrong type' } },
	], async file => {
		assert.equal(await claudeCode.countClaudeCodeInteractions(file), 1);
	});
});

// ----- session meta -----

test('getClaudeCodeSessionMeta: no timestamps → undefined first/last interaction (no throw)', async () => {
	await withSession([{ type: 'ai-title', aiTitle: 'T' }], async file => {
		const meta = await claudeCode.getClaudeCodeSessionMeta(file);
		assert.equal(meta?.title, 'T');
		assert.equal(meta?.firstInteraction, undefined);
		assert.equal(meta?.lastInteraction, undefined);
	});
});

test('getClaudeCodeSessionMeta: invalid timestamps are dropped; valid ones are sorted regardless of order', async () => {
	await withSession([
		{ type: 'user', timestamp: '2026-03-12T00:00:00.000Z' },
		{ type: 'user', timestamp: 'garbage' },
		{ type: 'user', timestamp: '2026-03-10T00:00:00.000Z' },
		{ type: 'user', timestamp: '2026-03-11T00:00:00.000Z' },
	], async file => {
		const meta = await claudeCode.getClaudeCodeSessionMeta(file);
		assert.equal(meta?.firstInteraction, '2026-03-10T00:00:00.000Z');
		assert.equal(meta?.lastInteraction, '2026-03-12T00:00:00.000Z');
	});
	await withSession([{ type: 'user', timestamp: 'garbage' }], async file => {
		const meta = await claudeCode.getClaudeCodeSessionMeta(file);
		assert.equal(meta?.firstInteraction, undefined);
	});
});

test('getClaudeCodeSessionMeta: titles only come from their own event type and are not clobbered by later events', async () => {
	await withSession([
		{ type: 'user', aiTitle: 'wrong-type-ai', customTitle: 'wrong-type-custom' },
		{ type: 'ai-title', aiTitle: 'AI' },
		{ type: 'ai-title' },
		{ type: 'user' },
	], async file => {
		assert.equal((await claudeCode.getClaudeCodeSessionMeta(file))?.title, 'AI');
	});
	await withSession([
		{ type: 'user', customTitle: 'wrong-type-custom' },
		{ type: 'custom-title', customTitle: 'Custom' },
		{ type: 'custom-title' },
		{ type: 'user' },
	], async file => {
		assert.equal((await claudeCode.getClaudeCodeSessionMeta(file))?.title, 'Custom');
	});
	await withSession([{ type: 'user', aiTitle: 'x' }, { type: 'ai-title' }, { type: 'custom-title' }], async file => {
		assert.equal((await claudeCode.getClaudeCodeSessionMeta(file))?.title, undefined);
	});
});

test('getClaudeCodeSessionMeta: entrypoint and cwd keep the first non-empty value', async () => {
	await withSession([
		{ type: 'user' },
		{ type: 'user', entrypoint: 'cli', cwd: '/first' },
		{ type: 'user', entrypoint: 'claude-vscode', cwd: '/second' },
		{ type: 'user' },
	], async file => {
		const meta = await claudeCode.getClaudeCodeSessionMeta(file);
		assert.equal(meta?.entrypoint, 'cli');
		assert.equal(meta?.cwd, '/first');
	});
	await withSession([{ type: 'user' }], async file => {
		const meta = await claudeCode.getClaudeCodeSessionMeta(file);
		assert.equal(meta?.entrypoint, undefined);
		assert.equal(meta?.cwd, undefined);
	});
});

// ----- readSessionEvents -----

test('session parsing: blank lines and malformed lines are skipped, other lines kept', async () => {
	const tmp = makeTmp();
	try {
		const file = path.join(tmp, '.claude', 'projects', 'p', 's.jsonl');
		fs.mkdirSync(path.dirname(file), { recursive: true });
		const a = JSON.stringify(assistant({ input_tokens: 1 }, {}, { id: 'a' }));
		const b = JSON.stringify(assistant({ input_tokens: 2 }, {}, { id: 'b' }));
		fs.writeFileSync(file, `${a}\n   \n{not json\n\n${b}\n`, 'utf8');
		assert.equal((await claudeCode.getTokensFromClaudeCodeSession(file)).tokens, 3);
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
});

test('session parsing: a missing file yields no events', async () => {
	const tmp = makeTmp();
	const errors = mock.method(console, 'error', () => { /* silence expected ENOENT log */ });
	try {
		const file = path.join(tmp, 'does-not-exist.jsonl');
		assert.equal((await claudeCode.getTokensFromClaudeCodeSession(file)).tokens, 0);
		assert.equal(await claudeCode.getClaudeCodeSessionMeta(file), null);
	} finally {
		errors.mock.restore();
		fs.rmSync(tmp, { recursive: true, force: true });
	}
});

// ----- getProjectPathFromHash -----

test('getProjectPathFromHash: win32 drive-letter hashes become drive paths, everything else a rooted POSIX-style path', () => {
	const realOs = require('node:os');
	const platform = mock.method(realOs, 'platform', () => 'win32');
	try {
		assert.equal(claudeCode.getProjectPathFromHash('c--Users-me-code'), 'C:\\Users\\me\\code');
		assert.equal(claudeCode.getProjectPathFromHash('c--'), 'C:\\');
		assert.equal(claudeCode.getProjectPathFromHash('c-'), 'C:\\');
		// Two-letter first segment is not a drive letter
		assert.equal(claudeCode.getProjectPathFromHash('ab--x'), '/ab//x');
		// Single letter but no empty second segment
		assert.equal(claudeCode.getProjectPathFromHash('c-x-y'), '/c/x/y');
		// Fewer than two segments
		assert.equal(claudeCode.getProjectPathFromHash('c'), '/c');
	} finally {
		platform.mock.restore();
	}
});

test('getProjectPathFromHash: non-win32 never produces a drive path', () => {
	const realOs = require('node:os');
	const platform = mock.method(realOs, 'platform', () => 'linux');
	try {
		assert.equal(claudeCode.getProjectPathFromHash('c--Users-me'), '/c//Users/me');
	} finally {
		platform.mock.restore();
	}
});
