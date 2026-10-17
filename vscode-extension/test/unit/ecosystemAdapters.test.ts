/**
 * Unit tests for ecosystem adapters and the IDiscoverableEcosystem interface.
 * Tests cover: isDiscoverable type guard, handles(), getCandidatePaths(),
 * getEditorRoot(), discover() adapter loop behavior, and ClaudeDesktopAdapter
 * buildTurns() token deduplication for Cowork JSONL sessions.
 */
import test from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';

import { isDiscoverable } from '../../../src/ecosystemAdapter';
import type { IEcosystemAdapter } from '../../../src/ecosystemAdapter';

import { OpenCodeAdapter } from '../../../src/adapters/openCodeAdapter';
import { CrushAdapter } from '../../../src/adapters/crushAdapter';
import { ContinueAdapter } from '../../../src/adapters/continueAdapter';
import { EclipseAdapter } from '../../../src/adapters/eclipseAdapter';
import { ClaudeCodeAdapter } from '../../../src/adapters/claudeCodeAdapter';
import { ClaudeDesktopAdapter } from '../../../src/adapters/claudeDesktopAdapter';
import { isMcpTool, extractMcpServerName } from '../../../src/workspaceHelpers';
import { VisualStudioAdapter } from '../../../src/adapters/visualStudioAdapter';
import { MistralVibeAdapter } from '../../../src/adapters/mistralVibeAdapter';
import { GeminiCliAdapter } from '../../../src/adapters/geminiCliAdapter';
import { CopilotChatAdapter } from '../../../src/adapters/copilotChatAdapter';
import { CopilotCliAdapter } from '../../../src/adapters/copilotCliAdapter';
import { AntigravityAdapter } from '../../../src/adapters/antigravityAdapter';
import { KiroAdapter } from '../../../src/adapters/kiroAdapter';
import { KiroCliAdapter } from '../../../src/adapters/kiroCliAdapter';
import { DevinCliAdapter } from '../../../src/adapters/devinCliAdapter';
import { ClineAdapter } from '../../../src/adapters/clineAdapter';
import { CodexCliAdapter } from '../../../src/adapters/codexCliAdapter';
import { HermesAdapter } from '../../../src/adapters/hermesAdapter';
import { KiloAdapter } from '../../../src/adapters/kiloAdapter';

import { OpenCodeDataAccess } from '../../../src/opencode';
import { CrushDataAccess } from '../../../src/crush';
import { ContinueDataAccess } from '../../../src/continue';
import { EclipseDataAccess } from '../../../src/eclipse';
import { ClaudeCodeDataAccess } from '../../../src/claudecode';
import { ClaudeDesktopDataAccess } from '../../../src/claudedesktop';
import { VisualStudioDataAccess } from '../../../src/visualstudio';
import { MistralVibeDataAccess } from '../../../src/mistralvibe';
import { GeminiCliDataAccess } from '../../../src/geminicli';
import { AntigravityDataAccess } from '../../../src/antigravity';
import { KiroDataAccess } from '../../../src/kiro';
import { KiroCliDataAccess } from '../../../src/kirocli';
import { DevinCliDataAccess } from '../../../src/devinCli';
import { ClineDataAccess } from '../../../src/cline';
import { CodexCliDataAccess } from '../../../src/codexcli';
import { HermesDataAccess } from '../../../src/hermes';
import { KiloDataAccess } from '../../../src/kilo';
import { calculateEstimatedCost } from '../../../src/tokenEstimation';
import * as modelPricing from '../../../src/modelPricing.json';

// Stub functions for adapters requiring callbacks
const noopEstimateTokens = (_text: string, _model?: string) => 0;
const noopIsMcpTool = (_name: string) => false;
const noopExtractMcpServerName = (_name: string) => '';

// Adapter instances
const openCodeDA = new OpenCodeDataAccess(null as any);
const crushDA = new CrushDataAccess(null as any);
const continueDA = new ContinueDataAccess();
const eclipseDA = new EclipseDataAccess();
const claudeCodeDA = new ClaudeCodeDataAccess();
const claudeDesktopDA = new ClaudeDesktopDataAccess();
const visualStudioDA = new VisualStudioDataAccess();
const mistralVibeDA = new MistralVibeDataAccess();
const geminiCliDA = new GeminiCliDataAccess();
const antigravityDA = new AntigravityDataAccess();
const kiroDA = new KiroDataAccess();
const kiroCliDA = new KiroCliDataAccess();
const devinCliDA = new DevinCliDataAccess();
const clineDA = new ClineDataAccess();
const codexCliDA = new CodexCliDataAccess();
const hermesDA = new HermesDataAccess();
const kiloDA = new KiloDataAccess(null as any);

const openCodeAdapter = new OpenCodeAdapter(openCodeDA);
const crushAdapter = new CrushAdapter(crushDA);
const continueAdapter = new ContinueAdapter(continueDA);
const eclipseAdapter = new EclipseAdapter(eclipseDA);
const claudeCodeAdapter = new ClaudeCodeAdapter(claudeCodeDA);
const claudeDesktopAdapter = new ClaudeDesktopAdapter(claudeDesktopDA, noopIsMcpTool, noopExtractMcpServerName, noopEstimateTokens);
const visualStudioAdapter = new VisualStudioAdapter(visualStudioDA, noopEstimateTokens);
const mistralVibeAdapter = new MistralVibeAdapter(mistralVibeDA);
const geminiCliAdapter = new GeminiCliAdapter(geminiCliDA);
const copilotChatAdapter = new CopilotChatAdapter();
const copilotCliAdapter = new CopilotCliAdapter();
const antigravityAdapter = new AntigravityAdapter(antigravityDA);
const kiroAdapter = new KiroAdapter(kiroDA);
const kiroCliAdapter = new KiroCliAdapter(kiroCliDA);
const devinCliAdapter = new DevinCliAdapter(devinCliDA);
const clineAdapter = new ClineAdapter(clineDA);
const codexCliAdapter = new CodexCliAdapter(codexCliDA);
const hermesAdapter = new HermesAdapter(hermesDA);
const kiloAdapter = new KiloAdapter(kiloDA);

const allAdapters: IEcosystemAdapter[] = [
    openCodeAdapter, crushAdapter, continueAdapter, eclipseAdapter,
    claudeCodeAdapter, claudeDesktopAdapter, visualStudioAdapter, mistralVibeAdapter, geminiCliAdapter,
    copilotChatAdapter, copilotCliAdapter, antigravityAdapter, kiroAdapter, kiroCliAdapter, devinCliAdapter,
    clineAdapter,
    codexCliAdapter,
    hermesAdapter,
    kiloAdapter,
];

// ---------------------------------------------------------------------------
// isDiscoverable type guard
// ---------------------------------------------------------------------------

test('isDiscoverable: returns true for all 19 adapters', () => {
    for (const adapter of allAdapters) {
        assert.ok(isDiscoverable(adapter), `Expected ${adapter.id} to be discoverable`);
    }
    assert.equal(allAdapters.length, 19);
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
    assert.equal(eclipseAdapter.id, 'eclipse');
    assert.equal(claudeCodeAdapter.id, 'claudecode');
    assert.equal(claudeDesktopAdapter.id, 'claudedesktop');
    assert.equal(visualStudioAdapter.id, 'visualstudio');
    assert.equal(mistralVibeAdapter.id, 'mistralvibe');
    assert.equal(geminiCliAdapter.id, 'geminicli');
    assert.equal(copilotChatAdapter.id, 'copilotchat');
    assert.equal(copilotCliAdapter.id, 'copilotcli');
    assert.equal(antigravityAdapter.id, 'antigravity');
    assert.equal(kiroAdapter.id, 'kiro');
    assert.equal(kiroCliAdapter.id, 'kirocli');
    assert.equal(devinCliAdapter.id, 'devincli');
    assert.equal(clineAdapter.id, 'cline');
    assert.equal(hermesAdapter.id, 'hermes');
    assert.equal(kiloAdapter.id, 'kilo');
});

// ---------------------------------------------------------------------------
// ClineAdapter — path recognition
// ---------------------------------------------------------------------------

test('ClineAdapter.handles: recognises saoudrizwan.claude-dev task ui_messages.json paths', () => {
    const p = path.join(os.homedir(), 'AppData', 'Roaming', 'Code', 'User', 'globalStorage',
        'saoudrizwan.claude-dev', 'tasks', '1782681302220', 'ui_messages.json');
    assert.ok(clineAdapter.handles(p));
});

test('ClineAdapter.handles: rejects sibling task files and unrelated paths', () => {
    const taskDir = path.join(os.homedir(), 'AppData', 'Roaming', 'Code', 'User', 'globalStorage',
        'saoudrizwan.claude-dev', 'tasks', '1782681302220');
    assert.ok(!clineAdapter.handles(path.join(taskDir, 'api_conversation_history.json')));
    assert.ok(!clineAdapter.handles(path.join(taskDir, 'task_metadata.json')));
    assert.ok(!clineAdapter.handles(path.join(os.homedir(), '.continue', 'sessions', 'abc.json')));
    assert.equal(codexCliAdapter.id, 'codexcli');
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

test('KiloAdapter.handles: recognises kilo.db DB virtual paths', () => {
    const p = path.join(kiloDA.getKiloDataDir(), 'kilo.db#ses_abc123');
    assert.ok(kiloAdapter.handles(p));
});

test('KiloAdapter.handles: rejects OpenCode paths and unrelated paths', () => {
    assert.ok(!kiloAdapter.handles(path.join(openCodeDA.getOpenCodeDataDir(), 'opencode.db#ses_abc123')));
    assert.ok(!kiloAdapter.handles(path.join(os.homedir(), '.continue', 'sessions', 'abc.json')));
    assert.ok(!kiloAdapter.handles(path.join(os.homedir(), '.claude', 'projects', 'hash', 'abc.jsonl')));
});

test('KiloDataAccess: coerces numeric token strings and ISO timestamps', async () => {
    const dataAccess = new KiloDataAccess(null as any);
    dataAccess.getKiloMessagesForSession = async () => [
        { id: 'user-1', role: 'user', time: { created: '2026-09-07T12:00:00.000Z' } },
        {
            id: 'assistant-1', role: 'assistant', parentID: 'user-1', modelID: 'test-model',
            tokens: { total: '150', output: '20', reasoning: '5', cache: { read: '10', write: '3' } }
        }
    ];

    const result = await dataAccess.getKiloSessionData('kilo.db#ses_test');

    assert.equal(result.timestamp, Date.parse('2026-09-07T12:00:00.000Z'));
    assert.equal(result.tokens, 150);
    assert.equal(result.modelUsage['test-model'].inputTokens, 125);
    assert.equal(result.modelUsage['test-model'].outputTokens, 25);
    assert.equal(result.modelUsage['test-model'].cachedReadTokens, 10);
    assert.equal(result.modelUsage['test-model'].cacheCreationTokens, 3);
});

test('KiloAdapter.analyzeUsage: ignores unsafe tool names', async () => {
    const dataAccess = new KiloDataAccess(null as any);
    dataAccess.getKiloMessagesForSession = async () => [{ id: 'assistant-1', role: 'assistant', modelID: 'test-model' }];
    dataAccess.getKiloPartsForMessage = async () => [
        { type: 'tool', tool: '__proto__' },
        { type: 'tool', tool: 'read_file' }
    ];
    const adapter = new KiloAdapter(dataAccess);

    const analysis = await adapter.analyzeUsage('kilo.db#ses_test', { modelPricing: {}, toolNameMap: {} });

    assert.equal(analysis.toolCalls.total, 1);
    assert.deepEqual(analysis.toolCalls.byTool, { read_file: 1 });
    assert.equal(Object.prototype.hasOwnProperty.call(analysis.toolCalls.byTool, '__proto__'), false);
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

test('ClaudeCodeAdapter.getDisplayName: returns Claude Desktop for entrypoint claude-desktop', () => {
    const dir = fs.mkdtempSync(path.join(process.cwd(), 'claude-adapter-'));
    const projectsDir = path.join(dir, '.claude', 'projects', 'hash');
    fs.mkdirSync(projectsDir, { recursive: true });
    const file = path.join(projectsDir, 'session.jsonl');
    fs.writeFileSync(file, JSON.stringify({ type: 'user', entrypoint: 'claude-desktop', timestamp: '2026-01-01T00:00:00.000Z' }) + '\n');
    try {
        assert.equal(claudeCodeAdapter.getDisplayName(file), 'Claude Desktop');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('ClaudeCodeAdapter.getDisplayName: returns Claude Code CLI for entrypoint cli', () => {
    const dir = fs.mkdtempSync(path.join(process.cwd(), 'claude-adapter-'));
    const projectsDir = path.join(dir, '.claude', 'projects', 'hash');
    fs.mkdirSync(projectsDir, { recursive: true });
    const file = path.join(projectsDir, 'session.jsonl');
    fs.writeFileSync(file, JSON.stringify({ type: 'user', entrypoint: 'cli', timestamp: '2026-01-01T00:00:00.000Z' }) + '\n');
    try {
        assert.equal(claudeCodeAdapter.getDisplayName(file), 'Claude Code CLI');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('MistralVibeAdapter.handles: recognises ~/.vibe/logs/session paths', () => {
    const p = path.join(os.homedir(), '.vibe', 'logs', 'session', 'session_20240101_120000_abc12345', 'meta.json');
    assert.ok(mistralVibeAdapter.handles(p));
});

test('MistralVibeAdapter.handles: rejects unrelated paths', () => {
    assert.ok(!mistralVibeAdapter.handles(path.join(os.homedir(), '.claude', 'projects', 'hash', 'abc.jsonl')));
});

/** Writes a Mistral Vibe session fixture and returns its meta.json path plus a cleanup fn. */
function writeVibeSession(stats: Record<string, unknown>, activeModel: string): { metaPath: string; cleanup: () => void } {
    const dir = fs.mkdtempSync(path.join(process.cwd(), 'vibe-session-'));
    const metaPath = path.join(dir, 'meta.json');
    fs.writeFileSync(metaPath, JSON.stringify({ config: { active_model: activeModel }, stats }));
    return { metaPath, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('MistralVibeDataAccess.getModelUsage: reports session_cached_tokens as cachedReadTokens', async () => {
    // Real shape from ~/.vibe/logs/session/*/meta.json: session_prompt_tokens already
    // INCLUDES session_cached_tokens, so the cached figure is a breakdown of the input
    // total, never an addition to it.
    const { metaPath, cleanup } = writeVibeSession(
        { session_prompt_tokens: 646563, session_completion_tokens: 5161, session_cached_tokens: 598272 },
        'mistral-medium-3.5',
    );
    try {
        const usage = await mistralVibeDA.getModelUsage(metaPath);
        assert.equal(usage['mistral-medium-3.5'].inputTokens, 646563, 'inputTokens stays the full prompt total');
        assert.equal(usage['mistral-medium-3.5'].outputTokens, 5161);
        assert.equal(usage['mistral-medium-3.5'].cachedReadTokens, 598272, 'cached portion is reported separately');
    } finally {
        cleanup();
    }
});

test('MistralVibeDataAccess.getModelUsage: cost matches Vibe\'s own session_cost for a cache-heavy session', async () => {
    // Guards the regression this fix closed: without cachedReadTokens the whole prompt
    // total is billed at the full input rate, which overstated this session ~5x
    // ($1.0086 instead of $0.2009). Expected value is the `session_cost` Vibe itself
    // recorded for this exact session.
    const { metaPath, cleanup } = writeVibeSession(
        { session_prompt_tokens: 646563, session_completion_tokens: 5161, session_cached_tokens: 598272 },
        'mistral-medium-3.5',
    );
    try {
        const usage = await mistralVibeDA.getModelUsage(metaPath);
        const cost = calculateEstimatedCost(usage, modelPricing.pricing as any);
        assert.ok(Math.abs(cost - 0.200885) < 1e-5, `expected Vibe's reported $0.200885, got $${cost.toFixed(6)}`);
    } finally {
        cleanup();
    }
});

test('MistralVibeDataAccess.getModelUsage: glm-5-2 and devstral-2 are priced rather than costing $0', async () => {
    // Both are models Vibe routes to that had no modelPricing.json entry, so every
    // session using them silently contributed $0 to cost totals.
    for (const [model, prompt, completion, expected] of [
        ['glm-5-2', 250694, 2930, 0.3638636],
        ['devstral-2', 1_000_000, 100_000, 0.6],
    ] as const) {
        const { metaPath, cleanup } = writeVibeSession(
            { session_prompt_tokens: prompt, session_completion_tokens: completion },
            model,
        );
        try {
            const cost = calculateEstimatedCost(await mistralVibeDA.getModelUsage(metaPath), modelPricing.pricing as any);
            assert.ok(cost > 0, `${model} must be priced, got $0`);
            assert.ok(Math.abs(cost - expected) < 1e-5, `${model}: expected $${expected}, got $${cost.toFixed(7)}`);
        } finally {
            cleanup();
        }
    }
});

test('modelPricing: every Mistral Medium 3.5 spelling carries the same cached-read rate', () => {
    // `mistral-medium-latest`, `mistral-medium-3.5` and `mistral-medium-3-5` are the same
    // model at the same rates. A cached rate on only some of them means a session reporting
    // one of the others still bills cache reads at the full input rate.
    const pricing = modelPricing.pricing as Record<string, { inputCostPerMillion: number; cachedInputCostPerMillion?: number }>;
    for (const id of ['mistral-medium-latest', 'mistral-medium-3.5', 'mistral-medium-3-5']) {
        assert.equal(pricing[id].inputCostPerMillion, 1.5, `${id} input rate`);
        assert.equal(pricing[id].cachedInputCostPerMillion, 0.15, `${id} must carry the cached-read rate`);
    }
});

test('MistralVibeDataAccess.getModelUsage: cached tokens exceeding prompt tokens are clamped', async () => {
    const { metaPath, cleanup } = writeVibeSession(
        { session_prompt_tokens: 100, session_completion_tokens: 10, session_cached_tokens: 5000 },
        'mistral-medium-3.5',
    );
    try {
        const usage = await mistralVibeDA.getModelUsage(metaPath);
        assert.equal(usage['mistral-medium-3.5'].cachedReadTokens, 100, 'cached read is capped at the input total');
    } finally {
        cleanup();
    }
});

test('GeminiCliAdapter.handles: recognises ~/.gemini session paths', () => {
    const p = path.join(os.homedir(), '.gemini', 'tmp', 'demo-project', 'chats', 'session-abc.jsonl');
    assert.ok(geminiCliAdapter.handles(p));
});

test('GeminiCliAdapter.handles: rejects unrelated paths', () => {
    assert.ok(!geminiCliAdapter.handles(path.join(os.homedir(), '.gemini', 'logs.json')));
});

test('GeminiCliAdapter.handles: rejects Antigravity brain paths (must not steal from AntigravityAdapter)', () => {
    const antigravityPath = path.join(os.homedir(), '.gemini', 'antigravity', 'brain', '13e60289-abcd-1234-5678-000000000000', '.system_generated', 'logs', 'transcript.jsonl');
    assert.ok(!geminiCliAdapter.handles(antigravityPath));
});

test('AntigravityAdapter.handles: recognises POSIX-style brain transcript paths', () => {
    const p = path.posix.join(os.homedir().replace(/\\/g, '/'), '.gemini', 'antigravity', 'brain', '13e60289-abcd-1234-5678-000000000000', '.system_generated', 'logs', 'transcript.jsonl');
    assert.ok(antigravityAdapter.handles(p));
});

test('AntigravityAdapter.handles: recognises Windows backslash brain transcript paths', () => {
    const p = 'C:\\Users\\RobBos\\.gemini\\antigravity\\brain\\13e60289-abcd-1234-5678-000000000000\\.system_generated\\logs\\transcript.jsonl';
    assert.ok(antigravityAdapter.handles(p));
});

test('AntigravityAdapter.handles: rejects generic Gemini CLI session paths', () => {
    const p = path.join(os.homedir(), '.gemini', 'tmp', 'demo-project', 'chats', 'session-abc.jsonl');
    assert.ok(!antigravityAdapter.handles(p));
});

test('AntigravityAdapter.handles: rejects paths that lack transcript.jsonl filename', () => {
    const p = path.join(os.homedir(), '.gemini', 'antigravity', 'brain', 'some-uuid', '.system_generated', 'logs', 'other.jsonl');
    assert.ok(!antigravityAdapter.handles(p));
});

test('KiroCliAdapter.handles: recognises ~/.kiro/sessions/cli metadata paths', () => {
    const p = path.join(os.homedir(), '.kiro', 'sessions', 'cli', '1737e9e4-1287-4dc1-85c8-acd62593c292.json');
    assert.ok(kiroCliAdapter.handles(p));
});

test('KiroCliAdapter.handles: rejects the .jsonl message log and unrelated paths', () => {
    assert.ok(!kiroCliAdapter.handles(path.join(os.homedir(), '.kiro', 'sessions', 'cli', 'abc.jsonl')));
    assert.ok(!kiroCliAdapter.handles(path.join(os.homedir(), '.continue', 'sessions', 'abc.json')));
});

test('DevinCliAdapter.handles: recognises the sessions.db virtual path scheme', () => {
    const p = `${devinCliDA.getDbPath()}#sess-abc123`;
    assert.ok(devinCliAdapter.handles(p));
});

test('DevinCliAdapter.handles: rejects unrelated paths and the Devin desktop devin:// scheme', () => {
    assert.ok(!devinCliAdapter.handles('devin://trajectory/abc123'));
    assert.ok(!devinCliAdapter.handles(path.join(os.homedir(), '.crush', 'crush.db#abc')));
    assert.ok(!devinCliAdapter.handles(path.join(os.homedir(), '.continue', 'sessions', 'abc.json')));
});

test('CodexCliAdapter.handles: recognises rollout files and state-db virtual thread paths', () => {
    const rollout = path.join(codexCliDA.getSessionsDir(), '2026', '03', '19', 'rollout-2026-03-19T12-00-00-019d0233-2d86-7c21-b13a-8fa9578d3a0d.jsonl');
    assert.ok(codexCliAdapter.handles(rollout));
    const archived = path.join(codexCliDA.getArchivedSessionsDir(), '2026', '03', '19', 'rollout-2026-03-19T12-00-00-019d0233-2d86-7c21-b13a-8fa9578d3a0d.jsonl');
    assert.ok(codexCliAdapter.handles(archived));
    const virtual = codexCliDA.virtualPath('019d0233-2d86-7c21-b13a-8fa9578d3a0d');
    assert.ok(codexCliAdapter.handles(virtual));
    assert.ok(codexCliAdapter.handles(virtual.replace(/\//g, '\\')));
});

test('CodexCliAdapter.handles: rejects unrelated paths (incl. the logs db and other adapters)', () => {
    assert.ok(!codexCliAdapter.handles(path.join(os.homedir(), '.codex', 'logs_1.sqlite')));
    assert.ok(!codexCliAdapter.handles(path.join(os.homedir(), '.codex', 'models_cache.json')));
    assert.ok(!codexCliAdapter.handles(path.join(os.homedir(), '.crush', 'crush.db#abc')));
    assert.ok(!codexCliAdapter.handles(path.join(os.homedir(), '.continue', 'sessions', 'abc.json')));
});

test('KiroAdapter.handles: recognises kiro.kiroagent workspace-sessions paths', () => {
    const p = path.join(kiroDA.getKiroWorkspaceSessionsDir(), 'YzpcVXNlcnNcdGVzdA__', '11e640cd-0350-4991-b7a1-bef80ae3ddda.json');
    assert.ok(kiroAdapter.handles(p));
});

test('KiroAdapter.handles: rejects the sessions.json index and Kiro CLI paths', () => {
    assert.ok(!kiroAdapter.handles(path.join(kiroDA.getKiroWorkspaceSessionsDir(), 'YzpcVXNlcnNcdGVzdA__', 'sessions.json')));
    assert.ok(!kiroAdapter.handles(path.join(os.homedir(), '.kiro', 'sessions', 'cli', 'abc.json')));
});

test('KiroDataAccess.decodeWorkspaceDirName: decodes base64 workspace folder names', () => {
    const kiroWorkspaceDA = new KiroDataAccess();
    assert.equal(
        kiroWorkspaceDA.decodeWorkspaceDirName('YzpcVXNlcnNcUm9iQm9zXGNvZGVccmVwb3NccmFqYm9zXEphcnZpcw__'),
        'c:\\Users\\RobBos\\code\\repos\\rajbos\\Jarvis'
    );
    assert.equal(kiroWorkspaceDA.decodeWorkspaceDirName('not-base64-path!!'), undefined);
});

test('VisualStudioAdapter.handles: recognises VS .vs session paths', () => {
    const p = 'C:\\repos\\MyProject\\.vs\\MyProject\\copilot-chat\\ca1642fb\\sessions\\7bb52dc2-4109-42b8-a24e-c5fb65fcce62';
    assert.ok(visualStudioAdapter.handles(p));
});

test('VisualStudioAdapter.handles: recognises SSMS SSMSGitHubCopilot session paths', () => {
    const p = 'C:\\Users\\user\\AppData\\Local\\Microsoft\\SSMS\\22.0_82a729ff\\SSMSGitHubCopilot\\copilot-chat\\ca1642fb\\sessions\\7bb52dc2-4109-42b8-a24e-c5fb65fcce62';
    assert.ok(visualStudioAdapter.handles(p));
});

test('VisualStudioAdapter.handles: recognises VS AppData VSGitHubCopilot session paths', () => {
    // Chats started without a solution open — no .vs folder exists (issue #2137).
    const p = 'C:\\Users\\user\\AppData\\Local\\Microsoft\\VisualStudio\\18.0_0a408795\\VSGitHubCopilot\\copilot-chat\\b6662ded\\sessions\\80720523-4109-42b8-a24e-c5fb65fcce62';
    assert.ok(visualStudioAdapter.handles(p));
});

test('VisualStudioAdapter.getDisplayName: returns "Visual Studio" for VSGitHubCopilot AppData paths', () => {
    const p = 'C:\\Users\\user\\AppData\\Local\\Microsoft\\VisualStudio\\18.0_0a408795\\VSGitHubCopilot\\copilot-chat\\b6662ded\\sessions\\80720523-4109-42b8-a24e-c5fb65fcce62';
    assert.equal(visualStudioAdapter.getDisplayName(p), 'Visual Studio');
});

test('VisualStudioAdapter.handles: rejects unrelated paths', () => {
    // A copilot-chat/sessions path outside the three known VS roots stays unhandled.
    assert.ok(!visualStudioAdapter.handles('C:\\some\\other\\app\\copilot-chat\\b6662ded\\sessions\\abc'));
    assert.ok(!visualStudioAdapter.handles(path.join(os.homedir(), '.claude', 'projects', 'hash', 'abc.jsonl')));
    assert.ok(!visualStudioAdapter.handles(path.join(os.homedir(), 'AppData', 'Roaming', 'Code', 'User', 'workspaceStorage', 'abc', 'chatSessions', 'session.json')));
});

test('VisualStudioAdapter.getDisplayName: returns "Visual Studio" for VS .vs paths', () => {
    const p = 'C:\\repos\\MyProject\\.vs\\MyProject\\copilot-chat\\ca1642fb\\sessions\\7bb52dc2-4109-42b8-a24e-c5fb65fcce62';
    assert.equal(visualStudioAdapter.getDisplayName(p), 'Visual Studio');
});

test('VisualStudioAdapter.getDisplayName: returns "SSMS" for SSMSGitHubCopilot paths', () => {
    const p = 'C:\\Users\\user\\AppData\\Local\\Microsoft\\SSMS\\22.0_82a729ff\\SSMSGitHubCopilot\\copilot-chat\\ca1642fb\\sessions\\7bb52dc2-4109-42b8-a24e-c5fb65fcce62';
    assert.equal(visualStudioAdapter.getDisplayName(p), 'SSMS');
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

test('KiloAdapter.getCandidatePaths: returns the kilo.db database path', () => {
    const paths = kiloAdapter.getCandidatePaths();
    assert.equal(paths.length, 1);
    assert.ok(paths[0].path.endsWith('kilo.db'));
    assert.equal(paths[0].source, 'Kilo Code (DB)');
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

test('GeminiCliAdapter.getCandidatePaths: returns Gemini session and index paths', () => {
    const paths = geminiCliAdapter.getCandidatePaths();
    assert.equal(paths.length, 3);
    assert.ok(paths.some(p => p.source === 'Gemini CLI (sessions)'));
    assert.ok(paths.some(p => p.source === 'Gemini CLI (projects.json)'));
    assert.ok(paths.some(p => p.source === 'Gemini CLI (logs.json)'));
});

test('VisualStudioAdapter.getCandidatePaths: returns VS log dir, VS AppData dir and SSMS sessions dir', () => {
    const paths = visualStudioAdapter.getCandidatePaths();
    assert.equal(paths.length, 3);
    assert.ok(paths.some(p => p.source === 'Visual Studio (log dir)'), 'Should include VS log dir');
    assert.ok(paths.some(p => p.source === 'Visual Studio (AppData sessions dir)'), 'Should include VS AppData sessions dir');
    assert.ok(paths.some(p => p.source === 'SSMS (sessions dir)'), 'Should include SSMS sessions dir');
    assert.ok(paths.every(p => p.path.length > 0), 'All paths should be non-empty');
});

// ---------------------------------------------------------------------------
// getEditorRoot() — returns non-empty string
// ---------------------------------------------------------------------------

test('getEditorRoot: all adapters return non-empty string', () => {
    const dummyFile = '/dummy/path/session.json';
    for (const adapter of allAdapters) {
        // claudedesktop is Windows/macOS only; getDesktopSessionDirs() returns [] on Linux
        if (adapter.id === 'claudedesktop' && os.platform() === 'linux') { continue; }
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

test('GeminiCliAdapter.getEditorRoot: returns Gemini data directory', () => {
    const root = geminiCliAdapter.getEditorRoot('/any/path');
    assert.ok(root.includes('.gemini'));
});

test('AntigravityAdapter.getEditorRoot: returns antigravity brain directory', () => {
    const root = antigravityAdapter.getEditorRoot('/any/path');
    assert.ok(root.includes('.gemini'), 'Should include .gemini in path');
    assert.ok(root.includes('antigravity'), 'Should include antigravity in path');
    assert.ok(root.includes('brain'), 'Should include brain in path');
});

test('AntigravityAdapter.getCandidatePaths: returns brain directory path', () => {
    const paths = antigravityAdapter.getCandidatePaths();
    assert.equal(paths.length, 1);
    assert.ok(paths[0].path.includes('antigravity'), 'Path should include antigravity');
    assert.equal(paths[0].source, 'Antigravity (brain/)');
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

import { extractClaudeSlashCommand, extractSkillName, extractInvokedSkillName } from '../../../src/adapters/claudeCodeAdapter';

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

// ---------------------------------------------------------------------------
// extractSkillName — agnostic Skill tool_use unwrapping (any skill, not an allowlist)
// ---------------------------------------------------------------------------

test('extractSkillName: resolves the skill name from a Skill tool_use input', () => {
    assert.equal(extractSkillName('Skill', { skill: 'graphify' }), 'graphify');
    assert.equal(extractSkillName('Skill', { skill: 'sync-host-views' }), 'sync-host-views');
});

test('extractSkillName: trims whitespace around the skill name', () => {
    assert.equal(extractSkillName('Skill', { skill: '  graphify  ' }), 'graphify');
});

test('extractSkillName: returns null for non-Skill tool names', () => {
    assert.equal(extractSkillName('Bash', { skill: 'graphify' }), null);
    assert.equal(extractSkillName('Read', {}), null);
});

test('extractSkillName: returns null for missing or malformed input.skill', () => {
    assert.equal(extractSkillName('Skill', {}), null);
    assert.equal(extractSkillName('Skill', undefined), null);
    assert.equal(extractSkillName('Skill', null), null);
    assert.equal(extractSkillName('Skill', { skill: '' }), null);
    assert.equal(extractSkillName('Skill', { skill: '   ' }), null);
    assert.equal(extractSkillName('Skill', { skill: 123 }), null);
});

// ---------------------------------------------------------------------------
// extractInvokedSkillName — user-typed slash invocation (<command-name> tag),
// a completely different representation from the Skill tool_use path above.
// ---------------------------------------------------------------------------

test('extractInvokedSkillName: resolves the skill name from a <command-name> tag (string content)', () => {
    const content = '<command-message>graphify</command-message>\n<command-name>/graphify</command-name>';
    assert.equal(extractInvokedSkillName(content), 'graphify');
});

test('extractInvokedSkillName: resolves any command name agnostically, no allowlist', () => {
    assert.equal(extractInvokedSkillName('<command-name>/some-random-skill</command-name>'), 'some-random-skill');
    assert.equal(extractInvokedSkillName('<command-name>/code-review</command-name>'), 'code-review');
});

test('extractInvokedSkillName: handles array content blocks', () => {
    const content = [{ type: 'text', text: '<command-message>graphify</command-message>\n<command-name>/graphify</command-name>' }];
    assert.equal(extractInvokedSkillName(content), 'graphify');
});

test('extractInvokedSkillName: returns null when no <command-name> tag is present', () => {
    assert.equal(extractInvokedSkillName('just a normal user message'), null);
    assert.equal(extractInvokedSkillName(''), null);
    assert.equal(extractInvokedSkillName(null), null);
    assert.equal(extractInvokedSkillName(undefined), null);
});

// ---------------------------------------------------------------------------
// ClaudeDesktopAdapter.buildTurns() — requestId deduplication
// ---------------------------------------------------------------------------

test('ClaudeDesktopAdapter.buildTurns: counts tokens once per requestId (dedup split content blocks)', async () => {
    const tmpDir = fs.mkdtempSync(path.join(process.cwd(), 'cowork-test-'));
    const sessionFile = path.join(tmpDir, 'session.jsonl');
    try {
        // Simulate Cowork JSONL: one API call (req_001) split into two events —
        // first event has the thinking block, second has the text block.
        // Both share the same requestId and identical token counts.
        const events = [
            { type: 'user', isSidechain: false, message: { role: 'user', content: 'Hello' } },
            {
                type: 'assistant', requestId: 'req_001',
                message: {
                    role: 'assistant', stop_reason: 'end_turn',
                    usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
                    content: [{ type: 'thinking', thinking: 'thoughts' }],
                },
            },
            {
                type: 'assistant', requestId: 'req_001',
                message: {
                    role: 'assistant', stop_reason: 'end_turn',
                    usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
                    content: [{ type: 'text', text: 'Hello there!' }],
                },
            },
        ];
        fs.writeFileSync(sessionFile, events.map(e => JSON.stringify(e)).join('\n'));

        const { turns } = await claudeDesktopAdapter.buildTurns(sessionFile);
        assert.equal(turns.length, 1, 'Should produce exactly 1 turn');
        const turn = turns[0];
        // Tokens should be counted ONCE (100 input + 50 output = 150), not doubled
        assert.equal(turn.actualUsage?.promptTokens, 100, 'Input tokens should not be doubled');
        assert.equal(turn.actualUsage?.completionTokens, 50, 'Output tokens should not be doubled');
        assert.equal(turn.inputTokensEstimate, 100);
        assert.equal(turn.outputTokensEstimate, 50);
        // Text from second event should still be collected
        assert.equal(turn.assistantResponse, 'Hello there!');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('ClaudeDesktopAdapter.buildTurns: collects tool calls from all content-block events of same requestId', async () => {
    const tmpDir = fs.mkdtempSync(path.join(process.cwd(), 'cowork-test-'));
    const sessionFile = path.join(tmpDir, 'session.jsonl');
    try {
        // One API call (req_001) split into 3 events: thinking, tool_use A, tool_use B
        const events = [
            { type: 'user', isSidechain: false, message: { role: 'user', content: 'Do stuff' } },
            {
                type: 'assistant', requestId: 'req_001',
                message: {
                    role: 'assistant', stop_reason: 'tool_use',
                    usage: { input_tokens: 200, output_tokens: 30, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
                    content: [{ type: 'thinking', thinking: 'planning' }],
                },
            },
            {
                type: 'assistant', requestId: 'req_001',
                message: {
                    role: 'assistant', stop_reason: 'tool_use',
                    usage: { input_tokens: 200, output_tokens: 30, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
                    content: [{ type: 'tool_use', id: 'tool_A', name: 'Read', input: { path: '/tmp/a' } }],
                },
            },
            {
                type: 'assistant', requestId: 'req_001',
                message: {
                    role: 'assistant', stop_reason: 'tool_use',
                    usage: { input_tokens: 200, output_tokens: 30, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
                    content: [{ type: 'tool_use', id: 'tool_B', name: 'Write', input: { path: '/tmp/b', content: 'x' } }],
                },
            },
        ];
        fs.writeFileSync(sessionFile, events.map(e => JSON.stringify(e)).join('\n'));

        const { turns } = await claudeDesktopAdapter.buildTurns(sessionFile);
        assert.equal(turns.length, 1);
        const turn = turns[0];
        // Tokens counted once (not 3x)
        assert.equal(turn.actualUsage?.promptTokens, 200);
        assert.equal(turn.actualUsage?.completionTokens, 30);
        // Both tool calls should be present (from events 2 and 3)
        assert.equal(turn.toolCalls.length, 2, 'Both tool calls should be collected');
        assert.ok(turn.toolCalls.some(tc => tc.toolName === 'Read'), 'Should include Read tool call');
        assert.ok(turn.toolCalls.some(tc => tc.toolName === 'Write'), 'Should include Write tool call');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('ClaudeDesktopAdapter.buildTurns: unique requestIds across turns sum correctly', async () => {
    const tmpDir = fs.mkdtempSync(path.join(process.cwd(), 'cowork-test-'));
    const sessionFile = path.join(tmpDir, 'session.jsonl');
    try {
        // Two user turns, each with one API call (no duplicates)
        const events = [
            { type: 'user', isSidechain: false, message: { role: 'user', content: 'Turn 1' } },
            {
                type: 'assistant', requestId: 'req_A',
                message: {
                    role: 'assistant', stop_reason: 'end_turn',
                    usage: { input_tokens: 100, output_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
                    content: [{ type: 'text', text: 'Response 1' }],
                },
            },
            { type: 'user', isSidechain: false, message: { role: 'user', content: 'Turn 2' } },
            {
                type: 'assistant', requestId: 'req_B',
                message: {
                    role: 'assistant', stop_reason: 'end_turn',
                    usage: { input_tokens: 150, output_tokens: 25, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
                    content: [{ type: 'text', text: 'Response 2' }],
                },
            },
        ];
        fs.writeFileSync(sessionFile, events.map(e => JSON.stringify(e)).join('\n'));

        const { turns } = await claudeDesktopAdapter.buildTurns(sessionFile);
        assert.equal(turns.length, 2);
        assert.equal(turns[0].actualUsage?.promptTokens, 100);
        assert.equal(turns[0].actualUsage?.completionTokens, 20);
        assert.equal(turns[1].actualUsage?.promptTokens, 150);
        assert.equal(turns[1].actualUsage?.completionTokens, 25);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------
// ClaudeDesktopAdapter.analyzeUsage — Skill tool_use -> skillCalls
// (Claude Desktop Cowork shares Claude Code's Skill tool wrapper convention.)
// ---------------------------------------------------------------------------

const desktopAdapterCtx = { modelPricing: {}, toolNameMap: {} };

test('ClaudeDesktopAdapter.analyzeUsage: unwraps Skill tool_use into skillCalls.byName', async () => {
    const tmpDir = fs.mkdtempSync(path.join(process.cwd(), 'cowork-test-'));
    const sessionFile = path.join(tmpDir, 'session.jsonl');
    try {
        const events = [
            {
                type: 'assistant', requestId: 'req_skill',
                message: {
                    role: 'assistant', model: 'claude-sonnet-4-6', stop_reason: 'tool_use',
                    content: [{ type: 'tool_use', id: 'toolu_1', name: 'Skill', input: { skill: 'graphify' } }],
                },
            },
        ];
        fs.writeFileSync(sessionFile, events.map(e => JSON.stringify(e)).join('\n'));

        const result = await claudeDesktopAdapter.analyzeUsage(sessionFile, desktopAdapterCtx);
        assert.equal(result.skillCalls?.byName['graphify'], 1);
        assert.equal(result.skillCalls?.total, 1);
        // Additive (Option C): the raw "Skill" wrapper tool call is still counted as-is, unchanged.
        assert.equal(result.toolCalls.byTool['Skill'], 1);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('ClaudeDesktopAdapter.analyzeUsage: does not record skillCalls for non-Skill tool calls', async () => {
    const tmpDir = fs.mkdtempSync(path.join(process.cwd(), 'cowork-test-'));
    const sessionFile = path.join(tmpDir, 'session.jsonl');
    try {
        const events = [
            {
                type: 'assistant', requestId: 'req_bash',
                message: {
                    role: 'assistant', model: 'claude-sonnet-4-6', stop_reason: 'tool_use',
                    content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } }],
                },
            },
        ];
        fs.writeFileSync(sessionFile, events.map(e => JSON.stringify(e)).join('\n'));

        const result = await claudeDesktopAdapter.analyzeUsage(sessionFile, desktopAdapterCtx);
        assert.equal(result.skillCalls?.total ?? 0, 0);
        assert.equal(result.toolCalls.byTool['Bash'], 1);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('ClaudeDesktopAdapter.analyzeUsage: pairs tool_result with tool_use to record failures and observed latency', async () => {
    const tmpDir = fs.mkdtempSync(path.join(process.cwd(), 'cowork-test-'));
    const sessionFile = path.join(tmpDir, 'session.jsonl');
    try {
        const t = (offsetMs: number) => new Date(Date.UTC(2026, 4, 1, 10, 0, 0, offsetMs)).toISOString();
        const events = [
            { type: 'assistant', timestamp: t(0), message: { role: 'assistant', model: 'claude-sonnet-4-6', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } }] } },
            { type: 'user', timestamp: t(250), parentUuid: 'x', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', is_error: true, content: 'denied' }] } },
            { type: 'assistant', timestamp: t(1000), message: { role: 'assistant', model: 'claude-sonnet-4-6', content: [{ type: 'tool_use', id: 'toolu_2', name: 'Read', input: {} }] } },
            { type: 'user', timestamp: t(1030), parentUuid: 'x', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_2', content: 'ok' }] } },
        ];
        fs.writeFileSync(sessionFile, events.map(e => JSON.stringify(e)).join('\n'));

        const result = await claudeDesktopAdapter.analyzeUsage(sessionFile, desktopAdapterCtx);
        assert.deepEqual(result.toolCalls.completedByTool, { Bash: 1, Read: 1 });
        assert.deepEqual(result.toolCalls.failuresByTool, { Bash: 1 });
        assert.equal(result.toolCalls.latencyByTool?.Bash.sumMs, 250);
        assert.equal(result.toolCalls.latencyByTool?.Read.sumMs, 30);
        assert.equal(result.toolCalls.latencyByTool?.Read.count, 1);
        assert.equal(result.toolCalls.byTool.Bash, 1);
        assert.equal(result.toolCalls.total, 2);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('ClaudeDesktopAdapter.analyzeUsage: MCP tool_use lands under mcpTools, consistent with where its outcome is recorded', async () => {
    const adapter = new ClaudeDesktopAdapter(claudeDesktopDA, isMcpTool, extractMcpServerName, noopEstimateTokens);
    const tmpDir = fs.mkdtempSync(path.join(process.cwd(), 'cowork-test-'));
    const sessionFile = path.join(tmpDir, 'session.jsonl');
    try {
        const t = (offsetMs: number) => new Date(Date.UTC(2026, 4, 1, 10, 0, 0, offsetMs)).toISOString();
        const events = [
            { type: 'assistant', timestamp: t(0), message: { role: 'assistant', model: 'claude-sonnet-4-6', content: [{ type: 'tool_use', id: 'toolu_1', name: 'mcp__github__create_issue', input: {} }] } },
            { type: 'user', timestamp: t(1500), parentUuid: 'x', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', is_error: true, content: 'nope' }] } },
            { type: 'assistant', timestamp: t(2000), message: { role: 'assistant', model: 'claude-sonnet-4-6', content: [{ type: 'tool_use', id: 'toolu_2', name: 'Read', input: {} }] } },
            { type: 'user', timestamp: t(2040), parentUuid: 'x', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_2', content: 'ok' }] } },
        ];
        fs.writeFileSync(sessionFile, events.map(e => JSON.stringify(e)).join('\n'));

        const result = await adapter.analyzeUsage(sessionFile, desktopAdapterCtx);
        assert.equal(result.toolCalls.total, 1, 'only the non-MCP call counts as a regular tool call');
        assert.deepEqual(result.toolCalls.byTool, { Read: 1 });
        assert.equal(result.mcpTools.total, 1);
        assert.deepEqual(result.mcpTools.byServer, { github: 1 });
        assert.deepEqual(result.mcpTools.byTool, { mcp__github__create_issue: 1 });
        assert.deepEqual(result.mcpTools.completedByServer, { github: 1 });
        assert.deepEqual(result.mcpTools.failuresByServer, { github: 1 });
        assert.equal(result.mcpTools.latencyByServer?.github.sumMs, 1500);
        assert.deepEqual(result.toolCalls.completedByTool, { Read: 1 });
        assert.equal(result.toolCalls.failuresByTool, undefined);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});
