const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const scriptPath = path.join(__dirname, 'load-cache-data.js');
const extensionId = 'robbos.copilot-token-tracker';

function createFixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'load-cache-data-test-'));
    const home = path.join(root, 'home');
    const config = path.join(root, 'config');
    const temp = path.join(root, 'temp');
    const cwd = path.join(root, 'cwd');
    for (const directory of [home, config, temp, cwd]) {
        fs.mkdirSync(directory, { recursive: true });
    }

    let storage;
    if (process.platform === 'win32') {
        storage = path.join(root, 'appdata', 'Code', 'User', 'globalStorage', extensionId);
    } else if (process.platform === 'darwin') {
        storage = path.join(home, 'Library', 'Application Support', 'Code', 'User', 'globalStorage', extensionId);
    } else {
        storage = path.join(config, 'Code', 'User', 'globalStorage', extensionId);
    }
    fs.mkdirSync(storage, { recursive: true });

    t.after(() => fs.rmSync(root, { recursive: true, force: true }));

    return {
        root,
        home,
        config,
        temp,
        cwd,
        storage,
        run(args = []) {
            const env = {
                ...process.env,
                HOME: home,
                XDG_CONFIG_HOME: config,
                APPDATA: path.join(root, 'appdata'),
                TMPDIR: temp,
                TMP: temp,
                TEMP: temp
            };
            return spawnSync(process.execPath, [scriptPath, ...args], {
                cwd,
                env,
                encoding: 'utf8',
                // A script that blocks (e.g. opening a FIFO) fails the test instead of hanging CI
                timeout: 15000
            });
        }
    };
}

test('default output removes session-identifying fields and anonymizes paths', (t) => {
    const fixture = createFixture(t);
    const sessionPath = path.join(fixture.home, 'private-workspace', 'session.jsonl');
    const cache = {
        [sessionPath]: {
            tokens: 42,
            interactions: 3,
            mtime: 123,
            title: 'private-prompt-sentinel',
            workspaceFolderPath: path.join(fixture.home, 'private-workspace'),
            repository: 'REMOTE_URL_WITH_USERINFO_PRIVATE_REPO',
            unknownPromptField: 'future-sensitive-sentinel',
            linesAdded: 4,
            languageUsage: { 'top-level-basename-sentinel': { linesAdded: 4, linesRemoved: 0 } },
            usageAnalysis: {
                firstUserPrompt: 'nested-prompt-sentinel',
                correctionMoments: [{
                    type: 'user-correction',
                    snippet: 'correction-snippet-sentinel',
                    file: 'correction-file-path-sentinel'
                }],
                contextReferences: { file: 5, byPath: { 'context-path-sentinel.ts': 2 } },
                editScope: {
                    singleFileEdits: 1,
                    languageUsage: { 'edit-scope-basename-sentinel': { linesAdded: 4, linesRemoved: 0 } }
                }
            }
        }
    };
    fs.writeFileSync(path.join(fixture.storage, 'session-cache.json'), JSON.stringify(cache));

    const result = fixture.run(['--json']);
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.deepEqual(Object.keys(output.entries), ['session-1']);
    assert.equal(output.entries['session-1'].tokens, 42);
    assert.equal(output.entries['session-1'].interactions, 3);
    assert.deepEqual(output.entries['session-1'].usageAnalysis.contextReferences, { file: 5 });
    assert.deepEqual(output.entries['session-1'].usageAnalysis.editScope, { singleFileEdits: 1 });
    assert.equal(output.entries['session-1'].linesAdded, 4);
    assert.equal('languageUsage' in output.entries['session-1'], false);
    assert.deepEqual(output.entries['session-1'].usageAnalysis.correctionMoments, [{
        type: 'user-correction'
    }]);
    assert.equal('cacheFile' in output, false);

    for (const sentinel of [
        'private-prompt-sentinel',
        'private-workspace',
        'REMOTE_URL_WITH_USERINFO_PRIVATE_REPO',
        'future-sensitive-sentinel',
        'nested-prompt-sentinel',
        'correction-snippet-sentinel',
        'correction-file-path-sentinel',
        'context-path-sentinel',
        'top-level-basename-sentinel',
        'edit-scope-basename-sentinel',
        sessionPath
    ]) {
        assert.equal(result.stdout.includes(sentinel), false, `output leaked ${sentinel}`);
    }
});

test('--include-sensitive opts in to full entries and their paths', (t) => {
    const fixture = createFixture(t);
    const sessionPath = path.join(fixture.home, 'workspace', 'session.jsonl');
    const entry = {
        tokens: 7,
        title: 'explicit-title',
        workspaceFolderPath: path.join(fixture.home, 'workspace'),
        repository: 'REMOTE_URL_WITH_USERINFO'
    };
    fs.writeFileSync(path.join(fixture.storage, 'session-cache.json'), JSON.stringify({ [sessionPath]: entry }));

    const result = fixture.run(['--include-sensitive', '--json']);
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.cacheFile, path.join(fixture.storage, 'session-cache.json'));
    assert.deepEqual(output.entries[sessionPath], entry);
});

test('--include-sensitive still strips credentials from repository URLs', (t) => {
    const fixture = createFixture(t);
    const sessionPath = path.join(fixture.home, 'workspace', 'session.jsonl');
    fs.writeFileSync(path.join(fixture.storage, 'session-cache.json'), JSON.stringify({
        [sessionPath]: { tokens: 1, repository: 'https://user:token-sentinel@github.com/owner/repo.git' }
    }));

    const result = fixture.run(['--include-sensitive', '--json']);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.includes('token-sentinel'), false);
    assert.equal(JSON.parse(result.stdout).entries[sessionPath].repository, 'https://github.com/owner/repo.git');
});

function snapshotEnvelope(entries, cacheId = 'prod') {
    // Shape written by CacheManager's shared-snapshot save (vscode-extension/src/cacheManager.ts)
    return {
        schemaVersion: 1,
        cacheVersion: 1,
        cacheId,
        generatedAt: 1,
        entryCount: Object.keys(entries).length,
        entries
    };
}

test('reads the extension snapshot envelope under the current extension id', (t) => {
    const fixture = createFixture(t);
    const currentStorage = path.join(path.dirname(fixture.storage), 'robbos.ai-engineering-fluency');
    fs.mkdirSync(currentStorage, { recursive: true });
    fs.writeFileSync(path.join(currentStorage, 'cache_prod.snapshot.json'), JSON.stringify(snapshotEnvelope({
        a: { tokens: 3, mtime: 2 },
        b: { tokens: 5, mtime: 1 }
    })));

    const result = fixture.run(['--json']);
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.totalCacheEntries, 2);
    assert.deepEqual(Object.keys(output.entries), ['session-1', 'session-2']);
    assert.equal(output.entries['session-1'].tokens, 3);
});

test('prefers the prod snapshot, then dev, over a legacy export', (t) => {
    const fixture = createFixture(t);
    fs.writeFileSync(path.join(fixture.storage, 'session-cache.json'), JSON.stringify({ legacy: { tokens: 1 } }));
    fs.writeFileSync(path.join(fixture.storage, 'cache_dev.snapshot.json'), JSON.stringify(snapshotEnvelope({ dev: { tokens: 2 } }, 'dev')));

    const devResult = fixture.run(['--json']);
    assert.equal(devResult.status, 0, devResult.stderr);
    assert.equal(JSON.parse(devResult.stdout).entries['session-1'].tokens, 2);

    fs.writeFileSync(path.join(fixture.storage, 'cache_prod.snapshot.json'), JSON.stringify(snapshotEnvelope({ prod: { tokens: 3 } })));
    const prodResult = fixture.run(['--json']);
    assert.equal(prodResult.status, 0, prodResult.stderr);
    assert.equal(JSON.parse(prodResult.stdout).entries['session-1'].tokens, 3);
});

test('rejects a malformed snapshot instead of falling back to the legacy export', (t) => {
    const fixture = createFixture(t);
    fs.writeFileSync(path.join(fixture.storage, 'session-cache.json'), JSON.stringify({ legacy: { tokens: 1 } }));
    const snapshotPath = path.join(fixture.storage, 'cache_prod.snapshot.json');

    for (const [label, content] of [
        ['invalid JSON', '{ "schemaVersion": 1, "entries": {'],
        ['bare map without an envelope', JSON.stringify({ someSession: { tokens: 5 } })],
        ['envelope without entries', JSON.stringify({ schemaVersion: 1, cacheVersion: 1, entryCount: 0 })],
        ['entries is an array', JSON.stringify({ schemaVersion: 1, entries: [] })],
        ['non-numeric schemaVersion', JSON.stringify({ schemaVersion: '1', entries: {} })],
        ['top-level array', JSON.stringify([])]
    ]) {
        fs.writeFileSync(snapshotPath, content);
        const result = fixture.run(['--json']);
        assert.equal(result.status, 3, `${label}: expected exit 3, got ${result.status}`);
        const output = JSON.parse(result.stdout);
        assert.equal(output.cacheFound, true, label);
        assert.equal(output.malformed, true, label);
        assert.match(output.error, /cache_prod\.snapshot\.json/, label);
        assert.equal(result.stdout.includes(fixture.root), false, `${label}: error leaked a local path`);
        assert.equal('entries' in output, false, `${label}: fell back to the legacy export`);
    }
});

test('rejects a legacy export that is not an object of entries', (t) => {
    const fixture = createFixture(t);
    fs.writeFileSync(path.join(fixture.storage, 'session-cache.json'), JSON.stringify(['not', 'a', 'map']));

    const result = fixture.run(['--json']);
    assert.equal(result.status, 3);
    assert.match(JSON.parse(result.stdout).error, /session-cache\.json/);
});

test('ignores cache files planted in temporary and current-working directories', (t) => {
    const fixture = createFixture(t);
    for (const [directory, fileName] of [
        [fixture.temp, 'session-cache.json'],
        [fixture.temp, 'copilot-token-tracker-cache.json'],
        [fixture.cwd, 'session-cache.json'],
        [fixture.cwd, 'cache-export.json']
    ]) {
        fs.writeFileSync(path.join(directory, fileName), JSON.stringify({ planted: { tokens: 999 } }));
    }

    const result = fixture.run();
    assert.equal(result.status, 1);
    assert.deepEqual(JSON.parse(result.stdout), {
        cacheFound: false,
        error: 'No cache file found'
    });
});

test('--last caps results at 100 and rejects invalid values', (t) => {
    const fixture = createFixture(t);
    const cache = Object.fromEntries(Array.from({ length: 150 }, (_, index) => [
        path.join(fixture.home, `session-${index}.jsonl`),
        { tokens: index, mtime: index }
    ]));
    fs.writeFileSync(path.join(fixture.storage, 'session-cache.json'), JSON.stringify(cache));

    const capped = fixture.run(['--last', '99999', '--json']);
    assert.equal(capped.status, 0, capped.stderr);
    const output = JSON.parse(capped.stdout);
    assert.equal(output.requestedCount, 100);
    assert.equal(Object.keys(output.entries).length, 100);

    const oversized = fixture.run(['--last', '9'.repeat(400), '--json']);
    assert.equal(oversized.status, 0, oversized.stderr);
    assert.equal(JSON.parse(oversized.stdout).requestedCount, 100);

    for (const invalid of ['0', '-1', '1.5', 'abc']) {
        const result = fixture.run(['--last', invalid]);
        assert.equal(result.status, 2, `expected --last ${invalid} to fail`);
    }
});

test('refuses a symlink at a candidate cache path (all platforms)', (t) => {
    const fixture = createFixture(t);
    const target = path.join(fixture.temp, 'planted.json');
    fs.writeFileSync(target, JSON.stringify(snapshotEnvelope({ planted: { tokens: 999 } })));
    try {
        fs.symlinkSync(target, path.join(fixture.storage, 'cache_prod.snapshot.json'), 'file');
    } catch (error) {
        if (error.code === 'EPERM' || error.code === 'EACCES') {
            // Windows without Developer Mode or admin rights cannot create file symlinks
            t.skip(`cannot create a symlink here (${error.code})`);
            return;
        }
        throw error;
    }

    const result = fixture.run(['--json']);
    assert.equal(result.status, 1, result.stdout);
    assert.equal(result.stdout.includes('999'), false);
});

test('a refused symlink falls through to the next real candidate, not its target', (t) => {
    const fixture = createFixture(t);
    const target = path.join(fixture.temp, 'planted.json');
    fs.writeFileSync(target, JSON.stringify(snapshotEnvelope({ planted: { tokens: 999 } })));
    fs.writeFileSync(path.join(fixture.storage, 'cache_dev.snapshot.json'), JSON.stringify(snapshotEnvelope({ real: { tokens: 7 } }, 'dev')));
    try {
        fs.symlinkSync(target, path.join(fixture.storage, 'cache_prod.snapshot.json'), 'file');
    } catch (error) {
        if (error.code === 'EPERM' || error.code === 'EACCES') {
            t.skip(`cannot create a symlink here (${error.code})`);
            return;
        }
        throw error;
    }

    const result = fixture.run(['--json']);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).entries['session-1'].tokens, 7);
});

test('does not block on a FIFO at a candidate cache path', { skip: process.platform === 'win32' && 'no filesystem FIFOs on Windows' }, (t) => {
    const fixture = createFixture(t);
    const mkfifo = spawnSync('mkfifo', [path.join(fixture.storage, 'cache_prod.snapshot.json')], { encoding: 'utf8' });
    if (mkfifo.error || mkfifo.status !== 0) {
        t.skip(`mkfifo unavailable: ${mkfifo.error ? mkfifo.error.message : mkfifo.stderr}`);
        return;
    }
    fs.writeFileSync(path.join(fixture.storage, 'cache_dev.snapshot.json'), JSON.stringify(snapshotEnvelope({ real: { tokens: 6 } }, 'dev')));

    const result = fixture.run(['--json']);
    assert.equal(result.error, undefined, `script did not finish: ${result.error && result.error.code}`);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).entries['session-1'].tokens, 6);
});

test('ignores a directory at a candidate cache path', (t) => {
    const fixture = createFixture(t);
    fs.mkdirSync(path.join(fixture.storage, 'cache_prod.snapshot.json'));
    fs.writeFileSync(path.join(fixture.storage, 'cache_dev.snapshot.json'), JSON.stringify(snapshotEnvelope({ real: { tokens: 4 } }, 'dev')));

    const result = fixture.run(['--json']);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).entries['session-1'].tokens, 4);
});

// ---------------------------------------------------------------------------
// Redaction contract pinned against the cache entry types in src/types.ts.
// Every field must be classified here; adding a field to SessionFileCache or
// SessionUsageAnalysis without deciding whether it is safe to print fails
// these tests instead of silently reaching the default output.
// ---------------------------------------------------------------------------

const typesPath = path.join(__dirname, '..', '..', '..', 'src', 'types.ts');

function interfaceFields(name) {
    const source = fs.readFileSync(typesPath, 'utf8').replace(/\r\n/g, '\n');
    const start = source.indexOf(`export interface ${name} {`);
    assert.notEqual(start, -1, `interface ${name} not found in src/types.ts`);
    const end = source.indexOf('\n}', start);
    const body = source.slice(start, end);
    const fields = [...body.matchAll(/^ {2}(\w+)\??:/gm)].map(match => match[1]);
    assert.ok(fields.length > 5, `parsed only ${fields.length} fields from ${name}; has src/types.ts changed format?`);
    return fields;
}

// Printed by default (the script's SAFE_CACHE_ENTRY_FIELDS).
const TOP_LEVEL_PRINTED = [
    'tokens', 'interactions', 'modelUsage', 'mtime', 'size', 'detailsOnly',
    'usageAnalysis', 'taskCategory', 'taskCategoryShares', 'firstInteraction',
    'lastInteraction', 'repositoryResolved', 'thinkingTokens', 'actualTokens',
    'cacheReadTokens', 'modelTurns', 'debugLogInputTokens', 'debugLogOutputTokens',
    'debugLogChecked', 'subAgentCalls', 'copilotExactCostDollars', 'truncationCount',
    'messagesRemovedByTruncation', 'maxRequestInputTokens', 'contextTier',
    'dailyRollups', 'linesAdded', 'linesRemoved'
];
// Omitted by default: session text, local paths, remote URLs, basename-keyed maps.
const TOP_LEVEL_OMITTED = ['title', 'repository', 'workspaceFolderPath', 'languageUsage'];

// usageAnalysis fields printed unchanged: counts, plus maps keyed only by model ids,
// effort levels or fixed category names.
const USAGE_ANALYSIS_PRINTED = [
    'modeUsage', 'autonomyUsage', 'cacheBreakage',
    'taskClassification', 'thinkingEffort', 'applyUsage', 'sessionDuration',
    'conversationPatterns', 'agentTypes', 'modelEfficiency', 'correctionCounts'
];
// usageAnalysis fields printed with a path/text sub-field or session-name-keyed maps removed.
const USAGE_ANALYSIS_FILTERED = [
    'contextReferences', 'editScope', 'correctionMoments', 'toolCalls', 'mcpTools', 'skillCalls',
    'modelSwitching', 'agentUsage'
];
// usageAnalysis fields omitted entirely.
const USAGE_ANALYSIS_OMITTED = ['firstUserPrompt'];

test('every SessionFileCache field is classified as printed or omitted', () => {
    const classified = new Set([...TOP_LEVEL_PRINTED, ...TOP_LEVEL_OMITTED]);
    const unclassified = interfaceFields('SessionFileCache').filter(field => !classified.has(field));
    assert.deepEqual(unclassified, [], 'classify these new SessionFileCache fields in load-cache-data.js and this test');
});

test('every SessionUsageAnalysis field is classified', () => {
    const classified = new Set([...USAGE_ANALYSIS_PRINTED, ...USAGE_ANALYSIS_FILTERED, ...USAGE_ANALYSIS_OMITTED]);
    const unclassified = interfaceFields('SessionUsageAnalysis').filter(field => !classified.has(field));
    assert.deepEqual(unclassified, [], 'classify these new SessionUsageAnalysis fields in load-cache-data.js and this test');
});

// CorrectionMoment fields printed by default (the script's SAFE_CORRECTION_MOMENT_FIELDS):
// counts, flags, timestamps and this repo's own pattern labels.
const CORRECTION_MOMENT_PRINTED = [
    'type', 'turnNumber', 'timestamp', 'retried', 'matchedPattern', 'intensity', 'escalated', 'corroboratedBy'
];
// Omitted: message excerpt, session tool name, local file path.
const CORRECTION_MOMENT_OMITTED = ['snippet', 'tool', 'file'];

test('every CorrectionMoment field is classified and only the printed ones are emitted', (t) => {
    const fields = interfaceFields('CorrectionMoment');
    const classified = new Set([...CORRECTION_MOMENT_PRINTED, ...CORRECTION_MOMENT_OMITTED]);
    assert.deepEqual(fields.filter(field => !classified.has(field)), [],
        'classify these new CorrectionMoment fields in load-cache-data.js and this test');

    const fixture = createFixture(t);
    const moment = Object.fromEntries(fields.map(field => [field, `moment-${field}-sentinel`]));
    fs.writeFileSync(path.join(fixture.storage, 'cache_prod.snapshot.json'), JSON.stringify(snapshotEnvelope({
        s: { tokens: 1, usageAnalysis: { correctionMoments: [moment, 'not-an-object-sentinel'] } }
    })));
    const result = fixture.run(['--json']);
    assert.equal(result.status, 0, result.stderr);
    const [printed, ...rest] = JSON.parse(result.stdout).entries['session-1'].usageAnalysis.correctionMoments;
    assert.deepEqual(rest, []);
    assert.deepEqual(Object.keys(printed).sort(), fields.filter(field => CORRECTION_MOMENT_PRINTED.includes(field)).sort());
    for (const field of CORRECTION_MOMENT_OMITTED) {
        assert.equal(result.stdout.includes(`moment-${field}-sentinel`), false, `leaked correction moment ${field}`);
    }
    assert.equal(result.stdout.includes('not-an-object-sentinel'), false);
});

function collectStrings(value, out = []) {
    if (typeof value === 'string') {
        out.push(value);
    } else if (Array.isArray(value)) {
        value.forEach(item => collectStrings(item, out));
    } else if (value && typeof value === 'object') {
        for (const [key, item] of Object.entries(value)) {
            out.push(key);
            collectStrings(item, out);
        }
    }
    return out;
}

test('no seeded session-derived string survives anywhere in a realistic default output', (t) => {
    // Every string that comes from session content is seeded with "leak"; strings this repo
    // deliberately prints by default (model ids, effort levels, fixed kind/category labels,
    // this repo's own pattern labels) are marked "-ok".
    const fixture = createFixture(t);
    const latency = { count: 1, sumMs: 1, buckets: [1] };
    const entry = {
        tokens: 10, interactions: 2, mtime: 5, size: 100,
        modelUsage: { 'model-ok': { inputTokens: 1, outputTokens: 2 } },
        title: 'leak-title', repository: 'https://user:leak-token@host/leak-org/leak-repo.git',
        workspaceFolderPath: '/home/leak-user/leak-project',
        languageUsage: { 'leak-Dockerfile': { linesAdded: 1, linesRemoved: 0 } },
        linesAdded: 1, linesRemoved: 0, contextTier: 'tier-ok',
        dailyRollups: { '2026-10-10': { tokens: 10, actualTokens: 0, thinkingTokens: 0, interactions: 2, modelUsage: { 'model-ok': { inputTokens: 1, outputTokens: 2 } } } },
        futureField: 'leak-future-field',
        usageAnalysis: {
            firstUserPrompt: 'leak-prompt',
            toolCalls: { total: 2, byTool: { 'leak-tool': 2 }, outputTokensByTool: { 'leak-tool-out': 1 }, completedByTool: { 'leak-tool-done': 1 }, failuresByTool: { 'leak-tool-fail': 1 }, latencyByTool: { 'leak-tool-latency': latency } },
            mcpTools: { total: 1, byServer: { 'leak-server': 1 }, byTool: { 'leak-mcp-tool': 1 }, completedByServer: { 'leak-server-done': 1 }, failuresByServer: { 'leak-server-fail': 1 }, latencyByServer: { 'leak-server-latency': latency } },
            skillCalls: { total: 1, byName: { 'leak-skill': 1 } },
            agentUsage: { byAgent: { 'leak-agent': { sessions: 1, requests: 4, source: 'github' } } },
            contextReferences: {
                file: 1,
                // Known VS Code kinds are kept; any other session-supplied kind is bucketed
                byKind: { file: 2, 'copilot.image': 1, 'leak-hostile-kind /home/leak-user/x': 3, 'leak-customer-kind': 1, 'leak-not-a-count': 'leak-value' },
                byPath: { '/home/leak-user/leak-file.ts': 1 }
            },
            editScope: { singleFileEdits: 1, languageUsage: { 'leak-env': { linesAdded: 1, linesRemoved: 0 } } },
            correctionMoments: [
                { type: 'tool-error', turnNumber: 1, timestamp: null, snippet: 'Tool failed: leak-failing-tool', tool: 'leak-failing-tool', retried: true },
                { type: 'edit-retry', turnNumber: 2, timestamp: null, snippet: 'leak-snippet', file: '/home/leak-user/leak-edited.ts' },
                { type: 'user-correction', turnNumber: 3, timestamp: null, snippet: 'leak-user-text', matchedPattern: 'pattern-ok', intensity: 'strong', escalated: true }
            ],
            modelSwitching: { uniqueModels: ['model-ok'], modelCount: 1, switchCount: 0, selectedModelExtensions: ['leak-publisher.private-model-provider'], unknownProviderModels: ['model-ok'], tiers: { standard: ['model-ok'], premium: [], unknown: [] } },
            thinkingEffort: { byEffort: { 'effort-ok': 1 }, switchCount: 0, defaultEffort: 'effort-ok' },
            modelEfficiency: { 'model-ok': { turns: 1 } },
            cacheBreakage: { breaks: [{ turnIndex: 1, cause: 'ttl-expiry', model: 'model-ok', tokensRewritten: 1, gapMs: 1, ttlMs: 1 }], tokensWritten: 1, peakContextTokens: 1, rewriteFactor: 1 }
        }
    };
    fs.writeFileSync(path.join(fixture.storage, 'cache_prod.snapshot.json'), JSON.stringify(snapshotEnvelope({
        '/home/leak-user/.copilot/session-state/leak-session.jsonl': entry
    })));

    const result = fixture.run(['--json']);
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    const strings = collectStrings(output);
    assert.deepEqual(strings.filter(value => /leak/i.test(value)), []);
    assert.deepEqual(output.entries['session-1'].usageAnalysis.contextReferences.byKind,
        { file: 2, 'copilot.image': 1, other: 4 });
    // The sweep is only meaningful if the safe strings did make it through.
    for (const kept of ['model-ok', 'pattern-ok', 'effort-ok', 'tier-ok']) {
        assert.ok(strings.includes(kept), `expected ${kept} in the default output`);
    }
    // And with the opt-in flag the seeded strings are reachable (except URL credentials).
    const sensitive = fixture.run(['--include-sensitive', '--json']);
    assert.equal(sensitive.status, 0, sensitive.stderr);
    assert.ok(sensitive.stdout.includes('leak-failing-tool'));
    assert.equal(sensitive.stdout.includes('leak-token'), false);
});

test('default output prints exactly the classified fields of a fully populated entry', (t) => {
    const fixture = createFixture(t);
    const entry = Object.fromEntries(interfaceFields('SessionFileCache').map(field => [field, `top-${field}-sentinel`]));
    entry.usageAnalysis = Object.fromEntries(interfaceFields('SessionUsageAnalysis').map(field => [field, `ua-${field}-sentinel`]));
    entry.usageAnalysis.contextReferences = { file: 1, byPath: { 'ua-byPath-sentinel': 1 } };
    entry.usageAnalysis.editScope = { singleFileEdits: 1, languageUsage: { 'ua-editScope-languageUsage-sentinel': {} } };
    entry.usageAnalysis.correctionMoments = [{ type: 'user-correction', snippet: 'ua-snippet-sentinel', file: 'ua-file-sentinel' }];
    const latency = { count: 1, sumMs: 5, buckets: [1] };
    entry.usageAnalysis.toolCalls = {
        total: 3,
        byTool: { 'mcp_private-tool-sentinel_query': 3 },
        outputTokensByTool: { 'output-tool-sentinel': 10 },
        completedByTool: { 'completed-tool-sentinel': 2 },
        failuresByTool: { 'failed-tool-sentinel': 1 },
        latencyByTool: { 'latency-tool-sentinel': latency }
    };
    entry.usageAnalysis.mcpTools = {
        total: 2,
        byServer: { 'private-server-sentinel': 2 },
        byTool: { 'private-mcp-tool-sentinel': 2 },
        completedByServer: { 'completed-server-sentinel': 1 },
        failuresByServer: { 'failed-server-sentinel': 1 },
        latencyByServer: { 'latency-server-sentinel': latency }
    };
    entry.usageAnalysis.skillCalls = { total: 1, byName: { 'customer-skill-sentinel': 1 } };
    entry.usageAnalysis.agentUsage = { byAgent: { 'customer-agent-sentinel': { sessions: 1, requests: 4, source: 'github' }, 'other-agent-sentinel': { sessions: 1, requests: 1, source: 'claude' } } };
    entry.usageAnalysis.modelSwitching = { modelCount: 1, uniqueModels: ['model-a'], selectedModelExtensions: ['extension-id-sentinel'] };
    fs.writeFileSync(path.join(fixture.storage, 'cache_prod.snapshot.json'), JSON.stringify({
        schemaVersion: 1, cacheVersion: 1, cacheId: 'prod', generatedAt: 1, entryCount: 1,
        entries: { [path.join(fixture.home, 'session-path-sentinel.jsonl')]: entry }
    }));

    const result = fixture.run(['--json']);
    assert.equal(result.status, 0, result.stderr);
    const printed = JSON.parse(result.stdout).entries['session-1'];

    const expectedTopLevel = interfaceFields('SessionFileCache').filter(field => TOP_LEVEL_PRINTED.includes(field));
    assert.deepEqual(Object.keys(printed).sort(), expectedTopLevel.sort());
    assert.deepEqual(Object.keys(printed.usageAnalysis).sort(),
        interfaceFields('SessionUsageAnalysis').filter(field => !USAGE_ANALYSIS_OMITTED.includes(field)).sort());
    assert.deepEqual(printed.usageAnalysis.contextReferences, { file: 1 });
    assert.deepEqual(printed.usageAnalysis.editScope, { singleFileEdits: 1 });
    assert.deepEqual(printed.usageAnalysis.correctionMoments, [{ type: 'user-correction' }]);
    assert.deepEqual(printed.usageAnalysis.toolCalls, { total: 3 });
    assert.deepEqual(printed.usageAnalysis.mcpTools, { total: 2 });
    assert.deepEqual(printed.usageAnalysis.skillCalls, { total: 1 });
    assert.deepEqual(printed.usageAnalysis.agentUsage, { agents: 2, requests: 5 });
    assert.deepEqual(printed.usageAnalysis.modelSwitching, { modelCount: 1, uniqueModels: ['model-a'] });

    const leaked = [
        ...TOP_LEVEL_OMITTED.map(field => `top-${field}-sentinel`),
        ...USAGE_ANALYSIS_OMITTED.map(field => `ua-${field}-sentinel`),
        'ua-byPath-sentinel', 'ua-editScope-languageUsage-sentinel', 'ua-snippet-sentinel',
        'ua-file-sentinel', 'session-path-sentinel', 'cache_prod.snapshot.json',
        'private-tool-sentinel', 'output-tool-sentinel', 'completed-tool-sentinel',
        'failed-tool-sentinel', 'latency-tool-sentinel', 'private-server-sentinel',
        'private-mcp-tool-sentinel', 'completed-server-sentinel', 'failed-server-sentinel',
        'latency-server-sentinel', 'customer-skill-sentinel', 'extension-id-sentinel',
        'customer-agent-sentinel', 'other-agent-sentinel'
    ].filter(sentinel => result.stdout.includes(sentinel));
    assert.deepEqual(leaked, []);
});
