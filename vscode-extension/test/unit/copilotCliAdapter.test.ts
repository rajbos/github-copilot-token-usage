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
    getCopilotCliSessionStateDir,
} from '../../../src/adapters/copilotCliAdapter';
import { isCopilotCliSessionPath } from '../../../src/adapters/adapterPredicates';
import { isDiscoverable } from '../../../src/ecosystemAdapter';

const adapter = new CopilotCliAdapter();

// ---------------------------------------------------------------------------
// Identity & interface conformance
// ---------------------------------------------------------------------------

test('CopilotCliAdapter: id and displayName are stable', () => {
    assert.equal(adapter.id, 'copilotcli');
    assert.equal(adapter.displayName, 'Copilot CLI');
});

test('CopilotCliAdapter.getDisplayName: returns MS Scout label for tracked Scout sessions via DB virtual path', () => {
    const scoutSessionId = '11111111-1111-1111-1111-111111111111';
    const scoutVirtualPath = path.join(os.homedir(), '.copilot', `session-store.db#${scoutSessionId}`);
    const scoutSessionIds = (adapter as unknown as { _scoutSessionIds: Set<string> })._scoutSessionIds;

    scoutSessionIds.add(scoutSessionId);
    try {
        assert.equal(adapter.getDisplayName(scoutVirtualPath), 'MS Scout (Copilot CLI)');
        assert.equal(adapter.getDisplayName(path.join(os.homedir(), '.copilot', 'session-store.db#other-session')), 'Copilot CLI');
    } finally {
        scoutSessionIds.delete(scoutSessionId);
    }
});

test('CopilotCliAdapter.getSessionKinds / noteSessionKinds: a classification made by discovery in one instance can be applied to another', () => {
    // The analysis worker has its own adapter that never ran discovery; the host passes it what discovery learned.
    const host = new CopilotCliAdapter();
    const worker = new CopilotCliAdapter();
    const appId = '55555555-5555-5555-5555-555555555555';
    const scoutId = '66666666-6666-6666-6666-666666666666';
    const dbPath = (id: string) => path.join(os.homedir(), '.copilot', `session-store.db#${id}`);
    const eventsPath = (id: string) => path.join(os.homedir(), '.copilot', 'session-state', id, 'events.jsonl');
    (host as unknown as { _appSessionIds: Set<string> })._appSessionIds.add(appId);
    (host as unknown as { _scoutSessionIds: Set<string> })._scoutSessionIds.add(scoutId);

    assert.deepEqual(host.getSessionKinds(dbPath(appId)), ['app']);
    assert.deepEqual(host.getSessionKinds(eventsPath(scoutId)), ['scout']);
    assert.deepEqual(host.getSessionKinds(dbPath('77777777-7777-7777-7777-777777777777')), []);

    assert.equal(worker.getDisplayName(dbPath(appId)), 'Copilot CLI', 'a fresh instance knows nothing');
    worker.noteSessionKinds(dbPath(appId), ['app']);
    worker.noteSessionKinds(dbPath(scoutId), ['scout']);
    assert.equal(worker.getDisplayName(dbPath(appId)), 'Copilot CLI (App)');
    assert.equal(worker.getDisplayName(dbPath(scoutId)), 'MS Scout (Copilot CLI)');
    assert.deepEqual(worker.getSessionKinds(dbPath(appId)), ['app']);
});

test('CopilotCliAdapter.getSessionKinds: a session discovery put in both the Scout and app sets keeps both across instances', () => {
    const host = new CopilotCliAdapter();
    const worker = new CopilotCliAdapter();
    const id = '88888888-8888-8888-8888-888888888888';
    const file = path.join(os.homedir(), '.copilot', 'session-store.db#' + id);
    (host as unknown as { _appSessionIds: Set<string> })._appSessionIds.add(id);
    (host as unknown as { _scoutSessionIds: Set<string> })._scoutSessionIds.add(id);

    const kinds = host.getSessionKinds(file);
    assert.deepEqual([...kinds].sort(), ['app', 'scout']);
    worker.noteSessionKinds(file, kinds);
    assert.deepEqual([...worker.getSessionKinds(file)].sort(), ['app', 'scout'], 'the app classification must survive, or usage is counted as plain cli');
    assert.equal(worker.getDisplayName(file), 'MS Scout (Copilot CLI)', 'the label still gives Scout precedence');
    assert.ok((worker as unknown as { _appSessionIds: Set<string> })._appSessionIds.has(id));
});

test('CopilotCliAdapter.getDisplayNameForDiscoveredPath: returns Scout label for tracked UUID, undefined otherwise', () => {
    const scoutUuid = '33333333-3333-3333-3333-333333333333';
    const eventsPath = path.join(os.homedir(), '.copilot', 'session-state', scoutUuid, 'events.jsonl');
    const otherPath = path.join(os.homedir(), '.copilot', 'session-state', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'events.jsonl');
    const scoutSessionIds = (adapter as unknown as { _scoutSessionIds: Set<string> })._scoutSessionIds;

    scoutSessionIds.add(scoutUuid);
    try {
        assert.equal(adapter.getDisplayNameForDiscoveredPath!(eventsPath), 'MS Scout (Copilot CLI)');
        assert.equal(adapter.getDisplayNameForDiscoveredPath!(otherPath), undefined);
    } finally {
        scoutSessionIds.delete(scoutUuid);
    }
});

test('CopilotCliAdapter.getDisplayName: returns MS Scout label for tracked Scout sessions via events.jsonl path', () => {
    const scoutSessionId = '22222222-2222-2222-2222-222222222222';
    const eventsPath = path.join(os.homedir(), '.copilot', 'session-state', scoutSessionId, 'events.jsonl');
    const scoutSessionIds = (adapter as unknown as { _scoutSessionIds: Set<string> })._scoutSessionIds;

    scoutSessionIds.add(scoutSessionId);
    try {
        assert.equal(adapter.getDisplayName(eventsPath), 'MS Scout (Copilot CLI)');
        // Unrelated events.jsonl path should still return Copilot CLI
        const otherPath = path.join(os.homedir(), '.copilot', 'session-state', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'events.jsonl');
        assert.equal(adapter.getDisplayName(otherPath), 'Copilot CLI');
    } finally {
        scoutSessionIds.delete(scoutSessionId);
    }
});

test('CopilotCliAdapter.getDisplayName: returns Copilot CLI (App) label for tracked app sessions via DB virtual path', () => {
    const appSessionId = '44444444-4444-4444-4444-444444444444';
    const appVirtualPath = path.join(os.homedir(), '.copilot', `session-store.db#${appSessionId}`);
    const appSessionIds = (adapter as unknown as { _appSessionIds: Set<string> })._appSessionIds;

    appSessionIds.add(appSessionId);
    try {
        assert.equal(adapter.getDisplayName(appVirtualPath), 'Copilot CLI (App)');
        assert.equal(adapter.getDisplayName(path.join(os.homedir(), '.copilot', 'session-store.db#other-session')), 'Copilot CLI');
    } finally {
        appSessionIds.delete(appSessionId);
    }
});

test('CopilotCliAdapter.getDisplayNameForDiscoveredPath: returns Copilot CLI (App) label for tracked app UUID, undefined otherwise', () => {
    const appUuid = '55555555-5555-5555-5555-555555555555';
    const eventsPath = path.join(os.homedir(), '.copilot', 'session-state', appUuid, 'events.jsonl');
    const otherPath = path.join(os.homedir(), '.copilot', 'session-state', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'events.jsonl');
    const appSessionIds = (adapter as unknown as { _appSessionIds: Set<string> })._appSessionIds;

    appSessionIds.add(appUuid);
    try {
        assert.equal(adapter.getDisplayNameForDiscoveredPath!(eventsPath), 'Copilot CLI (App)');
        assert.equal(adapter.getDisplayNameForDiscoveredPath!(otherPath), undefined);
    } finally {
        appSessionIds.delete(appUuid);
    }
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

test('CopilotCliAdapter.getCandidatePaths: returns session-state dir and session-store.db entries', () => {
    const paths = adapter.getCandidatePaths();
    assert.equal(paths.length, 2);
    // First entry: session-state directory
    assert.equal(paths[0].source, 'Copilot CLI');
    assert.ok(paths[0].path.replace(/\\/g, '/').endsWith('/.copilot/session-state'));
    // Second entry: session-store.db for chat-only sessions
    assert.equal(paths[1].source, 'Copilot CLI (session-store.db)');
    assert.ok(paths[1].path.replace(/\\/g, '/').endsWith('/.copilot/session-store.db'));
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
// getMeta workspace attribution for DB-only sessions
// ---------------------------------------------------------------------------

test('CopilotCliAdapter.getMeta: returns workspacePath from DB session cwd', async () => {
    const sessionId = 'db-session-1111-1111-1111-111111111111';
    const virtualPath = path.join(os.homedir(), '.copilot', `session-store.db#${sessionId}`);
    const cwd = 'C:\\Users\\me\\code\\my-project';

    const mockStore = {
        isCliStoreSession: (p: string) => p === virtualPath,
        readSession: async (_p: string) => ({
            id: sessionId,
            cwd,
            repository: null,
            branch: null,
            summary: 'Summary from DB',
            created_at: '2026-07-20T10:00:00.000Z',
            updated_at: '2026-07-20T10:05:00.000Z',
        }),
    };

    const fresh = new CopilotCliAdapter();
    (fresh as unknown as { store: typeof mockStore }).store = mockStore;

    const meta = await fresh.getMeta(virtualPath);
    assert.equal(meta.title, 'Summary from DB');
    assert.equal(meta.workspacePath, cwd);
});

test('CopilotCliAdapter.getMeta: omits workspacePath when DB cwd is null', async () => {
    const sessionId = 'db-session-2222-2222-2222-222222222222';
    const virtualPath = path.join(os.homedir(), '.copilot', `session-store.db#${sessionId}`);

    const mockStore = {
        isCliStoreSession: (p: string) => p === virtualPath,
        readSession: async (_p: string) => ({
            id: sessionId,
            cwd: null,
            repository: null,
            branch: null,
            summary: 'Chat-only session',
            created_at: '2026-07-20T10:00:00.000Z',
            updated_at: '2026-07-20T10:05:00.000Z',
        }),
    };

    const fresh = new CopilotCliAdapter();
    (fresh as unknown as { store: typeof mockStore }).store = mockStore;

    const meta = await fresh.getMeta(virtualPath);
    assert.equal(meta.title, 'Chat-only session');
    assert.equal(meta.workspacePath, undefined);
});

// ---------------------------------------------------------------------------
// getWorkspacePathForDiscoveredPath — workspace.yaml next to events.jsonl
// ---------------------------------------------------------------------------

test('CopilotCliAdapter.getWorkspacePathForDiscoveredPath: reads cwd from workspace.yaml', async (t) => {
    const tmpHome = await fs.promises.mkdtemp(path.join(process.cwd(), 'cli-ws-'));
    const stateDir = path.join(tmpHome, '.copilot', 'session-state');
    const uuid = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
    const uuidDir = path.join(stateDir, uuid);
    await fs.promises.mkdir(uuidDir, { recursive: true });
    const eventsPath = path.join(uuidDir, 'events.jsonl');
    const cwd = 'C:\\Users\\me\\code\\my-project';
    await fs.promises.writeFile(path.join(uuidDir, 'workspace.yaml'), `cwd: ${cwd}\n`);
    await fs.promises.writeFile(eventsPath, '{"type":"start"}\n');

    t.after(async () => {
        await fs.promises.rm(tmpHome, { recursive: true, force: true });
    });

    const fresh = new CopilotCliAdapter();
    const workspacePath = await fresh.getWorkspacePathForDiscoveredPath!(eventsPath);
    assert.equal(workspacePath, cwd);
});

test('CopilotCliAdapter.getWorkspacePathForDiscoveredPath: returns undefined when workspace.yaml is missing', async (t) => {
    const tmpHome = await fs.promises.mkdtemp(path.join(process.cwd(), 'cli-ws-missing-'));
    const stateDir = path.join(tmpHome, '.copilot', 'session-state');
    const uuid = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
    const uuidDir = path.join(stateDir, uuid);
    await fs.promises.mkdir(uuidDir, { recursive: true });
    const eventsPath = path.join(uuidDir, 'events.jsonl');
    await fs.promises.writeFile(eventsPath, '{"type":"start"}\n');

    t.after(async () => {
        await fs.promises.rm(tmpHome, { recursive: true, force: true });
    });

    const fresh = new CopilotCliAdapter();
    const workspacePath = await fresh.getWorkspacePathForDiscoveredPath!(eventsPath);
    assert.equal(workspacePath, undefined);
});

// ---------------------------------------------------------------------------
// discover() against a synthetic ~/.copilot/session-state/ layout
// ---------------------------------------------------------------------------

test('CopilotCliAdapter.discover: finds flat .json/.jsonl AND uuid subdir events.jsonl', async (t) => {
    // Redirect ~/.copilot/session-state to a tmpdir by overriding HOME/USERPROFILE
    // (os.homedir() consults these env vars on each call).
    const tmpHome = await fs.promises.mkdtemp(path.join(process.cwd(), 'cli-home-'));
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

test('CopilotCliAdapter.discover: marks sessions with Scout workspace.yaml cwd as Scout', async (t) => {
    const tmpHome = await fs.promises.mkdtemp(path.join(process.cwd(), 'cli-home-scout-'));
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

    if (os.homedir() !== tmpHome) {
        t.skip(`os.homedir() doesn't honour env override on this platform (got ${os.homedir()})`);
        return;
    }

    // Scout session: has events.jsonl + workspace.yaml with Scout cwd
    const scoutUuid = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
    const scoutDir = path.join(stateDir, scoutUuid);
    await fs.promises.mkdir(scoutDir, { recursive: true });
    await fs.promises.writeFile(path.join(scoutDir, 'events.jsonl'), '{"type":"start"}\n');
    await fs.promises.writeFile(path.join(scoutDir, 'workspace.yaml'),
        'cwd: C:\\Users\\me\\Documents\\Microsoft Scout\\my-project\n');

    // Regular CLI session: has events.jsonl but no workspace.yaml Scout cwd
    const regularUuid = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
    const regularDir = path.join(stateDir, regularUuid);
    await fs.promises.mkdir(regularDir, { recursive: true });
    await fs.promises.writeFile(path.join(regularDir, 'events.jsonl'), '{"type":"start"}\n');
    await fs.promises.writeFile(path.join(regularDir, 'workspace.yaml'), 'cwd: C:\\Users\\me\\code\\my-project\n');

    const fresh = new CopilotCliAdapter();
    await fresh.discover(() => { /* noop */ });

    const scoutEventsPath = path.join(scoutDir, 'events.jsonl');
    const regularEventsPath = path.join(regularDir, 'events.jsonl');

    assert.equal(fresh.getDisplayName(scoutEventsPath), 'MS Scout (Copilot CLI)',
        'Scout session should be labelled MS Scout (Copilot CLI)');
    assert.equal(fresh.getDisplayName(regularEventsPath), 'Copilot CLI',
        'Regular CLI session should be labelled Copilot CLI');
});

test('CopilotCliAdapter.discover: marks sessions with client_name: github/autopilot workspace.yaml as App', async (t) => {
    const tmpHome = await fs.promises.mkdtemp(path.join(process.cwd(), 'cli-home-app-'));
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

    if (os.homedir() !== tmpHome) {
        t.skip(`os.homedir() doesn't honour env override on this platform (got ${os.homedir()})`);
        return;
    }

    // App session: has events.jsonl + workspace.yaml with client_name: github/autopilot
    const appUuid = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
    const appDir = path.join(stateDir, appUuid);
    await fs.promises.mkdir(appDir, { recursive: true });
    await fs.promises.writeFile(path.join(appDir, 'events.jsonl'), '{"type":"start"}\n');
    await fs.promises.writeFile(path.join(appDir, 'workspace.yaml'),
        'cwd: C:\\Users\\me\\code\\my-project\nclient_name: github/autopilot\n');

    // Regular terminal CLI session: client_name: github/cli
    const cliUuid = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
    const cliDir = path.join(stateDir, cliUuid);
    await fs.promises.mkdir(cliDir, { recursive: true });
    await fs.promises.writeFile(path.join(cliDir, 'events.jsonl'), '{"type":"start"}\n');
    await fs.promises.writeFile(path.join(cliDir, 'workspace.yaml'),
        'cwd: C:\\Users\\me\\code\\my-project\nclient_name: github/cli\n');

    const fresh = new CopilotCliAdapter();
    await fresh.discover(() => { /* noop */ });

    const appEventsPath = path.join(appDir, 'events.jsonl');
    const cliEventsPath = path.join(cliDir, 'events.jsonl');

    assert.equal(fresh.getDisplayName(appEventsPath), 'Copilot CLI (App)',
        'App-wrapped session should be labelled Copilot CLI (App)');
    assert.equal(fresh.getDisplayName(cliEventsPath), 'Copilot CLI',
        'Terminal CLI session should be labelled Copilot CLI');
});

test('CopilotCliAdapter.discover: returns empty result when session-state dir does not exist', async (t) => {
    // Redirect HOME to an empty tmpdir so neither session-state/ nor session-store.db
    // exist. This avoids loading sql.js WASM (which causes a Windows UV handle assertion
    // on forced process exit) while still verifying that discover() handles missing dirs.
    const tmpHome = await fs.promises.mkdtemp(path.join(process.cwd(), 'cli-home-empty-'));
    const originalHome = process.env.HOME;
    const originalUserProfile = process.env.USERPROFILE;
    process.env.HOME = tmpHome;
    process.env.USERPROFILE = tmpHome;

    t.after(async () => {
        if (originalHome === undefined) { delete process.env.HOME; } else { process.env.HOME = originalHome; }
        if (originalUserProfile === undefined) { delete process.env.USERPROFILE; } else { process.env.USERPROFILE = originalUserProfile; }
        await fs.promises.rm(tmpHome, { recursive: true, force: true });
    });

    const fresh = new CopilotCliAdapter();
    const result = await fresh.discover(() => { /* noop */ });
    assert.ok(Array.isArray(result.sessionFiles));
    assert.ok(Array.isArray(result.candidatePaths));
    assert.equal(result.sessionFiles.length, 0);
});
