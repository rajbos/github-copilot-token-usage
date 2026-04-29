/**
 * Unit tests for ecosystem adapters and the IDiscoverableEcosystem interface.
 * Tests cover: isDiscoverable type guard, handles(), getCandidatePaths(),
 * getEditorRoot(), and discover() adapter loop behavior.
 */
import test from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import * as os from 'node:os';

import { isDiscoverable } from '../../src/ecosystemAdapter';
import type { IEcosystemAdapter } from '../../src/ecosystemAdapter';

import { OpenCodeAdapter } from '../../src/adapters/openCodeAdapter';
import { CrushAdapter } from '../../src/adapters/crushAdapter';
import { ContinueAdapter } from '../../src/adapters/continueAdapter';
import { ClaudeCodeAdapter } from '../../src/adapters/claudeCodeAdapter';
import { ClaudeDesktopAdapter } from '../../src/adapters/claudeDesktopAdapter';
import { VisualStudioAdapter } from '../../src/adapters/visualStudioAdapter';
import { MistralVibeAdapter } from '../../src/adapters/mistralVibeAdapter';
import { CopilotChatAdapter } from '../../src/adapters/copilotChatAdapter';
import { CopilotCliAdapter } from '../../src/adapters/copilotCliAdapter';

import { OpenCodeDataAccess } from '../../src/opencode';
import { CrushDataAccess } from '../../src/crush';
import { ContinueDataAccess } from '../../src/continue';
import { ClaudeCodeDataAccess } from '../../src/claudecode';
import { ClaudeDesktopCoworkDataAccess } from '../../src/claudedesktop';
import { VisualStudioDataAccess } from '../../src/visualstudio';
import { MistralVibeDataAccess } from '../../src/mistralvibe';

// Stub functions for adapters requiring callbacks
const noopEstimateTokens = (_text: string, _model?: string) => 0;
const noopIsMcpTool = (_name: string) => false;
const noopExtractMcpServerName = (_name: string) => '';

// Adapter instances
const openCodeDA = new OpenCodeDataAccess(null as any);
const crushDA = new CrushDataAccess(null as any);
const continueDA = new ContinueDataAccess();
const claudeCodeDA = new ClaudeCodeDataAccess();
const claudeDesktopDA = new ClaudeDesktopCoworkDataAccess();
const visualStudioDA = new VisualStudioDataAccess();
const mistralVibeDA = new MistralVibeDataAccess();

const openCodeAdapter = new OpenCodeAdapter(openCodeDA);
const crushAdapter = new CrushAdapter(crushDA);
const continueAdapter = new ContinueAdapter(continueDA);
const claudeCodeAdapter = new ClaudeCodeAdapter(claudeCodeDA);
const claudeDesktopAdapter = new ClaudeDesktopAdapter(claudeDesktopDA, noopIsMcpTool, noopExtractMcpServerName, noopEstimateTokens);
const visualStudioAdapter = new VisualStudioAdapter(visualStudioDA, noopEstimateTokens);
const mistralVibeAdapter = new MistralVibeAdapter(mistralVibeDA);
const copilotChatAdapter = new CopilotChatAdapter();
const copilotCliAdapter = new CopilotCliAdapter();

const allAdapters: IEcosystemAdapter[] = [
    openCodeAdapter, crushAdapter, continueAdapter,
    claudeCodeAdapter, claudeDesktopAdapter, visualStudioAdapter, mistralVibeAdapter,
    copilotChatAdapter, copilotCliAdapter,
];

// ---------------------------------------------------------------------------
// isDiscoverable type guard
// ---------------------------------------------------------------------------

test('isDiscoverable: returns true for all 9 adapters', () => {
    for (const adapter of allAdapters) {
        assert.ok(isDiscoverable(adapter), `Expected ${adapter.id} to be discoverable`);
    }
    assert.equal(allAdapters.length, 9);
});

test('isDiscoverable: returns false for plain IEcosystemAdapter without discover()', () => {
    const plainAdapter: IEcosystemAdapter = {
        id: 'plain', displayName: 'Plain',
        handles: () => false, getBackingPath: (f) => f, stat: async (f) => { throw new Error(); },
        getTokens: async () => ({ tokens: 0, thinkingTokens: 0, actualTokens: 0 }),
        countInteractions: async () => 0, getModelUsage: async () => ({}),
        getMeta: async () => ({ title: undefined, firstInteraction: null, lastInteraction: null }),
        getEditorRoot: () => '',
    };
    assert.ok(!isDiscoverable(plainAdapter));
});

// ---------------------------------------------------------------------------
// Adapter IDs and display names
// ---------------------------------------------------------------------------

test('adapter IDs are stable lowercase identifiers', () => {
    assert.equal(openCodeAdapter.id, 'opencode');
    assert.equal(crushAdapter.id, 'crush');
    assert.equal(continueAdapter.id, 'continue');
    assert.equal(claudeCodeAdapter.id, 'claudecode');
    assert.equal(claudeDesktopAdapter.id, 'claudedesktop');
    assert.equal(visualStudioAdapter.id, 'visualstudio');
    assert.equal(mistralVibeAdapter.id, 'mistralvibe');
    assert.equal(copilotChatAdapter.id, 'copilotchat');
    assert.equal(copilotCliAdapter.id, 'copilotcli');
});

// ---------------------------------------------------------------------------
// handles() — path recognition
// ---------------------------------------------------------------------------

test('OpenCodeAdapter.handles: recognises JSON session paths', () => {
    const p = path.join(openCodeDA.getOpenCodeDataDir(), 'storage', 'session', 'ses_abc123.json');
    assert.ok(openCodeAdapter.handles(p));
});

test('OpenCodeAdapter.handles: recognises DB virtual paths', () => {
    const p = path.join(openCodeDA.getOpenCodeDataDir(), 'opencode.db#ses_abc123');
    assert.ok(openCodeAdapter.handles(p));
});

test('OpenCodeAdapter.handles: rejects unrelated paths', () => {
    assert.ok(!openCodeAdapter.handles(path.join(os.homedir(), '.continue', 'sessions', 'abc.json')));
    assert.ok(!openCodeAdapter.handles(path.join(os.homedir(), '.claude', 'projects', 'hash', 'abc.jsonl')));
});

test('ContinueAdapter.handles: recognises ~/.continue/sessions paths', () => {
    const p = path.join(os.homedir(), '.continue', 'sessions', 'abc123.json');
    assert.ok(continueAdapter.handles(p));
});

test('ContinueAdapter.handles: rejects unrelated paths', () => {
    assert.ok(!continueAdapter.handles(path.join(os.homedir(), '.claude', 'projects', 'hash', 'abc.jsonl')));
});

test('ClaudeCodeAdapter.handles: recognises ~/.claude/projects paths', () => {
    const p = path.join(os.homedir(), '.claude', 'projects', 'my-project', 'abc123.jsonl');
    assert.ok(claudeCodeAdapter.handles(p));
});

test('ClaudeCodeAdapter.handles: rejects ~/.claude/stats-cache.json', () => {
    assert.ok(!claudeCodeAdapter.handles(path.join(os.homedir(), '.claude', 'stats-cache.json')));
});

test('MistralVibeAdapter.handles: recognises ~/.vibe/logs/session paths', () => {
    const p = path.join(os.homedir(), '.vibe', 'logs', 'session', 'session_20240101_120000_abc12345', 'meta.json');
    assert.ok(mistralVibeAdapter.handles(p));
});

test('MistralVibeAdapter.handles: rejects unrelated paths', () => {
    assert.ok(!mistralVibeAdapter.handles(path.join(os.homedir(), '.claude', 'projects', 'hash', 'abc.jsonl')));
});

// ---------------------------------------------------------------------------
// getCandidatePaths() — structure validation
// ---------------------------------------------------------------------------

test('getCandidatePaths: all adapters return array of {path, source}', () => {
    for (const adapter of allAdapters) {
        if (!isDiscoverable(adapter)) { continue; }
        const paths = adapter.getCandidatePaths();
        assert.ok(Array.isArray(paths), `${adapter.id}: expected array`);
        for (const cp of paths) {
            assert.ok(typeof cp.path === 'string' && cp.path.length > 0, `${adapter.id}: path should be non-empty string`);
            assert.ok(typeof cp.source === 'string' && cp.source.length > 0, `${adapter.id}: source should be non-empty string`);
        }
    }
});

test('OpenCodeAdapter.getCandidatePaths: returns both JSON dir and DB paths', () => {
    const paths = openCodeAdapter.getCandidatePaths();
    const sources = paths.map(p => p.source);
    assert.ok(sources.some(s => s.includes('JSON')), 'Should include JSON path');
    assert.ok(sources.some(s => s.includes('DB')), 'Should include DB path');
    assert.equal(paths.length, 2);
});

test('CrushAdapter.getCandidatePaths: always includes projects.json path', () => {
    const paths = crushAdapter.getCandidatePaths();
    assert.ok(paths.length >= 1);
    assert.ok(paths[0].path.endsWith('projects.json'));
    assert.ok(paths[0].source.includes('Crush'));
});

test('ContinueAdapter.getCandidatePaths: returns sessions directory path', () => {
    const paths = continueAdapter.getCandidatePaths();
    assert.equal(paths.length, 1);
    assert.ok(paths[0].path.length > 0);
    assert.equal(paths[0].source, 'Continue');
});

test('ClaudeCodeAdapter.getCandidatePaths: returns Claude Code projects directory', () => {
    const paths = claudeCodeAdapter.getCandidatePaths();
    assert.equal(paths.length, 1);
    assert.ok(paths[0].path.includes('.claude'));
    assert.equal(paths[0].source, 'Claude Code');
});

test('MistralVibeAdapter.getCandidatePaths: returns session log directory', () => {
    const paths = mistralVibeAdapter.getCandidatePaths();
    assert.equal(paths.length, 1);
    assert.ok(paths[0].path.includes('.vibe'));
    assert.equal(paths[0].source, 'Mistral Vibe');
});

// ---------------------------------------------------------------------------
// getEditorRoot() — returns non-empty string
// ---------------------------------------------------------------------------

test('getEditorRoot: all adapters return non-empty string', () => {
    const dummyFile = '/dummy/path/session.json';
    for (const adapter of allAdapters) {
        // claudedesktop is Windows-only; getCoworkBaseDir() returns '' on non-Windows platforms
        if (adapter.id === 'claudedesktop' && os.platform() !== 'win32') { continue; }
        const root = adapter.getEditorRoot(dummyFile);
        assert.ok(typeof root === 'string' && root.length > 0, `${adapter.id}: getEditorRoot should return non-empty string`);
    }
});

test('OpenCodeAdapter.getEditorRoot: returns opencode data directory', () => {
    const root = openCodeAdapter.getEditorRoot('/any/path');
    assert.ok(root.includes('opencode'));
});

test('ContinueAdapter.getEditorRoot: returns continue data directory', () => {
    const root = continueAdapter.getEditorRoot('/any/path');
    assert.ok(root.includes('.continue'));
});

test('ClaudeCodeAdapter.getEditorRoot: returns claude data directory', () => {
    const root = claudeCodeAdapter.getEditorRoot('/any/path');
    assert.ok(root.includes('.claude'));
});

// ---------------------------------------------------------------------------
// discover() — adapter loop behavior (empty directories)
// ---------------------------------------------------------------------------

test('discover: returns DiscoveryResult shape when no sessions exist', async () => {
    // All adapters should gracefully return empty sessionFiles when data dirs don't exist
    for (const adapter of allAdapters) {
        if (!isDiscoverable(adapter)) { continue; }
        const result = await adapter.discover(() => { /* noop */ });
        assert.ok(typeof result === 'object', `${adapter.id}: should return object`);
        assert.ok(Array.isArray(result.sessionFiles), `${adapter.id}: sessionFiles should be array`);
        assert.ok(Array.isArray(result.candidatePaths), `${adapter.id}: candidatePaths should be array`);
        // candidatePaths from discover() should match getCandidatePaths() (or be a superset for crush multi-project)
        const syncPaths = adapter.getCandidatePaths();
        for (const cp of syncPaths) {
            const found = result.candidatePaths.some(rp => rp.path === cp.path && rp.source === cp.source);
            assert.ok(found, `${adapter.id}: discover() candidatePaths should include getCandidatePaths() entry: ${cp.path}`);
        }
    }
});

// ---------------------------------------------------------------------------
// getCandidatePaths() / discover() consistency
// ---------------------------------------------------------------------------

test('getCandidatePaths paths are consistent with discover candidatePaths', async () => {
    // For all adapters, getCandidatePaths() should be a subset of discover().candidatePaths
    // (Crush can return MORE paths from discover if projects are found)
    for (const adapter of allAdapters) {
        if (!isDiscoverable(adapter)) { continue; }
        const syncPaths = adapter.getCandidatePaths().map(cp => cp.path);
        const discoverResult = await adapter.discover(() => { /* noop */ });
        const discoverPaths = discoverResult.candidatePaths.map(cp => cp.path);
        for (const sp of syncPaths) {
            assert.ok(discoverPaths.includes(sp), `${adapter.id}: sync path '${sp}' missing from discover() result`);
        }
    }
});

// ---------------------------------------------------------------------------
// extractClaudeSlashCommand — slash command detection
// ---------------------------------------------------------------------------

import { extractClaudeSlashCommand } from '../../src/adapters/claudeCodeAdapter';

test('extractClaudeSlashCommand: returns command name for allowed slash commands', () => {
    assert.equal(extractClaudeSlashCommand('/review'), 'review');
    assert.equal(extractClaudeSlashCommand('/bug'), 'bug');
    assert.equal(extractClaudeSlashCommand('/think'), 'think');
    assert.equal(extractClaudeSlashCommand('/compact'), 'compact');
    assert.equal(extractClaudeSlashCommand('/pr_comments'), 'pr_comments');
});

test('extractClaudeSlashCommand: returns null for unknown commands', () => {
    assert.equal(extractClaudeSlashCommand('/unknown'), null);
    assert.equal(extractClaudeSlashCommand('/init'), null);
    assert.equal(extractClaudeSlashCommand('/memory'), null);
});

test('extractClaudeSlashCommand: returns null for non-slash messages', () => {
    assert.equal(extractClaudeSlashCommand('can you review my code'), null);
    assert.equal(extractClaudeSlashCommand(''), null);
    assert.equal(extractClaudeSlashCommand(null), null);
});

test('extractClaudeSlashCommand: handles string with trailing text', () => {
    assert.equal(extractClaudeSlashCommand('/review this file'), 'review');
    assert.equal(extractClaudeSlashCommand('/bug fix the null pointer'), 'bug');
});

test('extractClaudeSlashCommand: handles array content blocks', () => {
    const content = [{ type: 'text', text: '/review' }];
    assert.equal(extractClaudeSlashCommand(content), 'review');
});

test('extractClaudeSlashCommand: ignores slash commands not at the start', () => {
    assert.equal(extractClaudeSlashCommand('some text\n/review'), null);
    assert.equal(extractClaudeSlashCommand('prefix /review'), null);
});
