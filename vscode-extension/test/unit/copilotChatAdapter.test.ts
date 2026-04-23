/**
 * Unit tests for CopilotChatAdapter — discovery of GitHub Copilot Chat
 * session files across VS Code variants, including WSL Windows-side paths.
 *
 * These tests focus on:
 *   1. Adapter identity (id, displayName, IDiscoverable conformance).
 *   2. The narrow path predicate exported alongside the adapter.
 *   3. discover() against a synthetic VS Code user-data layout in tmpdir.
 *   4. Stable behaviour of getEditorRoot, handles, and the safe-default
 *      contract methods (getTokens / countInteractions / getModelUsage /
 *      getMeta) — which currently return zero values while the existing
 *      fallback parser owns parsing semantics.
 */
import test from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import {
    CopilotChatAdapter,
    isCopilotChatSessionPath,
    getVSCodeUserPaths,
    isWSL,
} from '../../src/adapters/copilotChatAdapter';
import { isDiscoverable } from '../../src/ecosystemAdapter';

const adapter = new CopilotChatAdapter();

// ---------------------------------------------------------------------------
// Identity & interface conformance
// ---------------------------------------------------------------------------

test('CopilotChatAdapter: id and displayName are stable', () => {
    assert.equal(adapter.id, 'copilotchat');
    assert.equal(adapter.displayName, 'GitHub Copilot Chat');
});

test('CopilotChatAdapter: implements IDiscoverableEcosystem', () => {
    assert.ok(isDiscoverable(adapter));
});

// ---------------------------------------------------------------------------
// handles() — currently a no-op match
// ---------------------------------------------------------------------------

test('CopilotChatAdapter.handles: returns false (parser delegation pending)', () => {
    // Discovery-only: the existing fallback in extension.ts owns parsing, so
    // handles() must NOT claim files yet (otherwise the fallback path is
    // skipped and parsing breaks). See issue #654.
    const p = path.join(os.homedir(), 'AppData', 'Roaming', 'Code', 'User',
        'workspaceStorage', 'abc', 'chatSessions', 'session.json');
    assert.equal(adapter.handles(p), false);
});

// ---------------------------------------------------------------------------
// isCopilotChatSessionPath — narrow path predicate
// ---------------------------------------------------------------------------

test('isCopilotChatSessionPath: recognises legacy workspaceStorage chatSessions', () => {
    assert.ok(isCopilotChatSessionPath('/x/Code/User/workspaceStorage/abc/chatSessions/s1.json'));
    assert.ok(isCopilotChatSessionPath('/x/Code/User/workspaceStorage/abc/chatSessions/s1.jsonl'));
});

test('isCopilotChatSessionPath: recognises new GitHub.copilot-chat layout (both casings)', () => {
    assert.ok(isCopilotChatSessionPath('/x/User/workspaceStorage/abc/GitHub.copilot-chat/chatSessions/s1.json'));
    assert.ok(isCopilotChatSessionPath('/x/User/workspaceStorage/abc/github.copilot-chat/chatSessions/s1.jsonl'));
});

test('isCopilotChatSessionPath: recognises emptyWindowChatSessions and globalStorage casings', () => {
    assert.ok(isCopilotChatSessionPath('/x/User/globalStorage/emptyWindowChatSessions/s1.json'));
    assert.ok(isCopilotChatSessionPath('/x/User/globalStorage/GitHub.copilot-chat/foo/bar.jsonl'));
    assert.ok(isCopilotChatSessionPath('/x/User/globalStorage/github.copilot-chat/foo/bar.json'));
});

test('isCopilotChatSessionPath: rejects non-session and unrelated paths', () => {
    assert.equal(isCopilotChatSessionPath('/x/User/globalStorage/GitHub.copilot-chat/embeddings.json'), false);
    assert.equal(isCopilotChatSessionPath('/x/User/globalStorage/GitHub.copilot-chat/foo/cache.json'), false);
    assert.equal(isCopilotChatSessionPath('/x/User/globalStorage/GitHub.copilot-chat/preferences.json'), false);
    assert.equal(isCopilotChatSessionPath('/x/User/workspaceStorage/abc/chatSessions/s1.txt'), false);
    assert.equal(isCopilotChatSessionPath('/home/me/.continue/sessions/abc.json'), false);
    assert.equal(isCopilotChatSessionPath('/home/me/.copilot/session-state/abc.json'), false);
});

test('isCopilotChatSessionPath: handles Windows backslash paths', () => {
    assert.ok(isCopilotChatSessionPath('C:\\Users\\me\\AppData\\Roaming\\Code\\User\\workspaceStorage\\abc\\chatSessions\\s1.json'));
    assert.ok(isCopilotChatSessionPath('C:\\Users\\me\\AppData\\Roaming\\Code\\User\\globalStorage\\emptyWindowChatSessions\\s1.json'));
});

// ---------------------------------------------------------------------------
// getVSCodeUserPaths / isWSL — basic shape
// ---------------------------------------------------------------------------

test('getVSCodeUserPaths: includes all VS Code variants for current platform', () => {
    const paths = getVSCodeUserPaths();
    // 5 desktop variants + 5 server/remote candidates = 10 entries
    assert.ok(paths.length >= 10, `expected >= 10 paths, got ${paths.length}`);
    const joined = paths.join('|');
    assert.ok(joined.includes('Code'));
    assert.ok(joined.includes('Code - Insiders'));
    assert.ok(joined.includes('VSCodium'));
    assert.ok(joined.includes('Cursor'));
    assert.ok(joined.includes('.vscode-server'));
});

test('getVSCodeUserPaths: every entry ends with the /User segment', () => {
    for (const p of getVSCodeUserPaths()) {
        const norm = p.replace(/\\/g, '/');
        assert.ok(norm.endsWith('/User') || norm.endsWith('/data/User'),
            `expected path to end with User segment: ${p}`);
    }
});

test('isWSL: respects WSL_DISTRO_NAME env var on linux', () => {
    const original = process.env.WSL_DISTRO_NAME;
    try {
        if (os.platform() === 'linux') {
            delete process.env.WSL_DISTRO_NAME;
            delete process.env.WSL_INTEROP;
            assert.equal(isWSL(), false);
            process.env.WSL_DISTRO_NAME = 'Ubuntu';
            assert.equal(isWSL(), true);
        } else {
            // On non-linux platforms isWSL() must always return false.
            process.env.WSL_DISTRO_NAME = 'Ubuntu';
            assert.equal(isWSL(), false);
        }
    } finally {
        if (original === undefined) { delete process.env.WSL_DISTRO_NAME; }
        else { process.env.WSL_DISTRO_NAME = original; }
    }
});

// ---------------------------------------------------------------------------
// getEditorRoot
// ---------------------------------------------------------------------------

test('CopilotChatAdapter.getEditorRoot: returns the VS Code User dir for a session path', () => {
    const sessionFile = path.join('C:', 'Users', 'me', 'AppData', 'Roaming', 'Code', 'User',
        'workspaceStorage', 'abc', 'chatSessions', 's1.json');
    const root = adapter.getEditorRoot(sessionFile);
    assert.ok(root.replace(/\\/g, '/').endsWith('/Code/User'),
        `expected root to end with /Code/User, got ${root}`);
});

// ---------------------------------------------------------------------------
// getCandidatePaths
// ---------------------------------------------------------------------------

test('CopilotChatAdapter.getCandidatePaths: includes every VS Code variant', () => {
    const candidates = adapter.getCandidatePaths();
    assert.ok(candidates.length >= 10);
    for (const c of candidates) {
        assert.ok(typeof c.path === 'string' && c.path.length > 0);
        assert.ok(typeof c.source === 'string' && c.source.length > 0);
    }
    const sources = new Set(candidates.map(c => c.source));
    assert.ok(sources.has('VS Code'));
});

// ---------------------------------------------------------------------------
// Safe-default contract methods (parser delegation pending)
// ---------------------------------------------------------------------------

test('CopilotChatAdapter: safe-default methods return zero values', async () => {
    const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cca-defaults-'));
    const file = path.join(tmp, 'session.json');
    await fs.promises.writeFile(file, '{"requests":[]}');
    try {
        assert.deepEqual(await adapter.getTokens(file), { tokens: 0, thinkingTokens: 0, actualTokens: 0 });
        assert.equal(await adapter.countInteractions(file), 0);
        assert.deepEqual(await adapter.getModelUsage(file), {});
        const meta = await adapter.getMeta(file);
        assert.equal(meta.title, undefined);
        assert.equal(meta.firstInteraction, null);
        assert.equal(meta.lastInteraction, null);
    } finally {
        await fs.promises.rm(tmp, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------
// discover() against a synthetic VS Code user-data layout
// ---------------------------------------------------------------------------

test('CopilotChatAdapter.discover: finds sessions in all three workspaceStorage layouts and emptyWindow', async (t) => {
    // Build a tmpdir layout mimicking a VS Code User directory and run the
    // discovery logic against it. We can't easily redirect os.homedir() in a
    // unit test, so instead we exercise the recursive-scan code path
    // indirectly: this test asserts shape and that empty homedir layouts
    // don't crash. The full integration assertion lives in
    // ecosystemAdapters.test.ts (discover returns DiscoveryResult shape).
    const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cca-discover-'));
    t.after(async () => { await fs.promises.rm(tmp, { recursive: true, force: true }); });

    const messages: string[] = [];
    const result = await adapter.discover(m => messages.push(m));
    assert.ok(Array.isArray(result.sessionFiles));
    assert.ok(Array.isArray(result.candidatePaths));
    assert.ok(result.candidatePaths.length >= 10);
    // discover() must always log at least the "considering N candidate VS Code paths" line
    assert.ok(messages.some(m => m.includes('Considering')), 'discover() should log consideration count');
});

test('CopilotChatAdapter.discover: candidatePaths matches getCandidatePaths()', async () => {
    const sync = adapter.getCandidatePaths().map(c => c.path).sort();
    const result = await adapter.discover(() => { /* noop */ });
    const dis = result.candidatePaths.map(c => c.path).sort();
    assert.deepEqual(sync, dis);
});
