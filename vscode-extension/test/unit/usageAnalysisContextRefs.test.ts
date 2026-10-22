import test from 'node:test';
import * as assert from 'node:assert/strict';
import {
    analyzeContextReferences,
    analyzeContentReferences,
    analyzeVariableData,
    analyzeRequestContext,
    analyzeCliAttachments,
    deriveConversationPatterns,
} from '../../../src/usageAnalysis';
import { emptyRefs, emptyAnalysis } from './usageAnalysisFixtures';

// ---------------------------------------------------------------------------
// analyzeContextReferences
// ---------------------------------------------------------------------------

test('analyzeContextReferences: counts #file references in text', () => {
    const refs = emptyRefs();
    analyzeContextReferences('please look at #file and #file too', refs);
    assert.equal(refs.file, 2);
});

test('analyzeContextReferences: counts #selection references', () => {
    const refs = emptyRefs();
    analyzeContextReferences('look at #selection please', refs);
    assert.equal(refs.selection, 1);
});

test('analyzeContextReferences: counts @workspace references', () => {
    const refs = emptyRefs();
    analyzeContextReferences('search @workspace for this', refs);
    assert.equal(refs.workspace, 1);
});

test('analyzeContextReferences: counts @terminal references', () => {
    const refs = emptyRefs();
    analyzeContextReferences('what does @terminal say?', refs);
    assert.equal(refs.terminal, 1);
});

test('analyzeContextReferences: counts #codebase references', () => {
    const refs = emptyRefs();
    analyzeContextReferences('search #codebase for tests', refs);
    assert.equal(refs.codebase, 1);
});

test('analyzeContextReferences: counts #changes references', () => {
    const refs = emptyRefs();
    analyzeContextReferences('review #changes please', refs);
    assert.equal(refs.changes, 1);
});

test('analyzeContextReferences: counts #clipboard references', () => {
    const refs = emptyRefs();
    analyzeContextReferences('use #clipboard content', refs);
    assert.equal(refs.clipboard, 1);
});

test('analyzeContextReferences: counts #terminalLastCommand references', () => {
    const refs = emptyRefs();
    analyzeContextReferences('fix #terminalLastCommand error', refs);
    assert.equal(refs.terminalLastCommand, 1);
});

test('analyzeContextReferences: counts #outputPanel references', () => {
    const refs = emptyRefs();
    analyzeContextReferences('check #outputPanel', refs);
    assert.equal(refs.outputPanel, 1);
});

test('analyzeContextReferences: counts #problemsPanel references', () => {
    const refs = emptyRefs();
    analyzeContextReferences('fix #problemsPanel errors', refs);
    assert.equal(refs.problemsPanel, 1);
});

test('analyzeContextReferences: counts #pr references', () => {
    const refs = emptyRefs();
    analyzeContextReferences('review #pr changes', refs);
    assert.equal(refs.pullRequest, 1);
});

test('analyzeContextReferences: counts #pullRequest references', () => {
    const refs = emptyRefs();
    analyzeContextReferences('summarize #pullRequest please', refs);
    assert.equal(refs.pullRequest, 1);
});

test('analyzeContextReferences: #pr does not match #problemsPanel', () => {
    const refs = emptyRefs();
    analyzeContextReferences('check #problemsPanel', refs);
    assert.equal(refs.pullRequest, 0);
    assert.equal(refs.problemsPanel, 1);
});

test('analyzeContextReferences: accumulates on existing counts', () => {
    const refs = emptyRefs();
    refs.file = 2;
    analyzeContextReferences('check #file for context', refs);
    assert.equal(refs.file, 3);
});

test('analyzeContextReferences: empty text produces no counts', () => {
    const refs = emptyRefs();
    analyzeContextReferences('', refs);
    assert.equal(refs.file, 0);
    assert.equal(refs.workspace, 0);
});

test('analyzeContextReferences: matching is case-insensitive', () => {
    const refs = emptyRefs();
    analyzeContextReferences('#FILE and #File and #file', refs);
    assert.equal(refs.file, 3);
});

// ---------------------------------------------------------------------------
// deriveConversationPatterns
// ---------------------------------------------------------------------------

test('deriveConversationPatterns: 0 requests produces single-turn=0, multi-turn=0', () => {
    const analysis = emptyAnalysis();
    deriveConversationPatterns(analysis);
    assert.ok(analysis.conversationPatterns);
    assert.equal(analysis.conversationPatterns.singleTurnSessions, 0);
    assert.equal(analysis.conversationPatterns.multiTurnSessions, 0);
    assert.equal(analysis.conversationPatterns.avgTurnsPerSession, 0);
});

test('deriveConversationPatterns: 1 request produces single-turn session', () => {
    const analysis = emptyAnalysis();
    analysis.modeUsage.ask = 1;
    deriveConversationPatterns(analysis);
    assert.equal(analysis.conversationPatterns!.singleTurnSessions, 1);
    assert.equal(analysis.conversationPatterns!.multiTurnSessions, 0);
    assert.equal(analysis.conversationPatterns!.avgTurnsPerSession, 1);
});

test('deriveConversationPatterns: 3 requests produces multi-turn session', () => {
    const analysis = emptyAnalysis();
    analysis.modeUsage.ask = 2;
    analysis.modeUsage.agent = 1;
    deriveConversationPatterns(analysis);
    assert.equal(analysis.conversationPatterns!.multiTurnSessions, 1);
    assert.equal(analysis.conversationPatterns!.singleTurnSessions, 0);
    assert.equal(analysis.conversationPatterns!.avgTurnsPerSession, 3);
    assert.equal(analysis.conversationPatterns!.maxTurnsInSession, 3);
});

// ---------------------------------------------------------------------------
// analyzeContentReferences
// ---------------------------------------------------------------------------

test('analyzeContentReferences: non-array input is ignored', () => {
    const refs = emptyRefs();
    analyzeContentReferences(null as any, refs);
    analyzeContentReferences('string' as any, refs);
    assert.equal(refs.file, 0);
    assert.equal(refs.symbol, 0);
});

test('analyzeContentReferences: empty array produces no counts', () => {
    const refs = emptyRefs();
    analyzeContentReferences([], refs);
    assert.equal(refs.file, 0);
    assert.deepEqual(refs.byKind, {});
});

test('analyzeContentReferences: tracks byKind for each entry', () => {
    const refs = emptyRefs();
    analyzeContentReferences([
        { kind: 'reference', reference: { fsPath: '/src/foo.ts' } },
        { kind: 'reference', reference: { fsPath: '/src/bar.ts' } },
    ], refs);
    assert.equal(refs.byKind['reference'], 2);
});

test('analyzeContentReferences: increments file for regular file reference', () => {
    const refs = emptyRefs();
    analyzeContentReferences([
        { kind: 'reference', reference: { fsPath: '/src/foo.ts' } },
    ], refs);
    assert.equal(refs.file, 1);
    assert.equal(refs.byPath['/src/foo.ts'], 1);
});

test('analyzeContentReferences: increments copilotInstructions for copilot-instructions.md', () => {
    const refs = emptyRefs();
    analyzeContentReferences([
        { kind: 'reference', reference: { fsPath: '/repo/.github/copilot-instructions.md' } },
    ], refs);
    assert.equal(refs.copilotInstructions, 1);
    assert.equal(refs.file, 0);
});

test('analyzeContentReferences: increments copilotInstructions for .instructions.md files', () => {
    const refs = emptyRefs();
    analyzeContentReferences([
        { kind: 'reference', reference: { fsPath: '/repo/.github/instructions/github-actions.instructions.md' } },
    ], refs);
    assert.equal(refs.copilotInstructions, 1);
    assert.equal(refs.file, 0);
});

test('analyzeContentReferences: increments agentsMd for agents.md', () => {
    const refs = emptyRefs();
    analyzeContentReferences([
        { kind: 'reference', reference: { fsPath: '/repo/agents.md' } },
    ], refs);
    assert.equal(refs.agentsMd, 1);
    assert.equal(refs.file, 0);
});

test('analyzeContentReferences: increments symbol for named reference without fsPath', () => {
    const refs = emptyRefs();
    analyzeContentReferences([
        { kind: 'reference', reference: { name: 'myFunction' } },
    ], refs);
    assert.equal(refs.symbol, 1);
    assert.equal(refs.byPath['#sym:myFunction'], 1);
});

test('analyzeContentReferences: handles inlineReference kind with fsPath', () => {
    const refs = emptyRefs();
    analyzeContentReferences([
        { kind: 'inlineReference', inlineReference: { fsPath: '/src/component.ts' } },
    ], refs);
    assert.equal(refs.file, 1);
});

test('analyzeContentReferences: increments pullRequest for pullRequest kind', () => {
    const refs = emptyRefs();
    analyzeContentReferences([
        { kind: 'pullRequest', pullRequest: { number: 42, title: 'My PR' } },
    ], refs);
    assert.equal(refs.pullRequest, 1);
    assert.equal(refs.byKind['pullRequest'], 1);
});

test('analyzeContentReferences: multiple pullRequest entries accumulate', () => {
    const refs = emptyRefs();
    analyzeContentReferences([
        { kind: 'pullRequest', pullRequest: { number: 1 } },
        { kind: 'pullRequest', pullRequest: { number: 2 } },
    ], refs);
    assert.equal(refs.pullRequest, 2);
});

// ---------------------------------------------------------------------------
// analyzeVariableData
// ---------------------------------------------------------------------------

test('analyzeVariableData: null input is ignored', () => {
    const refs = emptyRefs();
    analyzeVariableData(null, refs);
    assert.equal(refs.symbol, 0);
    assert.deepEqual(refs.byKind, {});
});

test('analyzeVariableData: non-array variables is ignored', () => {
    const refs = emptyRefs();
    analyzeVariableData({ variables: 'not-an-array' }, refs);
    assert.equal(refs.symbol, 0);
});

test('analyzeVariableData: tracks byKind for each variable', () => {
    const refs = emptyRefs();
    analyzeVariableData({
        variables: [
            { kind: 'file', name: 'foo.ts' },
            { kind: 'file', name: 'bar.ts' },
        ]
    }, refs);
    assert.equal(refs.byKind['file'], 2);
});

test('analyzeVariableData: file variables also increment refs.file', () => {
    const refs = emptyRefs();
    analyzeVariableData({
        variables: [
            { kind: 'file', name: 'foo.ts' },
            { kind: 'file', name: 'bar.ts' },
        ]
    }, refs);
    assert.equal(refs.file, 2);
});

test('analyzeVariableData: image variables increment byKind[image] and byKind[copilot.image]', () => {
    const refs = emptyRefs();
    analyzeVariableData({
        variables: [
            { kind: 'image' },
            { kind: 'image' },
        ]
    }, refs);
    assert.equal(refs.byKind['image'], 2);
    assert.equal(refs.byKind['copilot.image'], 2);
});

test('analyzeVariableData: increments symbol for generic sym: variables', () => {
    const refs = emptyRefs();
    analyzeVariableData({
        variables: [
            { kind: 'generic', name: 'sym:parseSessionFile' },
        ]
    }, refs);
    assert.equal(refs.symbol, 1);
    assert.equal(refs.byPath['#sym:parseSessionFile'], 1);
});

test('analyzeVariableData: does not increment symbol for generic without sym: prefix', () => {
    const refs = emptyRefs();
    analyzeVariableData({
        variables: [
            { kind: 'generic', name: 'someOtherThing' },
        ]
    }, refs);
    assert.equal(refs.symbol, 0);
});

// ---------------------------------------------------------------------------
// analyzeCliAttachments
// ---------------------------------------------------------------------------

test('analyzeCliAttachments: null/missing input is ignored', () => {
    const refs = emptyRefs();
    analyzeCliAttachments(null, refs);
    analyzeCliAttachments(undefined, refs);
    assert.equal(refs.file, 0);
    assert.deepEqual(refs.byKind, {});
});

test('analyzeCliAttachments: clipboard PNG increments copilot.image', () => {
    const refs = emptyRefs();
    analyzeCliAttachments([
        { displayName: 'bce9bcb7-35f8-49ba-a49d-a8114dd26214-clipboard.png', type: 'file' },
        { displayName: '3a695656-0157-4e9d-8613-781da1b54ee7-clipboard.png', type: 'file' },
    ], refs);
    assert.equal(refs.byKind['copilot.image'], 2);
    assert.equal(refs.file, 0);
});

test('analyzeCliAttachments: "N lines" displayName increments refs.file', () => {
    const refs = emptyRefs();
    analyzeCliAttachments([
        { displayName: '210 lines', type: 'file' },
        { displayName: '46 lines', type: 'file' },
    ], refs);
    assert.equal(refs.file, 2);
    assert.equal(refs.byKind['copilot.image'], undefined);
});

test('analyzeCliAttachments: named file (e.g. refactor.agent.md) increments refs.file', () => {
    const refs = emptyRefs();
    analyzeCliAttachments([
        { displayName: 'refactor.agent.md', type: 'file' },
    ], refs);
    assert.equal(refs.file, 1);
});

test('analyzeCliAttachments: mixed attachments (images + file refs) split correctly', () => {
    const refs = emptyRefs();
    analyzeCliAttachments([
        { displayName: 'abc-clipboard.png', type: 'file' },
        { displayName: '285 lines', type: 'file' },
        { displayName: 'AGENTS.md', type: 'file' },
    ], refs);
    assert.equal(refs.byKind['copilot.image'], 1);
    assert.equal(refs.file, 2);
});

test('analyzeCliAttachments: entry without displayName is skipped', () => {
    const refs = emptyRefs();
    analyzeCliAttachments([{ type: 'file' }, null, 42], refs);
    assert.equal(refs.file, 0);
    assert.deepEqual(refs.byKind, {});
});

// ---------------------------------------------------------------------------
// analyzeRequestContext
// ---------------------------------------------------------------------------

test('analyzeRequestContext: processes message.text for context refs', () => {
    const refs = emptyRefs();
    analyzeRequestContext({ message: { text: 'look at #file please' } }, refs);
    assert.equal(refs.file, 1);
});

test('analyzeRequestContext: processes message.parts for context refs', () => {
    const refs = emptyRefs();
    analyzeRequestContext({
        message: { parts: [{ text: 'check #codebase' }, { text: 'and #file' }] }
    }, refs);
    assert.equal(refs.codebase, 1);
    assert.equal(refs.file, 1);
});

test('analyzeRequestContext: extracts code context lines from dynamic parts', () => {
    const refs = emptyRefs();
    analyzeRequestContext({
        message: {
            parts: [{
                kind: 'dynamic',
                data: { range: { startLineNumber: 10, endLineNumber: 24 } },
            }]
        }
    }, refs);
    assert.equal(refs.codeContextLines, 15);
});

test('analyzeRequestContext: counts custom prompt parts in byKind', () => {
    const refs = emptyRefs();
    analyzeRequestContext({
        message: {
            parts: [{
                kind: 'prompt',
                slashPromptCommand: { command: 'galery' },
            }]
        }
    }, refs);
    assert.equal(refs.byKind['prompt'], 1);
});

test('analyzeRequestContext: processes contentReferences array', () => {
    const refs = emptyRefs();
    analyzeRequestContext({
        contentReferences: [
            { kind: 'reference', reference: { fsPath: '/src/utils.ts' } },
        ]
    }, refs);
    assert.equal(refs.file, 1);
});

test('analyzeRequestContext: processes variableData for symbol refs', () => {
    const refs = emptyRefs();
    analyzeRequestContext({
        variableData: {
            variables: [{ kind: 'generic', name: 'sym:myClass' }]
        }
    }, refs);
    assert.equal(refs.symbol, 1);
});

test('analyzeRequestContext: empty request produces no counts', () => {
    const refs = emptyRefs();
    analyzeRequestContext({}, refs);
    assert.equal(refs.file, 0);
    assert.equal(refs.symbol, 0);
});
