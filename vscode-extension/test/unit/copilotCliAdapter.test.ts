/**
 * Unit tests for CopilotCliAdapter — discovery of Copilot CLI agent-mode
 * session files under ~/.copilot/session-state/.
 */
import test from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import {
    CopilotCliAdapter,
    isCopilotCliSessionPath,
    getCopilotCliSessionStateDir,
} from '../../src/adapters/copilotCliAdapter';
import { isDiscoverable } from '../../src/ecosystemAdapter';

const adapter = new CopilotCliAdapter();

// ---------------------------------------------------------------------------
// Identity & interface conformance
// ---------------------------------------------------------------------------

test('CopilotCliAdapter: id and displayName are stable', () => {
    assert.equal(adapter.id, 'copilotcli');
    assert.equal(adapter.displayName, 'GitHub Copilot CLI');
});

test('CopilotCliAdapter: implements IDiscoverableEcosystem', () => {
    assert.ok(isDiscoverable(adapter));
});

// ---------------------------------------------------------------------------
// handles() — currently a no-op match (parser delegation pending)
// ---------------------------------------------------------------------------

test('CopilotCliAdapter.handles: returns false while parser delegation is pending', () => {
    const p = path.join(os.homedir(), '.copilot', 'session-state', 'abc.jsonl');
    assert.equal(adapter.handles(p), false);
});

// ---------------------------------------------------------------------------
// Path predicate
// ---------------------------------------------------------------------------

test('isCopilotCliSessionPath: matches paths under ~/.copilot/session-state/', () => {
    assert.ok(isCopilotCliSessionPath('/home/me/.copilot/session-state/abc.jsonl'));
    assert.ok(isCopilotCliSessionPath('/home/me/.copilot/session-state/uuid/events.jsonl'));
    assert.ok(isCopilotCliSessionPath('C:\\Users\\me\\.copilot\\session-state\\abc.json'));
});

test('isCopilotCliSessionPath: rejects unrelated paths', () => {
    assert.equal(isCopilotCliSessionPath('/home/me/.continue/sessions/abc.json'), false);
    assert.equal(isCopilotCliSessionPath('/home/me/.claude/projects/foo/abc.jsonl'), false);
    assert.equal(isCopilotCliSessionPath('/home/me/Code/User/workspaceStorage/abc/chatSessions/s1.json'), false);
});

// ---------------------------------------------------------------------------
// getEditorRoot / getCandidatePaths
// ---------------------------------------------------------------------------

test('CopilotCliAdapter.getEditorRoot: returns ~/.copilot/session-state', () => {
    assert.equal(adapter.getEditorRoot('/anything'), getCopilotCliSessionStateDir());
});

test('CopilotCliAdapter.getCandidatePaths: returns single Copilot CLI entry', () => {
    const paths = adapter.getCandidatePaths();
    assert.equal(paths.length, 1);
    assert.equal(paths[0].source, 'Copilot CLI');
    assert.ok(paths[0].path.replace(/\\/g, '/').endsWith('/.copilot/session-state'));
});

// ---------------------------------------------------------------------------
// Safe-default contract methods
// ---------------------------------------------------------------------------

test('CopilotCliAdapter: safe-default methods return zero values', async () => {
    const f = '/some/file.jsonl';
    assert.deepEqual(await adapter.getTokens(f), { tokens: 0, thinkingTokens: 0, actualTokens: 0 });
    assert.equal(await adapter.countInteractions(f), 0);
    assert.deepEqual(await adapter.getModelUsage(f), {});
    const meta = await adapter.getMeta(f);
    assert.equal(meta.title, undefined);
});

// ---------------------------------------------------------------------------
// discover() against a synthetic ~/.copilot/session-state/ layout
// ---------------------------------------------------------------------------

test('CopilotCliAdapter.discover: finds flat .json/.jsonl AND uuid subdir events.jsonl', async (t) => {
    // Redirect ~/.copilot/session-state to a tmpdir by overriding HOME/USERPROFILE
    // (os.homedir() consults these env vars on each call).
    const tmpHome = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cli-home-'));
    const stateDir = path.join(tmpHome, '.copilot', 'session-state');
    await fs.promises.mkdir(stateDir, { recursive: true });

    const originalHome = process.env.HOME;
    const originalUserProfile = process.env.USERPROFILE;
    process.env.HOME = tmpHome;
    process.env.USERPROFILE = tmpHome;

    t.after(async () => {
        if (originalHome === undefined) { delete process.env.HOME; } else { process.env.HOME = originalHome; }
        if (originalUserProfile === undefined) { delete process.env.USERPROFILE; } else { process.env.USERPROFILE = originalUserProfile; }
        await fs.promises.rm(tmpHome, { recursive: true, force: true });
    });

    // Skip the test if HOME override didn't take effect on this platform.
    if (os.homedir() !== tmpHome) {
        t.skip(`os.homedir() doesn't honour env override on this platform (got ${os.homedir()})`);
        return;
    }

    // Plant fixtures
    await fs.promises.writeFile(path.join(stateDir, 'flat-session.json'), '{}');
    await fs.promises.writeFile(path.join(stateDir, 'flat-session.jsonl'), '{"type":"x"}\n');
    const uuid = path.join(stateDir, 'a1b2c3d4-e5f6-7890-abcd-ef0123456789');
    await fs.promises.mkdir(uuid, { recursive: true });
    await fs.promises.writeFile(path.join(uuid, 'events.jsonl'), '{"type":"start"}\n');
    const emptyUuid = path.join(stateDir, 'b2c3d4e5-f6a7-8901-bcde-f01234567890');
    await fs.promises.mkdir(emptyUuid, { recursive: true });
    await fs.promises.writeFile(path.join(emptyUuid, 'events.jsonl'), '');

    const fresh = new CopilotCliAdapter();
    const result = await fresh.discover(() => { /* noop */ });

    // Expect: 2 flat (.json + .jsonl) + 1 non-empty uuid events.jsonl = 3
    assert.equal(result.sessionFiles.length, 3, `got: ${JSON.stringify(result.sessionFiles)}`);
    assert.ok(result.sessionFiles.some(f => f.endsWith('flat-session.json')));
    assert.ok(result.sessionFiles.some(f => f.endsWith('flat-session.jsonl')));
    assert.ok(result.sessionFiles.some(f => f.replace(/\\/g, '/').endsWith('/events.jsonl')));
    // The empty events.jsonl must be excluded
    assert.equal(result.sessionFiles.filter(f => f.includes('b2c3d4e5')).length, 0);
});

test('CopilotCliAdapter.discover: returns empty result when session-state dir does not exist', async () => {
    // The real adapter points at the user's homedir; if that dir doesn't
    // exist (e.g. in CI), discover() must return cleanly with empty results.
    const result = await adapter.discover(() => { /* noop */ });
    assert.ok(Array.isArray(result.sessionFiles));
    assert.ok(Array.isArray(result.candidatePaths));
});
