/**
 * The CLI applies exact token counts from VS Code Copilot Chat debug logs at
 * workspaceStorage/<hash>/<copilot-extension>/debug-logs/<sessionId>/main.jsonl.
 * The lookup used to force Windows separators onto the workspace-hash dir, so it
 * never found the file on macOS/Linux. This runs against a real temp tree on the
 * current platform, so it fails on POSIX if separators are mangled again.
 */

import test from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { readDebugLogTokensForSession } from '../helpers';

const SESSION_ID = '0a1b2c3d-4e5f-6789-abcd-ef0123456789';

function makeWorkspace(extFolder: string): { root: string; sessionFile: string } {
	// Under cli/out/, not os.tmpdir(): the guarded reader refuses files in the OS temp directory.
	const root = fs.mkdtempSync(path.join(__dirname, '..', 'cli-debuglog-'));
	const hashDir = path.join(root, 'workspaceStorage', 'abc123hash');
	const chatDir = path.join(hashDir, 'chatSessions');
	fs.mkdirSync(chatDir, { recursive: true });
	const sessionFile = path.join(chatDir, `${SESSION_ID}.json`);
	fs.writeFileSync(sessionFile, JSON.stringify({ requests: [] }));

	const logDir = path.join(hashDir, extFolder, 'debug-logs', SESSION_ID);
	fs.mkdirSync(logDir, { recursive: true });
	const events = [
		{ type: 'llm_request', attrs: { model: 'gpt-4o', inputTokens: 100, outputTokens: 20, cachedTokens: 5 } },
		{ type: 'llm_request', attrs: { model: 'gpt-4o', inputTokens: 200, outputTokens: 30, cachedTokens: 0 } },
	];
	fs.writeFileSync(path.join(logDir, 'main.jsonl'), events.map(e => JSON.stringify(e)).join('\n') + '\n');
	return { root, sessionFile };
}

test('finds the debug log next to a chatSessions file on the current platform', async (t) => {
	const { root, sessionFile } = makeWorkspace('GitHub.copilot-chat');
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));

	const result = await readDebugLogTokensForSession(sessionFile);
	assert.ok(result, `expected debug log to be found for ${sessionFile}`);
	assert.equal(result.inputTokens, 300);
	assert.equal(result.outputTokens, 50);
	assert.equal(result.cachedTokens, 5);
	assert.deepEqual(result.modelBreakdown['gpt-4o'], { inputTokens: 300, outputTokens: 50, cachedTokens: 5 });
});

test('finds the debug log under the lowercase extension folder variant', async (t) => {
	const { root, sessionFile } = makeWorkspace('github.copilot-chat');
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));

	const result = await readDebugLogTokensForSession(sessionFile);
	assert.ok(result);
	assert.equal(result.inputTokens, 300);
});

test('returns null when no debug log exists', async (t) => {
	// Under cli/out/, not os.tmpdir(): the guarded reader refuses files in the OS temp directory.
	const root = fs.mkdtempSync(path.join(__dirname, '..', 'cli-debuglog-'));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const chatDir = path.join(root, 'workspaceStorage', 'abc123hash', 'chatSessions');
	fs.mkdirSync(chatDir, { recursive: true });
	const sessionFile = path.join(chatDir, `${SESSION_ID}.json`);
	fs.writeFileSync(sessionFile, '{}');

	assert.equal(await readDebugLogTokensForSession(sessionFile), null);
});

test('returns null for non-UUID session files and paths outside workspaceStorage', async () => {
	assert.equal(await readDebugLogTokensForSession(path.join(os.tmpdir(), 'workspaceStorage', 'h', 'chatSessions', 'not-a-uuid.json')), null);
	assert.equal(await readDebugLogTokensForSession(path.join(os.tmpdir(), 'elsewhere', `${SESSION_ID}.json`)), null);
});
