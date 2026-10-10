import test from 'node:test';
import * as assert from 'node:assert/strict';
import {
    buildRepeatedTaskReport,
    detectRepeatedTasks,
    repoDisplayName,
    toRepeatedTaskInput,
    normalizePromptTokens,
    tokenSimilarity,
    PROMPT_SIMILARITY_THRESHOLD,
    MIN_CLUSTER_SIZE,
    type RepeatedTaskInput,
} from '../../../src/repeatedTasks';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function input(prompt: string, file: string, lastInteraction: string, repository?: string): RepeatedTaskInput {
    return { prompt, session: { file, title: null, lastInteraction, repository } };
}

// ---------------------------------------------------------------------------
// normalizePromptTokens
// ---------------------------------------------------------------------------

test('normalizePromptTokens: lowercases, strips punctuation, drops stopwords and short tokens', () => {
    const tokens = normalizePromptTokens('Run the tests, and FIX all of the failures!');
    assert.ok(tokens);
    assert.deepEqual([...tokens].sort(), ['failures', 'fix', 'run', 'tests']);
});

test('normalizePromptTokens: excludes slash commands (already reusable invocations)', () => {
    assert.equal(normalizePromptTokens('/fix the broken tests please'), null);
});

test('normalizePromptTokens: excludes prompts too short to describe a task', () => {
    assert.equal(normalizePromptTokens('ok thanks'), null);
    assert.equal(normalizePromptTokens('   '), null);
});

test('normalizePromptTokens: excludes prompts that reduce to only stopwords', () => {
    assert.equal(normalizePromptTokens('yes please do that for me now'), null);
});

// ---------------------------------------------------------------------------
// tokenSimilarity
// ---------------------------------------------------------------------------

test('tokenSimilarity: identical sets = 1, disjoint sets = 0', () => {
    const a = new Set(['run', 'tests']);
    assert.equal(tokenSimilarity(a, new Set(['run', 'tests'])), 1);
    assert.equal(tokenSimilarity(a, new Set(['deploy', 'release'])), 0);
});

test('tokenSimilarity: partial overlap follows Jaccard', () => {
    // intersection 2, union 4 -> 0.5
    assert.equal(tokenSimilarity(new Set(['a1', 'b1', 'c1']), new Set(['b1', 'c1', 'd1'])), 0.5);
});

// ---------------------------------------------------------------------------
// detectRepeatedTasks
// ---------------------------------------------------------------------------

test('detectRepeatedTasks: clusters similar prompts across sessions', () => {
    const inputs = [
        input('run the tests and fix the failures', 's1', '2026-08-01T10:00:00Z', 'o/r1'),
        input('please run the tests and fix any failures', 's2', '2026-08-02T10:00:00Z', 'o/r1'),
        input('update the changelog and bump the version for release', 's3', '2026-08-03T10:00:00Z', 'o/r2'),
    ];
    const clusters = detectRepeatedTasks(inputs);
    assert.equal(clusters.length, 1);
    assert.equal(clusters[0].sessionCount, 2);
    assert.deepEqual(clusters[0].repositories, ['o/r1']);
});

test('detectRepeatedTasks: single occurrences are not reported', () => {
    const clusters = detectRepeatedTasks([input('run the tests and fix the failures', 's1', '2026-08-01T10:00:00Z')]);
    assert.equal(clusters.length, 0);
});

test('detectRepeatedTasks: boundary — partial overlap below threshold stays separate, at-threshold joins', () => {
    // Token math: centroid after two members keeps only strict-majority tokens.
    // P1 = {alpha, beta, gamma, delta, epsilon}, P2 = {alpha, beta, gamma, delta, zeta}
    // -> centroid {alpha, beta, gamma, delta}
    // P3 = {alpha, beta, gamma, omega, psi} -> |cap|=3, |cup|=5 -> 0.6 >= threshold -> joins
    // P4 = {omega, psi, chi, phi} -> disjoint -> stays its own (size 1, filtered out)
    const inputs = [
        input('alpha beta gamma delta epsilon task', 's1', '2026-08-01T10:00:00Z'),
        input('alpha beta gamma delta zeta task', 's2', '2026-08-02T10:00:00Z'),
        input('alpha beta gamma omega psi task', 's3', '2026-08-03T10:00:00Z'),
        input('omega psi chi phi completely different task', 's4', '2026-08-04T10:00:00Z'),
    ];
    const clusters = detectRepeatedTasks(inputs);
    assert.equal(clusters.length, 1, 'only the alpha/beta/gamma prompts should cluster');
    assert.equal(clusters[0].sessionCount, 3);
    assert.deepEqual(clusters[0].sharedKeywords.sort(), ['alpha', 'beta', 'gamma', 'task']);
});

test('detectRepeatedTasks: sessions are most-recent-first and the representative is the latest prompt', () => {
    const inputs = [
        input('run the tests and fix the failures', 's1', '2026-08-01T10:00:00Z'),
        input('run the tests and fix the failures again please', 's2', '2026-08-05T10:00:00Z'),
        input('run the tests and fix all failures now', 's3', '2026-08-03T10:00:00Z'),
    ];
    const [cluster] = detectRepeatedTasks(inputs);
    assert.ok(cluster);
    assert.deepEqual(cluster.sessions.map(s => s.file), ['s2', 's3', 's1']);
    assert.equal(cluster.representativePrompt, 'run the tests and fix the failures again please');
});

test('detectRepeatedTasks: clusters are sorted largest first', () => {
    const inputs = [
        input('alpha beta gamma delta task one', 's1', '2026-08-01T10:00:00Z'),
        input('alpha beta gamma delta task two', 's2', '2026-08-02T10:00:00Z'),
        input('omega psi chi phi repeated thing', 's3', '2026-08-01T10:00:00Z'),
        input('omega psi chi phi repeated thing', 's4', '2026-08-02T10:00:00Z'),
        input('omega psi chi phi repeated thing', 's5', '2026-08-03T10:00:00Z'),
    ];
    const clusters = detectRepeatedTasks(inputs);
    assert.equal(clusters.length, 2);
    assert.ok(clusters[0].sessionCount >= clusters[1].sessionCount);
    assert.equal(clusters[0].sessionCount, 3);
});

test('detectRepeatedTasks: slash commands and noise never form clusters', () => {
    const inputs = [
        input('/fix the tests', 's1', '2026-08-01T10:00:00Z'),
        input('/fix the tests', 's2', '2026-08-02T10:00:00Z'),
        input('ok', 's3', '2026-08-03T10:00:00Z'),
        input('thanks', 's4', '2026-08-04T10:00:00Z'),
    ];
    assert.equal(detectRepeatedTasks(inputs).length, 0);
});

test('detectRepeatedTasks: sessions without a repository are excluded from the repositories list', () => {
    const inputs = [
        input('run the tests and fix the failures', 's1', '2026-08-01T10:00:00Z', 'o/r1'),
        input('run the tests and fix the failures', 's2', '2026-08-02T10:00:00Z'),
    ];
    const [cluster] = detectRepeatedTasks(inputs);
    assert.deepEqual(cluster.repositories, ['o/r1']);
    assert.equal(cluster.sessions.length, 2);
});

test('detectRepeatedTasks: representative prompt is truncated with an ellipsis', () => {
    const long = 'refactor the module ' + 'with lots of extra detail '.repeat(20);
    const inputs = [
        input(long, 's1', '2026-08-01T10:00:00Z'),
        input(long, 's2', '2026-08-02T10:00:00Z'),
    ];
    const [cluster] = detectRepeatedTasks(inputs);
    assert.ok(cluster.representativePrompt.length <= 205, `representative was ${cluster.representativePrompt.length} chars`);
    assert.ok(cluster.representativePrompt.endsWith('…'));
});

test('threshold and cluster size constants are sane', () => {
    assert.ok(PROMPT_SIMILARITY_THRESHOLD > 0 && PROMPT_SIMILARITY_THRESHOLD <= 1);
    assert.ok(MIN_CLUSTER_SIZE >= 2);
});

test('detectRepeatedTasks: a prompt joins the MOST similar cluster, not the first match', () => {
    // Cluster A centroid: {red, green, blue, alpha, beta, gamma} (6 tokens).
    // Cluster B centroid: {red, green, blue, alpha, delta, epsilon, zeta, eta} (8 tokens).
    // P tokens: {red, green, blue, alpha, delta, epsilon} (6) ->
    //   vs A: |cap|=4, |cup|=8 -> 0.50 (meets threshold, first match would join A)
    //   vs B: |cap|=6, |cup|=8 -> 0.75 (more similar -> must join B)
    const inputs = [
        input('red green blue alpha beta gamma task', 'a1', '2026-08-01T10:00:00Z'),
        input('red green blue alpha beta gamma task', 'a2', '2026-08-02T10:00:00Z'),
        input('red green blue alpha delta epsilon zeta eta task', 'b1', '2026-08-01T10:00:00Z'),
        input('red green blue alpha delta epsilon zeta eta task', 'b2', '2026-08-02T10:00:00Z'),
        input('red green blue alpha delta epsilon task', 'p', '2026-08-03T10:00:00Z'),
    ];
    const clusters = detectRepeatedTasks(inputs);
    assert.equal(clusters.length, 2);
    const withP = clusters.find(c => c.sessions.some(s => s.file === 'p'));
    assert.ok(withP, 'P should join a cluster');
    assert.ok(withP.sharedKeywords.includes('delta'), 'P should join the more similar cluster B');
    assert.equal(withP.sessionCount, 3);
    const withoutP = clusters.find(c => !c.sessions.some(s => s.file === 'p'));
    assert.ok(withoutP);
    assert.equal(withoutP.sessionCount, 2);
    assert.ok(!withoutP.sharedKeywords.includes('delta'));
});

test('detectRepeatedTasks: identical data clusters identically regardless of input order', () => {
    const inputs = [
        input('run the tests and fix the failures', 's1', '2026-08-01T10:00:00Z', 'o/r1'),
        input('please run the tests and fix any failures', 's2', '2026-08-02T10:00:00Z', 'o/r1'),
        input('update the changelog and bump the version for release', 's3', '2026-08-03T10:00:00Z', 'o/r2'),
        input('update the changelog and bump the version please', 's4', '2026-08-04T10:00:00Z', 'o/r2'),
    ];
    const forward = detectRepeatedTasks(inputs);
    const reversed = detectRepeatedTasks(inputs.slice().reverse());
    assert.deepEqual(
        reversed.map(c => c.representativePrompt).sort(),
        forward.map(c => c.representativePrompt).sort(),
    );
    assert.deepEqual(
        reversed.map(c => c.sessionCount).sort(),
        forward.map(c => c.sessionCount).sort(),
    );
});

// ---------------------------------------------------------------------------
// repoDisplayName / toRepeatedTaskInput / buildRepeatedTaskReport
// ---------------------------------------------------------------------------

test('repoDisplayName: shortens remote URLs to owner/repo and keeps bare names', () => {
    assert.equal(repoDisplayName('https://github.com/o/r.git'), 'o/r');
    assert.equal(repoDisplayName('https://github.com/o/r'), 'o/r');
    assert.equal(repoDisplayName('git@github.com:o/r'), 'o/r');
    assert.equal(repoDisplayName('git@github.com:o/r.git'), 'o/r');
    assert.equal(repoDisplayName('ssh://git@github.com/o/r.git'), 'o/r');
    assert.equal(repoDisplayName('https://gitlab.example.com/group/sub/r/'), 'sub/r');
    assert.equal(repoDisplayName('my-repo'), 'my-repo');
    assert.equal(repoDisplayName('o/r'), 'o/r');
});

test('repoDisplayName: leaves filesystem paths and other non-remote values unchanged', () => {
    assert.equal(repoDisplayName('/Users/alice/project'), '/Users/alice/project');
    assert.equal(repoDisplayName('C:\\code\\project'), 'C:\\code\\project');
    assert.equal(repoDisplayName('C:/code/project'), 'C:/code/project');
    assert.equal(repoDisplayName('file:///Users/alice/project'), 'file:///Users/alice/project');
    assert.equal(repoDisplayName('owner/repo/extra'), 'owner/repo/extra');
});

test('toRepeatedTaskInput: skips sessions without a first prompt', () => {
    assert.equal(toRepeatedTaskInput({ file: 'a', mtime: 0 }), null);
    assert.equal(toRepeatedTaskInput({ file: 'a', mtime: 0, firstUserPrompt: '' }), null);
    assert.equal(toRepeatedTaskInput({ file: 'a', mtime: 0, firstUserPrompt: null }), null);
});

test('toRepeatedTaskInput: skips prompts clustering would drop (whitespace, stopwords, slash commands)', () => {
    assert.equal(toRepeatedTaskInput({ file: 'a', mtime: 0, firstUserPrompt: '                    ' }), null);
    assert.equal(toRepeatedTaskInput({ file: 'a', mtime: 0, firstUserPrompt: 'please could you then do it now' }), null);
    assert.equal(toRepeatedTaskInput({ file: 'a', mtime: 0, firstUserPrompt: '/fix the failing tests please' }), null);
});

test('toRepeatedTaskInput: falls back to mtime for lastInteraction and maps the repository', () => {
    const mtime = Date.parse('2026-08-05T12:00:00Z');
    const result = toRepeatedTaskInput({
        file: 'a.jsonl',
        firstUserPrompt: 'run the tests and fix the failures',
        mtime,
        repository: 'https://github.com/o/r.git',
    });
    assert.deepEqual(result, {
        prompt: 'run the tests and fix the failures',
        session: { file: 'a.jsonl', title: null, lastInteraction: '2026-08-05T12:00:00.000Z', repository: 'o/r' },
    });
    const withTimes = toRepeatedTaskInput({
        file: 'b.jsonl', firstUserPrompt: 'x'.repeat(20), mtime, title: 'T',
        lastInteraction: '2026-08-01T00:00:00Z', repository: null,
    });
    assert.equal(withTimes?.session.lastInteraction, '2026-08-01T00:00:00Z');
    assert.equal(withTimes?.session.title, 'T');
    assert.equal(withTimes?.session.repository, undefined);
});

test('buildRepeatedTaskReport: returns undefined for empty input and when nothing clusters', () => {
    assert.equal(buildRepeatedTaskReport([]), undefined);
    assert.equal(buildRepeatedTaskReport([
        { file: 'a', mtime: 0, firstUserPrompt: 'run the tests and fix the failures' },
        { file: 'b', mtime: 0, firstUserPrompt: 'update the changelog and bump the version' },
    ]), undefined);
});

test('buildRepeatedTaskReport: reports minClusterSize and counts only sessions with a prompt', () => {
    const report = buildRepeatedTaskReport([
        { file: 's1', mtime: Date.parse('2026-08-01T10:00:00Z'), firstUserPrompt: 'run the tests and fix the failures', repository: 'git@github.com:o/r' },
        { file: 's2', mtime: 0, lastInteraction: '2026-08-02T10:00:00Z', firstUserPrompt: 'please run the tests and fix any failures', repository: 'https://github.com/o/r.git' },
        { file: 's3', mtime: 0, firstUserPrompt: undefined },
        { file: 's4', mtime: 0, firstUserPrompt: '' },
        { file: 's5', mtime: 0, firstUserPrompt: 'please could you then do it now' },
        { file: 's6', mtime: 0, firstUserPrompt: '/fix the failing tests please' },
    ]);
    assert.ok(report);
    assert.equal(report.minClusterSize, MIN_CLUSTER_SIZE);
    assert.equal(report.sessionsScanned, 2);
    assert.equal(report.clusters.length, 1);
    const [cluster] = report.clusters;
    assert.equal(cluster.sessionCount, 2);
    assert.deepEqual(cluster.repositories, ['o/r']);
    assert.deepEqual(cluster.sessions.map(s => s.file), ['s2', 's1']);
    assert.equal(cluster.sessions[1].lastInteraction, '2026-08-01T10:00:00.000Z');
});
