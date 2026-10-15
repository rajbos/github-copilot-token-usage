import test from 'node:test';
import * as assert from 'node:assert/strict';
import {
    detectCorrectionMoments,
    detectCorrectionAnalysis,
    summarizeCorrectionMoments,
    mergeCorrectionCounts,
    createEmptyCorrectionCounts,
    MAX_MOMENTS_PER_SESSION,
    USER_CORRECTION_PATTERNS,
    AGENT_SELF_CORRECTION_PATTERNS,
    selectCorrectionPromptExamples,
    buildCorrectionImprovementPrompt,
    MAX_PROMPT_EXAMPLES,
    type CorrectionTurn,
} from '../correctionDetection';
import type { ChatTurn, CorrectionMoment, CorrectionRepoGroup, CorrectionSessionEntry } from '../types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function editCall(file: string, toolName = 'Edit'): { toolName: string; arguments?: string } {
    return { toolName, arguments: JSON.stringify({ file_path: file }) };
}

function readCall(file: string): { toolName: string; arguments?: string } {
    return { toolName: 'Read', arguments: JSON.stringify({ file_path: file }) };
}

// ---------------------------------------------------------------------------
// user-correction
// ---------------------------------------------------------------------------

test('user-correction: detects common correction phrasings', () => {
    const cases = [
        'no, that is the wrong file',
        'No.',
        "that's wrong, use the other endpoint",
        'not what I asked for',
        "you're wrong about the API",
        'actually, keep the old behavior',
        'please revert that change',
        'why did you delete the test?',
        'you broke the build',
        'I already said to use vitest',
        "don't touch the migrations folder",
        'stop changing that file',
        "that didn't work",
        'wrong branch — use main',
    ];
    for (const [i, message] of cases.entries()) {
        const moments = detectCorrectionMoments([{ userMessage: message }]);
        assert.equal(moments.length, 1, `case ${i}: "${message}" should produce one moment`);
        assert.equal(moments[0].type, 'user-correction');
        assert.equal(moments[0].turnNumber, 1);
        assert.ok(moments[0].matchedPattern, 'should record the matched pattern label');
        assert.ok(moments[0].snippet.length > 0);
    }
});

test('user-correction: leaves ordinary requests alone', () => {
    const cases = [
        'add a login page',
        'yes, please continue',
        'can you stop the server when done?',  // "stop" only counts as an imperative correction
        'run the tests',
        'note: actually is fine inside prose-only requests',  // no comma after "actually"
        'No rulesets matched your search',
        'No blocker remaining — the work is done',
    ];
    for (const message of cases) {
        const moments = detectCorrectionMoments([{ userMessage: message }]);
        assert.equal(moments.filter(m => m.type === 'user-correction').length, 0, `"${message}" should not be flagged`);
    }
});

// ---------------------------------------------------------------------------
// agent-self-correction
// ---------------------------------------------------------------------------

test('agent-self-correction: detects admission phrasings when corroborated by a tool error', () => {
    const cases = [
        'Let me fix that for you.',
        'My mistake — the path was wrong.',
        "I was wrong about the default.",
        "You're right, I'll change it.",
        'Apologies for the confusion.',
        'Sorry, that failed. Retrying now.',
        'I incorrectly assumed the file existed.',
    ];
    for (const response of cases) {
        const moments = detectCorrectionMoments([{
            assistantResponse: response,
            toolCalls: [{ toolName: 'run', isError: true }],
        }]);
        const selfCorrections = moments.filter(m => m.type === 'agent-self-correction');
        assert.equal(selfCorrections.length, 1, `"${response}" should produce one moment`);
        assert.equal(selfCorrections[0].corroboratedBy, 'tool-error');
    }
});

test('agent-self-correction: leaves ordinary responses alone', () => {
    const moments = detectCorrectionMoments([{ assistantResponse: 'Done — I added the login page and tests pass.' }]);
    assert.equal(moments.length, 0);
});

test('agent-self-correction: an uncorroborated phrase (routine narration) produces no moment', () => {
    // "Let me fix" etc. are extremely common even when nothing went wrong — without a
    // nearby tool-error, edit-retry, or user-correction, it's just task narration.
    const moments = detectCorrectionMoments([{ assistantResponse: 'Let me fix the imports while I am in this file.' }]);
    assert.equal(moments.length, 0);
});

test('agent-self-correction: corroborated by an edit-retry in the same turn', () => {
    const moments = detectCorrectionMoments([{
        assistantResponse: 'Let me fix that.',
        toolCalls: [editCall('/a.ts'), editCall('/a.ts')],
    }]);
    const selfCorrection = moments.find(m => m.type === 'agent-self-correction');
    assert.ok(selfCorrection, 'should be corroborated by the edit-retry');
    assert.equal(selfCorrection!.corroboratedBy, 'edit-retry');
});

test('agent-self-correction: corroborated by a user-correction in the previous turn', () => {
    const turns: CorrectionTurn[] = [
        { userMessage: 'no, that is wrong' },
        { assistantResponse: 'My mistake, let me fix it.' },
    ];
    const moments = detectCorrectionMoments(turns);
    const selfCorrection = moments.find(m => m.type === 'agent-self-correction');
    assert.ok(selfCorrection, 'should be corroborated by the previous turn\'s user-correction');
    assert.equal(selfCorrection!.corroboratedBy, 'user-correction');
});

test('agent-self-correction: a user-correction two turns earlier does not corroborate', () => {
    const turns: CorrectionTurn[] = [
        { userMessage: 'no, that is wrong' },
        { userMessage: 'add a login page' },
        { assistantResponse: 'My mistake, let me fix it.' },
    ];
    const moments = detectCorrectionMoments(turns);
    assert.equal(moments.some(m => m.type === 'agent-self-correction'), false);
});

// ---------------------------------------------------------------------------
// auto-injected notifications (not authored by the human)
// ---------------------------------------------------------------------------

test('user-correction: ignores auto-injected terminal notifications', () => {
    // VS Code auto-sends a "[Terminal ... notification: ...]" message into chat when a
    // background command finishes — this is not something the user typed, and its
    // boilerplate ("...or kill_terminal to stop it.") would otherwise read as a correction.
    const notification = '[Terminal 0f67ade5 notification: command completed with exit code 1. ' +
        'Use send_to_terminal to send another command or kill_terminal to stop it.]\nTerminal output:\n...';
    const moments = detectCorrectionMoments([{ userMessage: notification }]);
    assert.equal(moments.length, 0);
});

test('user-correction: a real message starting with "no" alongside pasted terminal output still fires', () => {
    const moments = detectCorrectionMoments([{ userMessage: 'no, restart the dev server\n[some pasted log output]' }]);
    assert.equal(moments.length, 1);
    assert.equal(moments[0].type, 'user-correction');
});

// ---------------------------------------------------------------------------
// intensity
// ---------------------------------------------------------------------------

test('user-correction: flags intensity cues (shouting, repeated punctuation, intensifiers)', () => {
    const cases = [
        'STOP, that is not what I asked for',
        "that's wrong again??",
        'stop doing that, seriously',
    ];
    for (const message of cases) {
        const [moment] = detectCorrectionMoments([{ userMessage: message }]);
        assert.equal(moment.intensity, 'strong', `"${message}" should be flagged as strong intensity`);
    }
});

test('user-correction: a plain correction has no intensity flag', () => {
    const [moment] = detectCorrectionMoments([{ userMessage: 'no, use the other endpoint please' }]);
    assert.equal(moment.intensity, undefined);
});

// ---------------------------------------------------------------------------
// escalation
// ---------------------------------------------------------------------------

test('user-correction: clustering corrections are marked escalated', () => {
    const turns: CorrectionTurn[] = [
        { userMessage: 'no, wrong file' },
        { userMessage: 'add a test' },
        { userMessage: 'no, that is still not right' },
        { userMessage: 'stop changing that' },
    ];
    const result = detectCorrectionAnalysis(turns);
    const userCorrections = result.moments.filter(m => m.type === 'user-correction').sort((a, b) => a.turnNumber - b.turnNumber);
    assert.equal(userCorrections.length, 3);
    assert.equal(userCorrections[0].escalated, undefined, 'the first correction has nothing to escalate from');
    assert.equal(userCorrections[1].escalated, true);
    assert.equal(userCorrections[2].escalated, true);
    assert.equal(result.counts.escalatedUserCorrections, 2);
});

test('user-correction: corrections far apart are not escalated', () => {
    const turns: CorrectionTurn[] = [
        { userMessage: 'no, wrong file' },
        ...Array.from({ length: 10 }, () => ({ userMessage: 'add another feature' })),
        { userMessage: 'no, that is still not right' },
    ];
    const result = detectCorrectionAnalysis(turns);
    const userCorrections = result.moments.filter(m => m.type === 'user-correction');
    assert.equal(userCorrections.every(m => !m.escalated), true);
    assert.equal(result.counts.escalatedUserCorrections, 0);
});

// ---------------------------------------------------------------------------
// edit-retry / edit-self-correction
// ---------------------------------------------------------------------------

test('edit-retry: repeat edit immediately after editing the same file', () => {
    const turns: CorrectionTurn[] = [{ toolCalls: [editCall('/a.ts'), editCall('/a.ts')] }];
    const moments = detectCorrectionMoments(turns);
    assert.equal(moments.length, 1);
    assert.equal(moments[0].type, 'edit-retry');
    assert.equal(moments[0].file, '/a.ts');
});

test('edit-self-correction: repeat edit with another tool call in between', () => {
    const turns: CorrectionTurn[] = [{ toolCalls: [editCall('/a.ts'), readCall('/b.ts'), editCall('/a.ts')] }];
    const moments = detectCorrectionMoments(turns);
    assert.equal(moments.length, 1);
    assert.equal(moments[0].type, 'edit-self-correction');
    assert.equal(moments[0].file, '/a.ts');
});

test('edit detection: edits to different files produce no moments', () => {
    const turns: CorrectionTurn[] = [{ toolCalls: [editCall('/a.ts'), editCall('/b.ts'), readCall('/a.ts')] }];
    assert.equal(detectCorrectionMoments(turns).length, 0);
});

test('edit detection: matches modelEfficiency definitions across turns', () => {
    // Retries are scoped per turn: editing the same file in two separate turns is not a retry.
    const turns: CorrectionTurn[] = [
        { toolCalls: [editCall('/a.ts')] },
        { toolCalls: [editCall('/a.ts')] },
    ];
    assert.equal(detectCorrectionMoments(turns).length, 0);
});

test('edit detection: edits without a path never produce false positives', () => {
    const noPath = { toolName: 'Edit', arguments: '{}' };
    const turns: CorrectionTurn[] = [{ toolCalls: [noPath, noPath, noPath] }];
    assert.equal(detectCorrectionMoments(turns).length, 0);
});

// ---------------------------------------------------------------------------
// tool-error
// ---------------------------------------------------------------------------

test('tool-error: failed call is flagged; later same-tool call marks it retried', () => {
    const turns: CorrectionTurn[] = [
        { toolCalls: [{ toolName: 'create', isError: true }] },
        { toolCalls: [{ toolName: 'create' }] },
    ];
    const moments = detectCorrectionMoments(turns);
    assert.equal(moments.length, 1);
    assert.equal(moments[0].type, 'tool-error');
    assert.equal(moments[0].tool, 'create');
    assert.equal(moments[0].retried, true);
});

test('tool-error: failure without a later retry stays not-retried', () => {
    const turns: CorrectionTurn[] = [
        { toolCalls: [{ toolName: 'create', isError: true }] },
        { toolCalls: [{ toolName: 'view' }] },
    ];
    const moments = detectCorrectionMoments(turns);
    assert.equal(moments.length, 1);
    assert.equal(moments[0].retried, false);
});

test('tool-error: two consecutive failures of the same tool each get their own moment', () => {
    const turns: CorrectionTurn[] = [
        { toolCalls: [{ toolName: 'edit', isError: true }, { toolName: 'edit', isError: true }] },
    ];
    const moments = detectCorrectionMoments(turns);
    assert.equal(moments.length, 2);
    assert.equal(moments[0].retried, true, 'the first failure counts as retried by the second attempt');
    assert.equal(moments[1].retried, false);
});

// ---------------------------------------------------------------------------
// ChatTurn compatibility and mixed sessions
// ---------------------------------------------------------------------------

test('accepts full ChatTurn objects (superset of CorrectionTurn)', () => {
    // Pick keeps the compiler checking field compatibility without constructing
    // the full ChatTurn (context refs etc. are irrelevant to detection).
    const chatTurn: Pick<ChatTurn, 'turnNumber' | 'timestamp' | 'userMessage' | 'assistantResponse' | 'toolCalls'> = {
        turnNumber: 1,
        timestamp: '2026-08-29T21:00:00.000Z',
        userMessage: 'no, wrong file',
        assistantResponse: 'My mistake, let me fix that.',
        toolCalls: [{ toolName: 'edit', arguments: JSON.stringify({ path: '/x.ts' }), result: 'ok' }],
    };
    const moments = detectCorrectionMoments([chatTurn]);
    assert.deepEqual(moments.map(m => m.type).sort(), ['agent-self-correction', 'user-correction']);
    assert.equal(moments[0].timestamp, '2026-08-29T21:00:00.000Z');
});

test('turn numbers are 1-based array positions', () => {
    const turns: CorrectionTurn[] = [
        { userMessage: 'add a login page' },
        { userMessage: 'add tests' },
        { userMessage: 'no, not like that' },
    ];
    const moments = detectCorrectionMoments(turns);
    assert.equal(moments.length, 1);
    assert.equal(moments[0].turnNumber, 3);
});

test('caps moments per session at MAX_MOMENTS_PER_SESSION', () => {
    const turns: CorrectionTurn[] = Array.from({ length: MAX_MOMENTS_PER_SESSION + 20 }, () => ({ userMessage: 'no, wrong' }));
    const moments = detectCorrectionMoments(turns);
    assert.equal(moments.length, MAX_MOMENTS_PER_SESSION);
});

test('a single turn cannot exceed MAX_MOMENTS_PER_SESSION', () => {
    const toolCalls = Array.from({ length: 60 }, (_, i) => ({ toolName: `tool${i}`, isError: true, result: 'failed' }));
    const moments = detectCorrectionMoments([{ userMessage: 'do all the things', toolCalls }]);
    assert.equal(moments.length, MAX_MOMENTS_PER_SESSION);
    assert.ok(moments.every(m => m.turnNumber === 1));
});

test('uncapped counts retain a late user correction in the capped detail sample', () => {
    const noisyTurn = {
        toolCalls: Array.from({ length: MAX_MOMENTS_PER_SESSION + 10 }, (_, i) => ({
            toolName: `tool${i}`,
            isError: true,
        })),
    };
    const result = detectCorrectionAnalysis([noisyTurn, { userMessage: 'please revert that' }]);
    assert.equal(result.counts.toolErrors, MAX_MOMENTS_PER_SESSION + 10);
    assert.equal(result.counts.userCorrections, 1);
    assert.equal(result.moments.length, MAX_MOMENTS_PER_SESSION);
    assert.ok(result.moments.some(m => m.type === 'user-correction' && m.turnNumber === 2));
});

test('uncapped counts track retries after tool-error details reach the cap', () => {
    const failedCalls = Array.from({ length: MAX_MOMENTS_PER_SESSION + 10 }, (_, i) => ({
        toolName: `tool${i}`,
        isError: true,
    }));
    const retryCalls = failedCalls.map(({ toolName }) => ({ toolName }));
    const result = detectCorrectionAnalysis([{ toolCalls: failedCalls }, { toolCalls: retryCalls }]);
    assert.equal(result.counts.toolErrors, MAX_MOMENTS_PER_SESSION + 10);
    assert.equal(result.counts.toolErrorsRetried, MAX_MOMENTS_PER_SESSION + 10);
    assert.equal(result.moments.length, MAX_MOMENTS_PER_SESSION);
});

test('snippets are whitespace-normalized and length-capped', () => {
    const longMessage = 'x'.repeat(500) + '\n\nthat\'s wrong\n\n' + 'y'.repeat(500);
    const [moment] = detectCorrectionMoments([{ userMessage: longMessage }]);
    assert.ok(!moment.snippet.includes('\n'));
    assert.ok(moment.snippet.length <= 245, `snippet was ${moment.snippet.length} chars`);
});

// ---------------------------------------------------------------------------
// counts
// ---------------------------------------------------------------------------

test('summarizeCorrectionMoments: counts by type including retried tool errors', () => {
    const turns: CorrectionTurn[] = [
        { userMessage: 'no, wrong', toolCalls: [{ toolName: 'edit', isError: true }, editCall('/a.ts'), editCall('/a.ts')] },
        { assistantResponse: 'my mistake, let me fix it', toolCalls: [{ toolName: 'edit' }] },
    ];
    const counts = summarizeCorrectionMoments(detectCorrectionMoments(turns));
    assert.equal(counts.userCorrections, 1);
    assert.equal(counts.toolErrors, 1);
    assert.equal(counts.toolErrorsRetried, 1);
    assert.equal(counts.editRetries, 1);
    assert.equal(counts.agentSelfCorrections, 1);
    assert.equal(counts.editSelfCorrections, 0);
});

test('mergeCorrectionCounts: sums all fields and tolerates undefined', () => {
    const target = createEmptyCorrectionCounts();
    mergeCorrectionCounts(target, undefined);
    assert.deepEqual(target, createEmptyCorrectionCounts());
    mergeCorrectionCounts(target, { userCorrections: 2, editRetries: 1, editSelfCorrections: 0, toolErrors: 3, toolErrorsRetried: 2, agentSelfCorrections: 1, escalatedUserCorrections: 1 });
    mergeCorrectionCounts(target, { userCorrections: 1, editRetries: 0, editSelfCorrections: 4, toolErrors: 0, toolErrorsRetried: 0, agentSelfCorrections: 0, escalatedUserCorrections: 0 });
    assert.deepEqual(target, { userCorrections: 3, editRetries: 1, editSelfCorrections: 4, toolErrors: 3, toolErrorsRetried: 2, agentSelfCorrections: 1, escalatedUserCorrections: 1 });
});

test('pattern catalogs stay non-empty and well-formed', () => {
    for (const p of [...USER_CORRECTION_PATTERNS, ...AGENT_SELF_CORRECTION_PATTERNS]) {
        assert.ok(p.re instanceof RegExp);
        assert.ok(p.label.length > 0);
    }
});

// ---------------------------------------------------------------------------
// improvement prompt ("Ask Copilot to fix this")
// ---------------------------------------------------------------------------

function correctionMoment(overrides: Partial<CorrectionMoment> & Pick<CorrectionMoment, 'type'>): CorrectionMoment {
    return { turnNumber: 1, timestamp: null, snippet: 'example snippet', ...overrides };
}

function correctionSession(moments: CorrectionMoment[], file = 'session.jsonl'): CorrectionSessionEntry {
    return { file, moments };
}

function correctionRepoGroup(sessions: CorrectionSessionEntry[]): CorrectionRepoGroup {
    return {
        repository: 'owner/repo',
        sessions,
        counts: summarizeCorrectionMoments(sessions.flatMap(s => s.moments)),
        sessionsWithMoments: sessions.length,
    };
}

test('selectCorrectionPromptExamples: escalated user-corrections rank above everything else', () => {
    const escalated = correctionMoment({ type: 'user-correction', escalated: true, snippet: 'no, that is wrong again' });
    const toolError = correctionMoment({ type: 'tool-error', snippet: 'edit failed' });
    const repo = correctionRepoGroup([correctionSession([toolError, escalated])]);
    assert.deepEqual(selectCorrectionPromptExamples(repo), [escalated, toolError]);
});

test('selectCorrectionPromptExamples: strong-intensity corrections rank above plain ones, which rank above other types', () => {
    const plain = correctionMoment({ type: 'user-correction', snippet: 'no, not that' });
    const strong = correctionMoment({ type: 'user-correction', intensity: 'strong', snippet: 'STOP doing that again!!' });
    const editRetry = correctionMoment({ type: 'edit-retry', snippet: 're-edited a.ts' });
    const repo = correctionRepoGroup([correctionSession([editRetry, plain, strong])]);
    assert.deepEqual(selectCorrectionPromptExamples(repo), [strong, plain, editRetry]);
});

test('selectCorrectionPromptExamples: prefers moments from more recent sessions on a severity tie', () => {
    const older = correctionMoment({ type: 'tool-error', snippet: 'older failure' });
    const newer = correctionMoment({ type: 'tool-error', snippet: 'newer failure' });
    // repo.sessions is already ordered most-recent-first (see buildCorrectionReport in extension.ts)
    const repo = correctionRepoGroup([correctionSession([newer], 'newest.jsonl'), correctionSession([older], 'oldest.jsonl')]);
    assert.deepEqual(selectCorrectionPromptExamples(repo), [newer, older]);
});

test('selectCorrectionPromptExamples: caps at MAX_PROMPT_EXAMPLES', () => {
    const moments = Array.from({ length: MAX_PROMPT_EXAMPLES + 5 }, (_, i) => correctionMoment({ type: 'tool-error', snippet: `failure ${i}` }));
    const repo = correctionRepoGroup([correctionSession(moments)]);
    assert.equal(selectCorrectionPromptExamples(repo).length, MAX_PROMPT_EXAMPLES);
});

test('buildCorrectionImprovementPrompt: names the repository and includes numbered example snippets', () => {
    const repo = correctionRepoGroup([correctionSession([
        correctionMoment({ type: 'user-correction', snippet: 'no, that is wrong' }),
        correctionMoment({ type: 'tool-error', tool: 'runTests', snippet: 'tests failed' }),
    ])]);
    const prompt = buildCorrectionImprovementPrompt(repo);
    assert.ok(prompt.includes('owner/repo'));
    assert.ok(prompt.includes('1. You corrected the agent: "no, that is wrong"'));
    assert.ok(prompt.includes('2. A tool call failed (runTests): "tests failed"'));
    assert.ok(prompt.toLowerCase().includes('copilot-instructions.md'));
    assert.ok(prompt.toLowerCase().includes('agents.md'));
});

test('buildCorrectionImprovementPrompt: handles a repo with no moments gracefully', () => {
    const prompt = buildCorrectionImprovementPrompt(correctionRepoGroup([]));
    assert.ok(prompt.includes('owner/repo'));
    assert.ok(!prompt.includes('1. '));
});
