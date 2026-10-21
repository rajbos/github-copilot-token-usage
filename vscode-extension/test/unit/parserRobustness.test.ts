/**
 * Robustness tests for session-log parsers/adapters that read untrusted,
 * on-disk files written by other tools (Copilot Chat, Copilot CLI, Claude
 * Code, JetBrains, Gemini CLI, Antigravity, OpenCode).
 *
 * These exercise the hardening added for:
 *   - resource exhaustion: a single oversized file must not be read unbounded
 *     (see src/utils/safeFileRead.ts)
 *   - prototype pollution: a "model" (or similar) string pulled from parsed
 *     JSON must not be usable to write through Object.prototype via bracket
 *     notation (see src/utils/protoGuard.ts)
 *
 * Every test asserts the parser does not throw and does not pollute
 * Object.prototype, and that malformed/oversized input degrades to an
 * empty/default result rather than partial or corrupted data.
 */
import test from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { ClaudeCodeDataAccess } from '../../../src/claudecode';
import { GeminiCliDataAccess } from '../../../src/geminicli';
import { AntigravityDataAccess } from '../../../src/antigravity';
import { OpenCodeDataAccess } from '../../../src/opencode';
import { parseJetBrainsPartition } from '../../../src/jetbrains';
import { CopilotChatAdapter } from '../../../src/adapters/copilotChatAdapter';
import { MAX_SESSION_FILE_BYTES, readTextFileWithSizeGuard, readTextFileWithSizeGuardSync } from '../../../src/utils/safeFileRead';
import { isUnsafeObjectKey } from '../../../src/utils/protoGuard';
import { ContinueDataAccess } from '../../../src/continue';
import { KiroDataAccess } from '../../../src/kiro';
import { ClineDataAccess } from '../../../src/cline';
import { PiDataAccess } from '../../../src/pi';
import { ClaudeDesktopDataAccess } from '../../../src/claudedesktop';
import { EclipseDataAccess } from '../../../src/eclipse';
import { MistralVibeDataAccess } from '../../../src/mistralvibe';
import { TokenAccumulator } from '../../../src/sessionParser';
import { addModelUsage } from '../../../src/statsHelpers';

function assertNoPrototypePollution(): void {
	assert.equal(({} as any).polluted, undefined, 'Object.prototype must not be polluted');
	assert.equal(Object.prototype.hasOwnProperty.call(Object.prototype, 'polluted'), false);
}

/** Builds a deeply nested JSON string of `depth` levels without recursive construction. */
function buildDeeplyNestedJson(depth: number): string {
	return '{"a":'.repeat(depth) + '1' + '}'.repeat(depth);
}

function mkTmpDir(prefix: string): string {
	return fs.mkdtempSync(path.join(process.cwd(), prefix));
}

function rm(dir: string): void {
	try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

/** Writes `size` bytes of filler efficiently (no huge in-memory JS string concatenation). */
function writeOversizedFile(filePath: string, size: number): void {
	const fd = fs.openSync(filePath, 'w');
	try {
		const chunk = Buffer.alloc(1024 * 1024, 0x78); // 1 MiB of 'x'
		let written = 0;
		while (written < size) {
			const remaining = size - written;
			const toWrite = remaining < chunk.length ? chunk.subarray(0, remaining) : chunk;
			fs.writeSync(fd, toWrite);
			written += toWrite.length;
		}
	} finally {
		fs.closeSync(fd);
	}
}

// ---------------------------------------------------------------------------
// Claude Code
// ---------------------------------------------------------------------------

test('ClaudeCode: truncated JSONL line is skipped without throwing', async () => {
	const tmpDir = mkTmpDir('claudecode-robust-');
	try {
		const projectDir = path.join(tmpDir, '.claude', 'projects', 'p');
		fs.mkdirSync(projectDir, { recursive: true });
		const file = path.join(projectDir, 's.jsonl');
		fs.writeFileSync(file, '{"type":"assistant","message":{"model":"claude-sonnet-4-6","usage":{"input_to', 'utf8');
		const cc = new ClaudeCodeDataAccess();
		const result = await cc.getTokensFromClaudeCodeSession(file);
		assert.equal(result.tokens, 0);
	} finally {
		rm(tmpDir);
	}
});

test('ClaudeCode: file over the size cap is skipped, not read into memory', async () => {
	const tmpDir = mkTmpDir('claudecode-robust-');
	try {
		const projectDir = path.join(tmpDir, '.claude', 'projects', 'p');
		fs.mkdirSync(projectDir, { recursive: true });
		const file = path.join(projectDir, 'huge.jsonl');
		writeOversizedFile(file, MAX_SESSION_FILE_BYTES + 1024);
		const cc = new ClaudeCodeDataAccess();
		const result = await cc.getTokensFromClaudeCodeSession(file);
		assert.equal(result.tokens, 0);
		assert.equal(result.thinkingTokens, 0);
	} finally {
		rm(tmpDir);
	}
});

test('ClaudeCode: deeply nested JSON does not crash the process', async () => {
	const tmpDir = mkTmpDir('claudecode-robust-');
	try {
		const projectDir = path.join(tmpDir, '.claude', 'projects', 'p');
		fs.mkdirSync(projectDir, { recursive: true });
		const file = path.join(projectDir, 's.jsonl');
		fs.writeFileSync(file, buildDeeplyNestedJson(100_000), 'utf8');
		const cc = new ClaudeCodeDataAccess();
		const result = await cc.getTokensFromClaudeCodeSession(file);
		assert.equal(result.tokens, 0); // malformed line for this schema — skipped, not a crash
	} finally {
		rm(tmpDir);
	}
});

test('ClaudeCode: __proto__ model key does not pollute Object.prototype', async () => {
	const tmpDir = mkTmpDir('claudecode-robust-');
	try {
		const projectDir = path.join(tmpDir, '.claude', 'projects', 'p');
		fs.mkdirSync(projectDir, { recursive: true });
		const file = path.join(projectDir, 's.jsonl');
		const events = [
			{
				type: 'assistant',
				message: {
					model: '__proto__',
					stop_reason: 'end_turn',
					usage: { input_tokens: 10, output_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
				}
			}
		];
		fs.writeFileSync(file, events.map(e => JSON.stringify(e)).join('\n'), 'utf8');
		const cc = new ClaudeCodeDataAccess();
		const modelUsage = await cc.getClaudeCodeModelUsage(file);
		assertNoPrototypePollution();
		assert.equal(Object.prototype.hasOwnProperty.call(modelUsage, '__proto__'), false);
	} finally {
		rm(tmpDir);
	}
});

// ---------------------------------------------------------------------------
// Copilot Chat
// ---------------------------------------------------------------------------

test('CopilotChatAdapter: truncated JSONL line is handled without throwing', async () => {
	const tmpDir = mkTmpDir('copilotchat-robust-');
	try {
		const file = path.join(tmpDir, 'session.jsonl');
		fs.writeFileSync(file, '{"kind":1,"data":{"model":"gpt-4o","requestI', 'utf8');
		const adapter = new CopilotChatAdapter();
		const result = await adapter.getTokens(file);
		assert.equal(typeof result.tokens, 'number');
	} finally {
		rm(tmpDir);
	}
});

test('CopilotChatAdapter: file over the size cap is skipped', async () => {
	const tmpDir = mkTmpDir('copilotchat-robust-');
	try {
		const file = path.join(tmpDir, 'session.jsonl');
		writeOversizedFile(file, MAX_SESSION_FILE_BYTES + 1024);
		const adapter = new CopilotChatAdapter();
		const result = await adapter.getTokens(file);
		assert.equal(result.tokens, 0);
		assert.equal(result.actualTokens, 0);
	} finally {
		rm(tmpDir);
	}
});

test('safeFileRead: rejects OS temp directory paths before opening', async () => {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'safe-read-'));
	const symlinkDir = path.join(path.dirname(tmpDir), `safe-read-link-${Date.now()}`);
	try {
		try {
			fs.symlinkSync(tmpDir, symlinkDir, process.platform === 'win32' ? 'junction' : 'dir');
		} catch (err) {
			const code = (err as NodeJS.ErrnoException)?.code;
			if (code === 'EPERM' || code === 'EACCES' || code === 'ENOTSUP') {
				return;
			}
			throw err;
		}
		const file = path.join(symlinkDir, 'session.jsonl');
		assert.equal(await readTextFileWithSizeGuard(file, 'temp-dir-guard'), undefined);
		assert.equal(readTextFileWithSizeGuardSync(file, 'temp-dir-guard'), undefined);
	} finally {
		try {
			fs.rmSync(symlinkDir, { force: true, recursive: true });
		} catch {
			// noop: symlink dir may already be cleaned up or unsupported on this platform
		}
		rm(tmpDir);
	}
});

test('safeFileRead: temp-root detection result stays stable after memoization', async () => {
	// Use mkdtempSync (not a predictable path.join(os.tmpdir(), ...) name) so the
	// directory itself is created securely; only the file within it is used here.
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'safe-read-stable-'));
	try {
		const tempFile = path.join(tmpDir, 'session.jsonl');
		fs.writeFileSync(tempFile, '{"kind":2}', 'utf8');
		assert.equal(await readTextFileWithSizeGuard(tempFile, 'temp-stable-first'), undefined);
		assert.equal(await readTextFileWithSizeGuard(tempFile, 'temp-stable-second'), undefined);
		assert.equal(readTextFileWithSizeGuardSync(tempFile, 'temp-stable-sync'), undefined);
	} finally {
		rm(tmpDir);
	}
});

// ---------------------------------------------------------------------------
// JetBrains
// ---------------------------------------------------------------------------

test('JetBrains: truncated JSONL line does not throw', () => {
	const parsed = parseJetBrainsPartition('{"type":"user.message","data":{"content":"trunca');
	assert.ok(parsed);
	assert.equal(parsed.tokens, 0);
});

test('JetBrains: deeply nested JSON line does not crash the process', () => {
	const content = buildDeeplyNestedJson(100_000);
	assert.doesNotThrow(() => parseJetBrainsPartition(content));
});

test('JetBrains: __proto__ modelHint does not pollute Object.prototype', () => {
	// modelHint is derived internally from turn-start events, not attacker-set text directly,
	// but the finalize step still guards any dangerous key before indexing modelUsage.
	const content = [
		JSON.stringify({ type: 'assistant.turn_start', data: { model: '__proto__' } }),
		JSON.stringify({ type: 'tool.execution_start', data: {} }),
		JSON.stringify({ type: 'assistant.message', data: { content: 'hi' } }),
	].join('\n');
	const parsed = parseJetBrainsPartition(content);
	assertNoPrototypePollution();
	assert.equal(Object.prototype.hasOwnProperty.call(parsed.modelUsage, '__proto__'), false);
});

// ---------------------------------------------------------------------------
// Gemini CLI
// ---------------------------------------------------------------------------

function createTempGeminiSession(records: unknown[]): { file: string; tmpDir: string } {
	const tmpDir = mkTmpDir('gemini-robust-');
	const chatsDir = path.join(tmpDir, '.gemini', 'tmp', 'demo-project', 'chats');
	fs.mkdirSync(chatsDir, { recursive: true });
	const file = path.join(chatsDir, 'session.jsonl');
	fs.writeFileSync(file, records.map(r => JSON.stringify(r)).join('\n'), 'utf8');
	return { file, tmpDir };
}

test('GeminiCli: truncated JSONL line is skipped without throwing', async () => {
	const tmpDir = mkTmpDir('gemini-robust-');
	try {
		const chatsDir = path.join(tmpDir, '.gemini', 'tmp', 'demo-project', 'chats');
		fs.mkdirSync(chatsDir, { recursive: true });
		const file = path.join(chatsDir, 'session.jsonl');
		fs.writeFileSync(file, '{"id":"assistant-1","type":"gemini","tokens":{"inp', 'utf8');
		const gemini = new GeminiCliDataAccess();
		const modelUsage = await gemini.getGeminiCliModelUsage(file);
		assert.deepEqual(modelUsage, {});
	} finally {
		rm(tmpDir);
	}
});

test('GeminiCli: file over the size cap is skipped', async () => {
	const tmpDir = mkTmpDir('gemini-robust-');
	try {
		const chatsDir = path.join(tmpDir, '.gemini', 'tmp', 'demo-project', 'chats');
		fs.mkdirSync(chatsDir, { recursive: true });
		const file = path.join(chatsDir, 'session.jsonl');
		writeOversizedFile(file, MAX_SESSION_FILE_BYTES + 1024);
		const gemini = new GeminiCliDataAccess();
		const modelUsage = await gemini.getGeminiCliModelUsage(file);
		assert.deepEqual(modelUsage, {});
	} finally {
		rm(tmpDir);
	}
});

test('GeminiCli: deeply nested JSON line does not crash the process', async () => {
	const { file, tmpDir } = createTempGeminiSession([]);
	try {
		fs.appendFileSync(file, '\n' + buildDeeplyNestedJson(100_000), 'utf8');
		const gemini = new GeminiCliDataAccess();
		const modelUsage = await gemini.getGeminiCliModelUsage(file);
		assert.deepEqual(modelUsage, {});
	} finally {
		rm(tmpDir);
	}
});

test('GeminiCli: __proto__ model key does not pollute Object.prototype', async () => {
	const { file, tmpDir } = createTempGeminiSession([
		{
			id: 'assistant-1',
			type: 'gemini',
			model: '__proto__',
			tokens: { input: 10, output: 5, cached: 0, thoughts: 0, tool: 0, total: 15 },
		},
	]);
	try {
		const gemini = new GeminiCliDataAccess();
		const modelUsage = await gemini.getGeminiCliModelUsage(file);
		assertNoPrototypePollution();
		assert.equal(Object.prototype.hasOwnProperty.call(modelUsage, '__proto__'), false);
	} finally {
		rm(tmpDir);
	}
});

// ---------------------------------------------------------------------------
// Antigravity
// ---------------------------------------------------------------------------

test('Antigravity: truncated JSONL line is skipped without throwing', async () => {
	const tmpDir = mkTmpDir('antigravity-robust-');
	try {
		const file = path.join(tmpDir, 'transcript.jsonl');
		fs.writeFileSync(file, '{"type":"USER_INPUT","source":"USER_EXPL', 'utf8');
		const antigravity = new AntigravityDataAccess();
		const session = await antigravity.readAntigravitySession(file);
		assert.deepEqual(session.allEntries, []);
	} finally {
		rm(tmpDir);
	}
});

test('Antigravity: file over the size cap is skipped', async () => {
	const tmpDir = mkTmpDir('antigravity-robust-');
	try {
		const file = path.join(tmpDir, 'transcript.jsonl');
		writeOversizedFile(file, MAX_SESSION_FILE_BYTES + 1024);
		const antigravity = new AntigravityDataAccess();
		const session = await antigravity.readAntigravitySession(file);
		assert.deepEqual(session.allEntries, []);
		assert.deepEqual(session.userEntries, []);
		assert.deepEqual(session.modelEntries, []);
	} finally {
		rm(tmpDir);
	}
});

test('Antigravity: deeply nested JSON line does not crash the process', async () => {
	const tmpDir = mkTmpDir('antigravity-robust-');
	try {
		const file = path.join(tmpDir, 'transcript.jsonl');
		fs.writeFileSync(file, buildDeeplyNestedJson(100_000), 'utf8');
		const antigravity = new AntigravityDataAccess();
		const session = await antigravity.readAntigravitySession(file);
		assert.deepEqual(session.allEntries, []);
	} finally {
		rm(tmpDir);
	}
});

test('Antigravity: __proto__ typed entries are ignored gracefully', async () => {
	const tmpDir = mkTmpDir('antigravity-robust-');
	try {
		const file = path.join(tmpDir, 'transcript.jsonl');
		const lines = [
			JSON.stringify({ __proto__: { polluted: true }, type: 'USER_INPUT', source: 'USER_EXPLICIT' }),
		];
		fs.writeFileSync(file, lines.join('\n'), 'utf8');
		const antigravity = new AntigravityDataAccess();
		const session = await antigravity.readAntigravitySession(file);
		assertNoPrototypePollution();
		assert.equal(session.userEntries.length, 1);
	} finally {
		rm(tmpDir);
	}
});

// ---------------------------------------------------------------------------
// OpenCode
// ---------------------------------------------------------------------------

class TestableOpenCodeDataAccess extends OpenCodeDataAccess {
	constructor(private readonly testDataDir: string) { super({ fsPath: '', path: '', scheme: 'file' }); }
	override getOpenCodeDataDir(): string { return this.testDataDir; }
}

test('OpenCode: truncated JSON message file is skipped without throwing', () => {
	const tmpDir = mkTmpDir('opencode-robust-');
	try {
		const messageDir = path.join(tmpDir, 'storage', 'message', 'ses_1');
		fs.mkdirSync(messageDir, { recursive: true });
		fs.writeFileSync(path.join(messageDir, 'msg_1.json'), '{"id":"msg_1","role":"assist', 'utf8');
		const opencode = new TestableOpenCodeDataAccess(tmpDir);
		const messages = opencode.readOpenCodeMessages('ses_1');
		assert.deepEqual(messages, []);
	} finally {
		rm(tmpDir);
	}
});

test('OpenCode: message file over the size cap is skipped', () => {
	const tmpDir = mkTmpDir('opencode-robust-');
	try {
		const messageDir = path.join(tmpDir, 'storage', 'message', 'ses_1');
		fs.mkdirSync(messageDir, { recursive: true });
		writeOversizedFile(path.join(messageDir, 'msg_huge.json'), MAX_SESSION_FILE_BYTES + 1024);
		const opencode = new TestableOpenCodeDataAccess(tmpDir);
		const messages = opencode.readOpenCodeMessages('ses_1');
		assert.deepEqual(messages, []);
	} finally {
		rm(tmpDir);
	}
});

test('OpenCode: deeply nested JSON message does not crash the process', () => {
	const tmpDir = mkTmpDir('opencode-robust-');
	try {
		const messageDir = path.join(tmpDir, 'storage', 'message', 'ses_1');
		fs.mkdirSync(messageDir, { recursive: true });
		fs.writeFileSync(path.join(messageDir, 'msg_deep.json'), buildDeeplyNestedJson(100_000), 'utf8');
		const opencode = new TestableOpenCodeDataAccess(tmpDir);
		assert.doesNotThrow(() => opencode.readOpenCodeMessages('ses_1'));
	} finally {
		rm(tmpDir);
	}
});

test('OpenCode: __proto__ modelID does not pollute Object.prototype', () => {
	const tmpDir = mkTmpDir('opencode-robust-');
	try {
		const messageDir = path.join(tmpDir, 'storage', 'message', 'ses_1');
		fs.mkdirSync(messageDir, { recursive: true });
		const userMsg = { id: 'u1', role: 'user', time: { created: 1 } };
		const assistantMsg = {
			id: 'a1', role: 'assistant', parentID: 'u1', modelID: '__proto__',
			tokens: { output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
			time: { created: 2, completed: 3 },
		};
		fs.writeFileSync(path.join(messageDir, 'u1.json'), JSON.stringify(userMsg), 'utf8');
		fs.writeFileSync(path.join(messageDir, 'a1.json'), JSON.stringify(assistantMsg), 'utf8');
		const opencode = new TestableOpenCodeDataAccess(tmpDir);
		const messages = opencode.readOpenCodeMessages('ses_1');
		assert.equal(messages.length, 2);
		assertNoPrototypePollution();
	} finally {
		rm(tmpDir);
	}
});

// ---------------------------------------------------------------------------
// Continue
// ---------------------------------------------------------------------------

test('Continue: __proto__ modelTitle is skipped and does not pollute Object.prototype', async () => {
	const tmpDir = mkTmpDir('continue-robust-');
	try {
		const file = path.join(tmpDir, 'session.json');
		const session = {
			history: [
				{ promptLogs: [{ modelTitle: '__proto__', prompt: 'evil', completion: 'evil' }] },
				{ promptLogs: [{ modelTitle: 'gpt-4o', prompt: 'hello there', completion: 'hi' }] },
			],
		};
		fs.writeFileSync(file, JSON.stringify(session), 'utf8');
		const cont = new ContinueDataAccess();
		const modelUsage = await cont.getContinueModelUsage(file);
		assertNoPrototypePollution();
		assert.equal(Object.prototype.hasOwnProperty.call(modelUsage, '__proto__'), false);
		assert.ok(modelUsage['gpt-4o'], 'legitimate model must still be counted');
	} finally {
		rm(tmpDir);
	}
});

// ---------------------------------------------------------------------------
// Kiro
// ---------------------------------------------------------------------------

test('Kiro: __proto__ modelTitle is skipped and does not pollute Object.prototype', async () => {
	const tmpDir = mkTmpDir('kiro-robust-');
	try {
		const file = path.join(tmpDir, 'session.json');
		const session = {
			history: [
				{ promptLogs: [{ modelTitle: '__proto__', prompt: 'evil', completion: 'evil' }] },
				{ promptLogs: [{ modelTitle: 'Agent', prompt: 'hello there', completion: 'hi' }] },
			],
		};
		fs.writeFileSync(file, JSON.stringify(session), 'utf8');
		const kiro = new KiroDataAccess();
		const modelUsage = await kiro.getKiroModelUsage(file);
		assertNoPrototypePollution();
		assert.equal(Object.prototype.hasOwnProperty.call(modelUsage, '__proto__'), false);
		assert.ok(modelUsage['Agent'], 'legitimate model must still be counted');
	} finally {
		rm(tmpDir);
	}
});

// ---------------------------------------------------------------------------
// Cline
// ---------------------------------------------------------------------------

test('Cline: __proto__ modelId is skipped and does not pollute Object.prototype', async () => {
	const tmpDir = mkTmpDir('cline-robust-');
	try {
		const taskDir = path.join(tmpDir, 'tasks', '123');
		fs.mkdirSync(taskDir, { recursive: true });
		const file = path.join(taskDir, 'ui_messages.json');
		const messages = [
			{
				ts: 1, type: 'say', say: 'api_req_started',
				text: JSON.stringify({ tokensIn: 10, tokensOut: 5, cacheWrites: 0, cacheReads: 0 }),
				modelInfo: { modelId: '__proto__' },
			},
			{
				ts: 2, type: 'say', say: 'api_req_started',
				text: JSON.stringify({ tokensIn: 7, tokensOut: 3, cacheWrites: 0, cacheReads: 0 }),
				modelInfo: { modelId: 'claude-sonnet-4-6' },
			},
		];
		fs.writeFileSync(file, JSON.stringify(messages), 'utf8');
		const cline = new ClineDataAccess();
		const modelUsage = await cline.getClineModelUsage(file);
		assertNoPrototypePollution();
		assert.equal(Object.prototype.hasOwnProperty.call(modelUsage, '__proto__'), false);
		assert.ok(modelUsage['claude-sonnet-4-6'], 'legitimate model must still be counted');
	} finally {
		rm(tmpDir);
	}
});

// ---------------------------------------------------------------------------
// Pi
// ---------------------------------------------------------------------------

test('Pi: __proto__ model is skipped and does not pollute Object.prototype', async () => {
	const tmpDir = mkTmpDir('pi-robust-');
	try {
		const file = path.join(tmpDir, 'session.jsonl');
		const lines = [
			{ type: 'message', message: { role: 'assistant', model: '__proto__', usage: { input: 10, output: 5 } } },
			{ type: 'message', message: { role: 'assistant', model: 'claude-sonnet-4-6', usage: { input: 7, output: 3 } } },
		];
		fs.writeFileSync(file, lines.map(l => JSON.stringify(l)).join('\n'), 'utf8');
		const pi = new PiDataAccess();
		const modelUsage = await pi.getModelUsage(file);
		assertNoPrototypePollution();
		assert.equal(Object.prototype.hasOwnProperty.call(modelUsage, '__proto__'), false);
		assert.ok(modelUsage['claude-sonnet-4-6'], 'legitimate model must still be counted');
	} finally {
		rm(tmpDir);
	}
});

// ---------------------------------------------------------------------------
// Claude Desktop (Cowork)
// ---------------------------------------------------------------------------

test('ClaudeDesktop Cowork: __proto__ model is skipped and does not pollute Object.prototype', async () => {
	const tmpDir = mkTmpDir('cowork-robust-');
	try {
		const file = path.join(tmpDir, 'session.jsonl');
		const events = [
			{ type: 'assistant', message: { role: 'assistant', model: '__proto__', stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 } } },
			{ type: 'assistant', message: { role: 'assistant', model: 'claude-sonnet-4-6', stop_reason: 'end_turn', usage: { input_tokens: 7, output_tokens: 3 } } },
		];
		fs.writeFileSync(file, events.map(e => JSON.stringify(e)).join('\n'), 'utf8');
		const cowork = new ClaudeDesktopDataAccess();
		const modelUsage = await cowork.getDesktopSessionModelUsage(file);
		assertNoPrototypePollution();
		assert.equal(Object.prototype.hasOwnProperty.call(modelUsage, '__proto__'), false);
		assert.ok(modelUsage['claude-sonnet-4.6'], 'legitimate model must still be counted');
	} finally {
		rm(tmpDir);
	}
});

// ---------------------------------------------------------------------------
// Eclipse
// ---------------------------------------------------------------------------

test('Eclipse: __proto__ model is skipped and does not pollute Object.prototype', async () => {
	const tmpDir = mkTmpDir('eclipse-robust-');
	try {
		const file = path.join(tmpDir, 'conv.json');
		const session = {
			turns: [
				{ role: 'user', turnId: 't1', model: '__proto__', message: { text: 'evil prompt' } },
				{ role: 'user', turnId: 't2', model: 'gpt-4o', message: { text: 'hello there' } },
			],
		};
		fs.writeFileSync(file, JSON.stringify(session), 'utf8');
		const eclipse = new EclipseDataAccess();
		const modelUsage = await eclipse.getEclipseModelUsage(file);
		assertNoPrototypePollution();
		assert.equal(Object.prototype.hasOwnProperty.call(modelUsage, '__proto__'), false);
		assert.ok(modelUsage['gpt-4o'], 'legitimate model must still be counted');
	} finally {
		rm(tmpDir);
	}
});

// ---------------------------------------------------------------------------
// Mistral Vibe
// ---------------------------------------------------------------------------

test('MistralVibe: __proto__ active_model falls back to the default model', async () => {
	const tmpDir = mkTmpDir('mistral-robust-');
	try {
		const file = path.join(tmpDir, 'meta.json');
		const meta = {
			config: { active_model: '__proto__' },
			stats: { session_prompt_tokens: 10, session_completion_tokens: 5 },
		};
		fs.writeFileSync(file, JSON.stringify(meta), 'utf8');
		const vibe = new MistralVibeDataAccess();
		const modelUsage = await vibe.getModelUsage(file);
		assertNoPrototypePollution();
		assert.equal(Object.prototype.hasOwnProperty.call(modelUsage, '__proto__'), false);
		assert.ok(modelUsage['devstral'], 'tokens must be attributed to the default model instead');
	} finally {
		rm(tmpDir);
	}
});

test('MistralVibe: hostile stats values are ignored rather than propagated', async () => {
	const tmpDir = mkTmpDir('mistral-robust-');
	try {
		const file = path.join(tmpDir, 'meta.json');
		fs.writeFileSync(file, JSON.stringify({
			stats: { tokens_per_second: '__proto__', last_turn_duration: { a: 1 }, steps: [1], session_cost: -5, tool_calls_failed: 'x' },
		}), 'utf8');
		const stats = await new MistralVibeDataAccess().getSessionStats(file);
		assertNoPrototypePollution();
		assert.deepEqual(Object.values(stats).filter(v => v !== undefined), []);
	} finally {
		rm(tmpDir);
	}
});

// ---------------------------------------------------------------------------
// Shared accumulators (sessionParser.TokenAccumulator, statsHelpers.addModelUsage)
// ---------------------------------------------------------------------------

test('TokenAccumulator: __proto__ model is skipped and does not pollute Object.prototype', () => {
	const acc = new TokenAccumulator('default-model', (text: string) => text.length);
	acc.addInput('__proto__', 'evil');
	acc.addOutput('constructor', 'evil');
	acc.addInput('gpt-4o', 'hello');
	assertNoPrototypePollution();
	assert.equal(Object.prototype.hasOwnProperty.call(acc.modelUsage, '__proto__'), false);
	assert.equal(Object.prototype.hasOwnProperty.call(acc.modelUsage, 'constructor'), false);
	assert.ok(acc.modelUsage['gpt-4o'], 'legitimate model must still be counted');
});

test('addModelUsage: an own __proto__ key in source is skipped and does not pollute', () => {
	// A computed property creates an own "__proto__" key, mimicking what an
	// unguarded adapter could hand to the central merge.
	const key = '__proto__';
	const source = { [key]: { inputTokens: 10, outputTokens: 5, sessions: 0 }, 'gpt-4o': { inputTokens: 7, outputTokens: 3, sessions: 0 } };
	const target: Record<string, { inputTokens: number; outputTokens: number; sessions: number }> = {};
	addModelUsage(target as any, source as any);
	assertNoPrototypePollution();
	assert.equal(Object.prototype.hasOwnProperty.call(target, '__proto__'), false);
	assert.deepEqual(target['gpt-4o'], { inputTokens: 7, outputTokens: 3, sessions: 0 });
});

// ---------------------------------------------------------------------------
// Shared helper sanity checks (used by all adapters above)
// ---------------------------------------------------------------------------

test('isUnsafeObjectKey: flags the known prototype-pollution gadget keys', () => {
	assert.equal(isUnsafeObjectKey('__proto__'), true);
	assert.equal(isUnsafeObjectKey('constructor'), true);
	assert.equal(isUnsafeObjectKey('prototype'), true);
	assert.equal(isUnsafeObjectKey('claude-sonnet-4.6'), false);
	assert.equal(isUnsafeObjectKey('gpt-4o'), false);
	assert.equal(isUnsafeObjectKey('unknown'), false);
});
