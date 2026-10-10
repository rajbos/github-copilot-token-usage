import test from 'node:test';
import * as assert from 'node:assert/strict';
import {
    isEditToolName,
    extractEditFilePath,
    computeEfficiencyFromTurns,
    jsonRequestToToolCalls,
    mergeModelEfficiency,
    applyModelUsageToEfficiency,
    deriveModelEfficiencyRates,
    createEmptyModelEfficiencyCounters,
    computeEfficiencyLowUsageThreshold,
    computeLongTailModels,
    computeModelTokenShares,
    accumulateDailyModelTokens,
    accumulateDailyModelCounters,
    findRoutedSessionModel,
    attributeRoutedModelUsage,
    buildSessionEfficiencyAttribution,
    accumulateDayAndEditorModelTokens,
    accumulateDayAndEditorModelCounters,
    mergeDailyModelEfficiency,
    type EfficiencyTurn,
    type SessionEfficiencyAttribution,
} from '../../../src/modelEfficiency';
import type { DailyModelEfficiency, DailyModelEfficiencyEntry, DailyTokenStats, ModelEfficiencyCounters, ModelEfficiencyUsage, ModelPricing, ModelUsage, SessionFileCache } from '../../../src/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function editCall(file: string, toolName = 'Edit'): { toolName: string; arguments?: string } {
    return { toolName, arguments: JSON.stringify({ file_path: file }) };
}

function turn(model: string | null, toolCalls: { toolName: string; arguments?: string }[]): EfficiencyTurn {
    return { model, toolCalls };
}

const PRICING: { [key: string]: ModelPricing } = {
    'gpt-4o': { inputCostPerMillion: 2.5, outputCostPerMillion: 10 },
    'claude-sonnet-4.5': { inputCostPerMillion: 3, outputCostPerMillion: 15, cachedInputCostPerMillion: 0.3 },
};

// ---------------------------------------------------------------------------
// isEditToolName / extractEditFilePath
// ---------------------------------------------------------------------------

test('isEditToolName: recognizes edit tools across editors', () => {
    // Claude Code, Copilot CLI, Copilot Chat, Cline, Gemini CLI, Kiro
    for (const name of ['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'edit', 'create', 'editFiles', 'apply_patch', 'replace_string_in_file', 'write_to_file', 'replace', 'fsWrite', 'strReplace']) {
        assert.equal(isEditToolName(name), true, `${name} should be an edit tool`);
    }
});

test('isEditToolName: rejects read-only and terminal tools', () => {
    for (const name of ['Read', 'Bash', 'Grep', 'Glob', 'runCommand', 'terminal', 'search', 'fetch_webpage', 'view']) {
        assert.equal(isEditToolName(name), false, `${name} should not be an edit tool`);
    }
});

test('extractEditFilePath: reads common path argument keys', () => {
    assert.equal(extractEditFilePath(JSON.stringify({ file_path: '/a/b.ts' })), '/a/b.ts');
    assert.equal(extractEditFilePath(JSON.stringify({ path: 'src/x.ts' })), 'src/x.ts');
    assert.equal(extractEditFilePath(JSON.stringify({ filePath: 'y.py' })), 'y.py');
    assert.equal(extractEditFilePath(JSON.stringify({ uri: { fsPath: 'C:\\z.cs' } })), 'C:\\z.cs');
    assert.equal(extractEditFilePath(JSON.stringify({ uri: { path: '/w.go' } })), '/w.go');
});

test('extractEditFilePath: returns null for missing/invalid arguments', () => {
    assert.equal(extractEditFilePath(undefined), null);
    assert.equal(extractEditFilePath('not-json'), null);
    assert.equal(extractEditFilePath(JSON.stringify({ old_str: 'x', new_str: 'y' })), null);
    assert.equal(extractEditFilePath(JSON.stringify('a-string')), null);
});

// ---------------------------------------------------------------------------
// computeEfficiencyFromTurns
// ---------------------------------------------------------------------------

test('computeEfficiencyFromTurns: one-shot edit turn counts as one-shot', () => {
    const eff = computeEfficiencyFromTurns([
        turn('gpt-4o', [{ toolName: 'Read' }, editCall('/a.ts'), editCall('/b.ts')]),
    ]);
    const c = eff['gpt-4o'];
    assert.equal(c.calls, 1);
    assert.equal(c.editTurns, 1);
    assert.equal(c.oneShotEditTurns, 1);
    assert.equal(c.retries, 0);
    assert.equal(c.selfCorrections, 0);
    assert.equal(c.editToolCalls, 2);
    assert.equal(c.toolCalls, 3);
});

test('computeEfficiencyFromTurns: consecutive same-file edits count as retries', () => {
    const eff = computeEfficiencyFromTurns([
        turn('gpt-4o', [editCall('/a.ts'), editCall('/a.ts'), editCall('/a.ts')]),
    ]);
    const c = eff['gpt-4o'];
    assert.equal(c.editTurns, 1);
    assert.equal(c.retries, 2);
    assert.equal(c.selfCorrections, 0);
    assert.equal(c.oneShotEditTurns, 0);
});

test('computeEfficiencyFromTurns: re-edit after another tool call is a self-correction', () => {
    const eff = computeEfficiencyFromTurns([
        turn('claude-sonnet-4.5', [editCall('/a.ts'), { toolName: 'Bash' }, editCall('/a.ts')]),
    ]);
    const c = eff['claude-sonnet-4.5'];
    assert.equal(c.editTurns, 1);
    assert.equal(c.retries, 0);
    assert.equal(c.selfCorrections, 1);
    assert.equal(c.oneShotEditTurns, 0);
});

test('computeEfficiencyFromTurns: edit of a different file between re-edits still self-corrects', () => {
    // a.ts edited, b.ts edited, back to a.ts: the a.ts re-edit is not adjacent → self-correction
    const eff = computeEfficiencyFromTurns([
        turn('gpt-4o', [editCall('/a.ts'), editCall('/b.ts'), editCall('/a.ts')]),
    ]);
    const c = eff['gpt-4o'];
    assert.equal(c.retries, 0);
    assert.equal(c.selfCorrections, 1);
});

test('computeEfficiencyFromTurns: edits without extractable paths never count as retries', () => {
    const eff = computeEfficiencyFromTurns([
        turn('gpt-4o', [{ toolName: 'Edit' }, { toolName: 'Edit' }, { toolName: 'Edit' }]),
    ]);
    const c = eff['gpt-4o'];
    assert.equal(c.editTurns, 1);
    assert.equal(c.editToolCalls, 3);
    assert.equal(c.retries, 0);
    assert.equal(c.selfCorrections, 0);
    assert.equal(c.oneShotEditTurns, 1);
});

test('computeEfficiencyFromTurns: attributes turns per model, null model becomes unknown', () => {
    const eff = computeEfficiencyFromTurns([
        turn('gpt-4o', []),
        turn('gpt-4o', [editCall('/a.ts')]),
        turn('claude-sonnet-4.5', []),
        turn(null, []),
    ]);
    assert.equal(eff['gpt-4o'].calls, 2);
    assert.equal(eff['gpt-4o'].editTurns, 1);
    assert.equal(eff['claude-sonnet-4.5'].calls, 1);
    assert.equal(eff['unknown'].calls, 1);
});

test('computeEfficiencyFromTurns: same file across different turns is not a retry', () => {
    const eff = computeEfficiencyFromTurns([
        turn('gpt-4o', [editCall('/a.ts')]),
        turn('gpt-4o', [editCall('/a.ts')]),
    ]);
    const c = eff['gpt-4o'];
    assert.equal(c.editTurns, 2);
    assert.equal(c.retries, 0);
    assert.equal(c.selfCorrections, 0);
    assert.equal(c.oneShotEditTurns, 2);
});

// ---------------------------------------------------------------------------
// jsonRequestToToolCalls (Copilot Chat JSON sessions)
// ---------------------------------------------------------------------------

test('jsonRequestToToolCalls: maps textEditGroup and tool invocations', () => {
    const calls = jsonRequestToToolCalls({
        response: [
            { kind: 'markdownContent' },
            { kind: 'textEditGroup', uri: { path: '/src/a.ts' } },
            { kind: 'toolInvocationSerialized' },
            { kind: 'textEditGroup', uri: { path: '/src/a.ts' } },
        ],
    });
    assert.equal(calls.length, 3);
    assert.equal(calls[0].toolName, 'edit');
    assert.equal(extractEditFilePath(calls[0].arguments), '/src/a.ts');
    assert.equal(calls[1].toolName, 'toolInvocation');
    // Feeding the sequence through the turn analyzer detects the self-correction
    const eff = computeEfficiencyFromTurns([{ model: 'gpt-4o', toolCalls: calls }]);
    assert.equal(eff['gpt-4o'].selfCorrections, 1);
    assert.equal(eff['gpt-4o'].retries, 0);
});

test('jsonRequestToToolCalls: handles missing response gracefully', () => {
    assert.deepEqual(jsonRequestToToolCalls({}), []);
    assert.deepEqual(jsonRequestToToolCalls({ response: undefined }), []);
});

// ---------------------------------------------------------------------------
// mergeModelEfficiency / applyModelUsageToEfficiency
// ---------------------------------------------------------------------------

test('mergeModelEfficiency: sums counters per model and creates missing entries', () => {
    const target: ModelEfficiencyUsage = {
        'gpt-4o': { ...createEmptyModelEfficiencyCounters(), calls: 2, toolCalls: 5, editTurns: 1, oneShotEditTurns: 1 },
    };
    mergeModelEfficiency(target, {
        'gpt-4o': { ...createEmptyModelEfficiencyCounters(), calls: 3, toolCalls: 7, editTurns: 2, retries: 1 },
        'claude-sonnet-4.5': { ...createEmptyModelEfficiencyCounters(), calls: 1, toolCalls: 2 },
    });
    assert.equal(target['gpt-4o'].calls, 5);
    assert.equal(target['gpt-4o'].toolCalls, 12);
    assert.equal(target['gpt-4o'].editTurns, 3);
    assert.equal(target['gpt-4o'].oneShotEditTurns, 1);
    assert.equal(target['gpt-4o'].retries, 1);
    assert.equal(target['claude-sonnet-4.5'].calls, 1);
});

test('mergeModelEfficiency: undefined source is a no-op', () => {
    const target: ModelEfficiencyUsage = {};
    mergeModelEfficiency(target, undefined);
    assert.deepEqual(target, {});
});

test('applyModelUsageToEfficiency: folds tokens and estimated cost into counters', () => {
    const eff: ModelEfficiencyUsage = {
        'gpt-4o': { ...createEmptyModelEfficiencyCounters(), calls: 4 },
    };
    applyModelUsageToEfficiency(eff, {
        'gpt-4o': { inputTokens: 1_000_000, outputTokens: 100_000, sessions: 0},
        'claude-sonnet-4.5': { inputTokens: 500_000, outputTokens: 50_000, cachedReadTokens: 400_000, sessions: 0},
    }, PRICING);

    assert.equal(eff['gpt-4o'].inputTokens, 1_000_000);
    assert.equal(eff['gpt-4o'].outputTokens, 100_000);
    // 1M input at $2.5/M + 100K output at $10/M = 2.5 + 1.0
    assert.ok(Math.abs(eff['gpt-4o'].cost - 3.5) < 1e-9);
    // Model without turn counters still gets a token-only entry
    assert.equal(eff['claude-sonnet-4.5'].calls, 0);
    assert.equal(eff['claude-sonnet-4.5'].cachedReadTokens, 400_000);
    assert.ok(eff['claude-sonnet-4.5'].cost > 0);
});

// ---------------------------------------------------------------------------
// deriveModelEfficiencyRates
// ---------------------------------------------------------------------------

test('deriveModelEfficiencyRates: computes all rates from counters', () => {
    const rates = deriveModelEfficiencyRates({
        calls: 10, editTurns: 4, oneShotEditTurns: 3, retries: 2, selfCorrections: 1,
        toolCalls: 25, editToolCalls: 7, inputTokens: 1000, outputTokens: 500, cachedReadTokens: 800, cost: 2,
    });
    assert.equal(rates.oneShotRate, 0.75);
    assert.equal(rates.retryRate, 0.5);
    assert.equal(rates.selfCorrectionRate, 0.25);
    assert.equal(rates.costPerCall, 0.2);
    assert.equal(rates.costPerEdit, 0.5);
    assert.equal(rates.outputTokensPerCall, 50);
    assert.equal(rates.toolCallsPerCall, 2.5);
    assert.equal(rates.cacheHitRate, 0.8);
});

test('deriveModelEfficiencyRates: zero denominators produce nulls', () => {
    const rates = deriveModelEfficiencyRates(createEmptyModelEfficiencyCounters());
    assert.equal(rates.oneShotRate, null);
    assert.equal(rates.retryRate, null);
    assert.equal(rates.selfCorrectionRate, null);
    assert.equal(rates.costPerCall, null);
    assert.equal(rates.costPerEdit, null);
    assert.equal(rates.outputTokensPerCall, null);
    assert.equal(rates.toolCallsPerCall, null);
    assert.equal(rates.cacheHitRate, null);
});

test('deriveModelEfficiencyRates: cacheHitRate is capped at 1.0 when cachedReadTokens > inputTokens', () => {
    // Some providers (e.g. DeepSeek) report cachedReadTokens > inputTokens; cap at 100%.
    const rates = deriveModelEfficiencyRates({
        calls: 5, editTurns: 0, oneShotEditTurns: 0, retries: 0, selfCorrections: 0,
        toolCalls: 0, editToolCalls: 0, inputTokens: 100, outputTokens: 200, cachedReadTokens: 3000, cost: 0,
    });
    assert.equal(rates.cacheHitRate, 1);
});

// ---------------------------------------------------------------------------
// computeEfficiencyLowUsageThreshold
// ---------------------------------------------------------------------------

test('computeEfficiencyLowUsageThreshold: returns null for fewer than 4 models', () => {
    const usage: ModelEfficiencyUsage = {
        a: { ...createEmptyModelEfficiencyCounters(), calls: 100 },
        b: { ...createEmptyModelEfficiencyCounters(), calls: 50 },
        c: { ...createEmptyModelEfficiencyCounters(), calls: 10 },
    };
    assert.equal(computeEfficiencyLowUsageThreshold(usage), null);
});

test('computeEfficiencyLowUsageThreshold: returns Q1 (25th-percentile) turn count', () => {
    // 4 models sorted by calls: 1, 5, 20, 100 → index floor(3 * 0.25) = 0 → value 1
    const usage: ModelEfficiencyUsage = {
        a: { ...createEmptyModelEfficiencyCounters(), calls: 100 },
        b: { ...createEmptyModelEfficiencyCounters(), calls: 20 },
        c: { ...createEmptyModelEfficiencyCounters(), calls: 5 },
        d: { ...createEmptyModelEfficiencyCounters(), calls: 1 },
    };
    assert.equal(computeEfficiencyLowUsageThreshold(usage), 1);
});

test('computeEfficiencyLowUsageThreshold: correctly identifies Q1 across larger dataset', () => {
    // 8 models sorted: 1, 2, 3, 5, 10, 20, 50, 100 → index floor(7 * 0.25) = 1 → value 2
    const usage: ModelEfficiencyUsage = {};
    [100, 50, 20, 10, 5, 3, 2, 1].forEach((calls, i) => {
        usage[`model-${i}`] = { ...createEmptyModelEfficiencyCounters(), calls };
    });
    assert.equal(computeEfficiencyLowUsageThreshold(usage), 2);
});

// ---------------------------------------------------------------------------
// computeLongTailModels
// ---------------------------------------------------------------------------

function usageWithCalls(counts: Record<string, number>): ModelEfficiencyUsage {
    const usage: ModelEfficiencyUsage = {};
    for (const [model, calls] of Object.entries(counts)) {
        usage[model] = { ...createEmptyModelEfficiencyCounters(), calls };
    }
    return usage;
}

test('computeLongTailModels: groups everything after the steepest proportional drop', () => {
    // Mirrors a real "Most used models locally" table: a clear cliff between the 4th (82 calls)
    // and 5th (20 calls) model, with only gentle tapering elsewhere.
    const usage = usageWithCalls({
        kimi: 309, sol: 144, sonnet5: 120, opus5: 82,
        unknown: 20, hydrafusion: 16, mistralMedium: 14, sonnet46: 12, terra: 12, maiCode: 11,
        synthetic: 3, gpt54: 3, devstral: 3, fable5: 2, mistral2: 2, auto: 1, mistralMedium2: 1, codestral: 1,
    });
    const longTail = computeLongTailModels(usage);
    assert.deepEqual(
        [...longTail].sort(),
        ['auto', 'codestral', 'devstral', 'fable5', 'gpt54', 'hydrafusion', 'maiCode', 'mistral2', 'mistralMedium', 'mistralMedium2', 'sonnet46', 'synthetic', 'terra', 'unknown'].sort(),
    );
    assert.ok(!longTail.has('opus5'), 'the model just before the cliff must stay in the main list');
    assert.ok(!longTail.has('kimi'), 'top models must stay in the main list');
});

test('computeLongTailModels: returns an empty set when usage tapers off gradually', () => {
    const usage = usageWithCalls({ a: 100, b: 80, c: 65, d: 55, e: 48 });
    assert.equal(computeLongTailModels(usage).size, 0);
});

test('computeLongTailModels: returns an empty set when the resulting tail would have fewer than two models', () => {
    // Steep drop exists (100 → 5), but only one model would land in the tail.
    const usage = usageWithCalls({ a: 100, b: 5 });
    assert.equal(computeLongTailModels(usage).size, 0);
});

test('computeLongTailModels: a clear cliff among just three models still produces a two-model tail', () => {
    const usage = usageWithCalls({ a: 100, b: 3, c: 1 });
    assert.deepEqual([...computeLongTailModels(usage)].sort(), ['b', 'c']);
});

test('computeLongTailModels: ignores zero-call models when scanning for the cliff', () => {
    const usage = usageWithCalls({ a: 100, b: 40, c: 0, d: 0 });
    const longTail = computeLongTailModels(usage);
    assert.deepEqual([...longTail].sort(), ['c', 'd']);
});

// ---------------------------------------------------------------------------
// Daily (time-sliceable) per-model efficiency
// ---------------------------------------------------------------------------

function counters(overrides: Partial<ModelEfficiencyCounters>): ModelEfficiencyCounters {
    return { ...createEmptyModelEfficiencyCounters(), ...overrides };
}

test('computeModelTokenShares: splits by token share and normalizes to 1', () => {
    const shares = computeModelTokenShares({
        modelUsage: {
            'kimi-k3': { inputTokens: 700, outputTokens: 100, sessions: 1 },
            'gpt-5.5': { inputTokens: 150, outputTokens: 50, sessions: 1 },
        },
    });
    assert.equal(shares.get('kimi-k3'), 0.8);
    assert.equal(shares.get('gpt-5.5'), 0.2);
});

test('computeModelTokenShares: falls back to efficiency token counters when modelUsage is empty', () => {
    const shares = computeModelTokenShares({
        modelUsage: {},
        modelEfficiency: {
            a: counters({ inputTokens: 300, outputTokens: 0 }),
            b: counters({ inputTokens: 100, outputTokens: 0 }),
        },
    });
    assert.equal(shares.get('a'), 0.75);
    assert.equal(shares.get('b'), 0.25);
});

test('computeModelTokenShares: splits equally when no token data exists at all', () => {
    const shares = computeModelTokenShares({
        modelEfficiency: { a: counters({ calls: 3 }), b: counters({ calls: 1 }) },
    });
    assert.equal(shares.get('a'), 0.5);
    assert.equal(shares.get('b'), 0.5);
});

test('computeModelTokenShares: returns an empty map when the session names no model', () => {
    assert.equal(computeModelTokenShares({ modelUsage: {}, modelEfficiency: {} }).size, 0);
});

test('accumulateDailyModelCounters: splits duration and LOC by token share, summing back to the session total', () => {
    const daily: DailyModelEfficiency = {};
    accumulateDailyModelCounters(daily, {
        modelUsage: {
            'kimi-k3': { inputTokens: 700, outputTokens: 100, sessions: 1 },
            'gpt-5.5': { inputTokens: 150, outputTokens: 50, sessions: 1 },
        },
        modelEfficiency: {
            'kimi-k3': counters({ calls: 8, toolCalls: 42, editTurns: 5, retries: 2, oneShotEditTurns: 3 }),
            'gpt-5.5': counters({ calls: 2, toolCalls: 6, editTurns: 1, oneShotEditTurns: 1 }),
        },
        activeDurationMs: 600_000,
        linesAdded: 100,
        linesRemoved: 50,
        applies: 10,
        codeBlocks: 20,
    });

    // Turn counters are exact per model — never split.
    assert.equal(daily['kimi-k3'].editTurns, 5);
    assert.equal(daily['kimi-k3'].toolCalls, 42);
    assert.equal(daily['kimi-k3'].retries, 2);
    assert.equal(daily['gpt-5.5'].editTurns, 1);

    // Session-level signals are split 80/20 by token share.
    assert.equal(daily['kimi-k3'].activeDurationMs, 480_000);
    assert.equal(daily['gpt-5.5'].activeDurationMs, 120_000);
    assert.equal(daily['kimi-k3'].linesAdded, 80);
    assert.equal(daily['gpt-5.5'].linesAdded, 20);
    assert.equal(daily['kimi-k3'].codeBlocks, 16);

    // The split is lossless: the parts sum back to the session totals.
    const sum = (pick: (e: DailyModelEfficiencyEntry) => number): number =>
        Object.values(daily).reduce((acc, e) => acc + pick(e), 0);
    assert.equal(sum(e => e.activeDurationMs), 600_000);
    assert.equal(sum(e => e.linesAdded), 100);
    assert.equal(sum(e => e.linesRemoved), 50);
    assert.equal(sum(e => e.applies), 10);
    assert.equal(sum(e => e.codeBlocks), 20);
    // One session split across two models is exactly one session equivalent.
    assert.equal(sum(e => e.sessionShare), 1);
});

test('accumulateDailyModelCounters: a single-model session attributes everything to that model', () => {
    const daily: DailyModelEfficiency = {};
    accumulateDailyModelCounters(daily, {
        modelUsage: { 'kimi-k3': { inputTokens: 1000, outputTokens: 200, sessions: 1 } },
        modelEfficiency: { 'kimi-k3': counters({ calls: 4, editTurns: 3 }) },
        activeDurationMs: 300_000,
        linesAdded: 42,
    });
    assert.equal(daily['kimi-k3'].sessionShare, 1);
    assert.equal(daily['kimi-k3'].activeDurationMs, 300_000);
    assert.equal(daily['kimi-k3'].linesAdded, 42);
    assert.equal(daily['kimi-k3'].durationSessionShare, 1);
});

test('accumulateDailyModelCounters: sessions without duration do not inflate the duration denominator', () => {
    const daily: DailyModelEfficiency = {};
    const input = { modelUsage: { a: { inputTokens: 100, outputTokens: 0, sessions: 1 } }, modelEfficiency: { a: counters({ calls: 1 }) } };
    accumulateDailyModelCounters(daily, { ...input, activeDurationMs: 60_000 });
    accumulateDailyModelCounters(daily, input); // no duration data
    assert.equal(daily['a'].sessionShare, 2);
    assert.equal(daily['a'].durationSessionShare, 1);
    assert.equal(daily['a'].activeDurationMs, 60_000);
});

test('accumulateDailyModelTokens: adds per-day tokens, cost and session counts', () => {
    const pricing: { [k: string]: ModelPricing } = {
        'kimi-k3': { inputCostPerMillion: 1, outputCostPerMillion: 2 } as ModelPricing,
    };
    const daily: DailyModelEfficiency = {};
    accumulateDailyModelTokens(daily, { 'kimi-k3': { inputTokens: 1_000_000, outputTokens: 1_000_000, sessions: 1 } }, pricing);
    accumulateDailyModelTokens(daily, { 'kimi-k3': { inputTokens: 1_000_000, outputTokens: 0, sessions: 1 } }, pricing);
    assert.equal(daily['kimi-k3'].inputTokens, 2_000_000);
    assert.equal(daily['kimi-k3'].outputTokens, 1_000_000);
    assert.equal(daily['kimi-k3'].sessions, 2);
    assert.equal(daily['kimi-k3'].cost, 4); // (1 + 2) + 1
});

test('mergeDailyModelEfficiency: sums every field when rolling days into a window', () => {
    const a: DailyModelEfficiency = {};
    const b: DailyModelEfficiency = {};
    const input = {
        modelUsage: { m: { inputTokens: 100, outputTokens: 0, sessions: 1 } },
        modelEfficiency: { m: counters({ calls: 2, toolCalls: 7, editTurns: 1, retries: 1 }) },
        activeDurationMs: 1000, linesAdded: 10, applies: 2, codeBlocks: 4,
    };
    accumulateDailyModelCounters(a, input);
    accumulateDailyModelCounters(b, input);
    mergeDailyModelEfficiency(a, b);
    assert.equal(a['m'].calls, 4);
    assert.equal(a['m'].toolCalls, 14);
    assert.equal(a['m'].retries, 2);
    assert.equal(a['m'].sessionShare, 2);
    assert.equal(a['m'].activeDurationMs, 2000);
    assert.equal(a['m'].linesAdded, 20);
    assert.equal(a['m'].codeBlocks, 8);
});

test('mergeDailyModelEfficiency: tolerates an undefined source', () => {
    const target: DailyModelEfficiency = {};
    mergeDailyModelEfficiency(target, undefined);
    assert.deepEqual(target, {});
});

// ── Day + per-editor accumulation (issue #1965) ──────────────────────────────

function emptyDay(date = '2026-07-13'): DailyTokenStats {
	return { date, tokens: 0, sessions: 0, interactions: 0, modelUsage: {}, editorUsage: {}, repositoryUsage: {} };
}

/** Sums one model's counters across every editor slice of a day. */
function mergedEditorSlices(entry: DailyTokenStats): DailyModelEfficiency {
	const merged: DailyModelEfficiency = {};
	for (const slice of Object.values(entry.editorModelEfficiency ?? {})) { mergeDailyModelEfficiency(merged, slice); }
	return merged;
}

test('accumulateDayAndEditorModelTokens: the editor slices merge back to the day total', () => {
	const entry = emptyDay();
	accumulateDayAndEditorModelTokens(entry, 'VS Code', { 'gpt-5': { inputTokens: 600, outputTokens: 120, sessions: 1 } }, {});
	accumulateDayAndEditorModelTokens(entry, 'Claude Code', { 'gpt-5': { inputTokens: 400, outputTokens: 80, sessions: 1 } }, {});

	assert.equal(entry.modelEfficiency!['gpt-5'].inputTokens, 1000);
	assert.deepEqual(mergedEditorSlices(entry)['gpt-5'], entry.modelEfficiency!['gpt-5']);
});

test('accumulateDayAndEditorModelCounters: a mixed-model session lands in both the day and its editor', () => {
	const entry = emptyDay();
	const attribution: SessionEfficiencyAttribution = {
		modelEfficiency: {
			'gpt-5': { ...createEmptyModelEfficiencyCounters(), calls: 4, editTurns: 3, retries: 1 },
			'claude-sonnet-4-5': { ...createEmptyModelEfficiencyCounters(), calls: 2, editTurns: 2 },
		},
		modelUsage: {
			'gpt-5': { inputTokens: 600, outputTokens: 0, sessions: 1 },
			'claude-sonnet-4-5': { inputTokens: 400, outputTokens: 0, sessions: 1 },
		},
		activeDurationMs: 600_000,
		linesAdded: 50,
		linesRemoved: 10,
		applies: 4,
		codeBlocks: 8,
	};
	accumulateDayAndEditorModelCounters(entry, 'VS Code', attribution);

	// Both models are attributed, and the editor slice is identical to the day.
	for (const model of ['gpt-5', 'claude-sonnet-4-5']) {
		assert.deepEqual(mergedEditorSlices(entry)[model], entry.modelEfficiency![model], model);
	}
	// A 2-model session contributes 1.0 session equivalent in total, not 2 —
	// the double-counting guard the editor filter depends on.
	const shareTotal = Object.values(entry.modelEfficiency!).reduce((s, e) => s + e.sessionShare, 0);
	assert.ok(Math.abs(shareTotal - 1) < 1e-9, `sessionShare should total 1, got ${shareTotal}`);
});

test('accumulateDayAndEditorModelCounters: several editors on one day stay separable and conserved', () => {
	const entry = emptyDay();
	const session = (calls: number, tokens: number): SessionEfficiencyAttribution => ({
		modelEfficiency: { 'gpt-5': { ...createEmptyModelEfficiencyCounters(), calls, editTurns: calls } },
		modelUsage: { 'gpt-5': { inputTokens: tokens, outputTokens: 0, sessions: 1 } },
		activeDurationMs: 0, linesAdded: 0, linesRemoved: 0, applies: 0, codeBlocks: 0,
	});
	accumulateDayAndEditorModelCounters(entry, 'VS Code', session(3, 300));
	accumulateDayAndEditorModelCounters(entry, 'Claude Code', session(5, 500));

	assert.equal(entry.editorModelEfficiency!['VS Code']['gpt-5'].calls, 3);
	assert.equal(entry.editorModelEfficiency!['Claude Code']['gpt-5'].calls, 5);
	assert.equal(entry.modelEfficiency!['gpt-5'].calls, 8);
	assert.deepEqual(mergedEditorSlices(entry)['gpt-5'], entry.modelEfficiency!['gpt-5']);
});

// A session log arrives as parsed JSON, and `JSON.parse` creates `__proto__` as
// a real own property (an object *literal* would set the prototype instead and
// never reach the guard at all — such a test cannot fail).
function parsedModelUsage(model: string): ModelUsage {
	return JSON.parse(`{"${model}": {"inputTokens": 500, "outputTokens": 100, "sessions": 1}}`);
}

test('accumulateDayAndEditorModelTokens: a prototype-polluting model id is dropped, not written to Object.prototype', () => {
	const entry = emptyDay();
	const usage = parsedModelUsage('__proto__');
	assert.ok(Object.prototype.hasOwnProperty.call(usage, '__proto__'), 'fixture must carry a real own __proto__ key');

	accumulateDayAndEditorModelTokens(entry, 'VS Code', usage, {});
	accumulateDayAndEditorModelTokens(entry, 'VS Code', parsedModelUsage('constructor'), {});

	// Unguarded, `target['__proto__']` returns Object.prototype and the counter
	// writes land on it, poisoning every object in the process.
	assert.equal((({}) as Record<string, unknown>).inputTokens, undefined, 'Object.prototype must not gain counters');
	assert.equal(Object.prototype.hasOwnProperty.call(entry.modelEfficiency ?? {}, '__proto__'), false);
	assert.equal(Object.prototype.hasOwnProperty.call(entry.modelEfficiency ?? {}, 'constructor'), false);
});

test('accumulateDayAndEditorModelCounters: a prototype-polluting model id is dropped from both the day and the editor slice', () => {
	const entry = emptyDay();
	const efficiency: ModelEfficiencyUsage = JSON.parse('{"__proto__": {"calls": 3, "toolCalls": 0, "editTurns": 2, "oneShotEditTurns": 0, "retries": 0, "selfCorrections": 0, "inputTokens": 100, "outputTokens": 0, "cachedReadTokens": 0, "cacheCreationTokens": 0, "cost": 0}}');
	assert.ok(Object.prototype.hasOwnProperty.call(efficiency, '__proto__'), 'fixture must carry a real own __proto__ key');

	accumulateDayAndEditorModelCounters(entry, 'VS Code', {
		modelEfficiency: efficiency,
		modelUsage: parsedModelUsage('__proto__'),
		activeDurationMs: 1000, linesAdded: 1, linesRemoved: 0, applies: 0, codeBlocks: 0,
	});

	assert.equal((({}) as Record<string, unknown>).calls, undefined, 'Object.prototype must not gain counters');
	assert.equal(Object.prototype.hasOwnProperty.call(entry.modelEfficiency ?? {}, '__proto__'), false);
	assert.equal(Object.prototype.hasOwnProperty.call(entry.editorModelEfficiency?.['VS Code'] ?? {}, '__proto__'), false);
});

// ── Routed sessions: hydrafusion / auto (Copilot CLI) ─────────────────────────
//
// The CLI keys a routed session's turn counters by the id the user picked
// (`hydrafusion`, `auto`) but its shutdown token metrics by the real models
// that served each leg. Both halves have to land on one key for the router to
// be comparable — and for the real models not to be charged for turns they
// never ran under their own name.

const ROUTED_USAGE: ModelUsage = {
    'gpt-5.6-sol': { inputTokens: 800, outputTokens: 100, cachedReadTokens: 300, sessions: 1 },
    'claude-opus-5': { inputTokens: 200, outputTokens: 100, sessions: 1 },
};
const ROUTED_PRICING: { [k: string]: ModelPricing } = {
    'gpt-5.6-sol': { inputCostPerMillion: 1, outputCostPerMillion: 2 } as ModelPricing,
    'claude-opus-5': { inputCostPerMillion: 10, outputCostPerMillion: 20 } as ModelPricing,
};

test('findRoutedSessionModel: detects a router whose turns ran on other models', () => {
    assert.equal(findRoutedSessionModel(ROUTED_USAGE, { hydrafusion: counters({ calls: 3 }) }), 'hydrafusion');
    assert.equal(findRoutedSessionModel(ROUTED_USAGE, { auto: counters({ calls: 3 }) }), 'auto');
});

test('findRoutedSessionModel: a session whose usage is already keyed by the router is not routed', () => {
    // VS Code Chat records Auto under `auto` on both sides — nothing to re-key.
    const usage: ModelUsage = { auto: { inputTokens: 100, outputTokens: 10, sessions: 1 } };
    assert.equal(findRoutedSessionModel(usage, { auto: counters({ calls: 1 }) }), undefined);
});

test('findRoutedSessionModel: turns under both routers cannot be partitioned, so nothing is re-keyed', () => {
    // A CLI session can switch hydrafusion -> auto; the shutdown metrics are one
    // pool, so crediting either router with all of it would be wrong.
    const both = { hydrafusion: counters({ calls: 2 }), auto: counters({ calls: 1 }) };
    assert.equal(findRoutedSessionModel(ROUTED_USAGE, both), undefined);
    assert.equal(attributeRoutedModelUsage(ROUTED_USAGE, both), ROUTED_USAGE);
    const daily: DailyModelEfficiency = {};
    accumulateDailyModelTokens(daily, ROUTED_USAGE, ROUTED_PRICING, both);
    assert.deepEqual(Object.keys(daily).sort(), ['claude-opus-5', 'gpt-5.6-sol']);
});

test('findRoutedSessionModel: a Kiro CLI session keyed `auto` on both sides is not routed', () => {
    const usage: ModelUsage = { auto: { inputTokens: 500, outputTokens: 50, sessions: 1 } };
    assert.equal(findRoutedSessionModel(usage, { auto: counters({ calls: 4 }) }), undefined);
});

test('findRoutedSessionModel: plain sessions and missing inputs are not routed', () => {
    assert.equal(findRoutedSessionModel(ROUTED_USAGE, { 'gpt-5.6-sol': counters({ calls: 1 }) }), undefined);
    assert.equal(findRoutedSessionModel(undefined, undefined), undefined);
    assert.equal(findRoutedSessionModel(ROUTED_USAGE, undefined), undefined);
});

test('attributeRoutedModelUsage: folds the real models onto the router without mutating the input', () => {
    const before = JSON.stringify(ROUTED_USAGE);
    const out = attributeRoutedModelUsage(ROUTED_USAGE, { hydrafusion: counters({ calls: 3, editTurns: 2 }) });
    assert.deepEqual(out, {
        hydrafusion: { inputTokens: 1000, outputTokens: 200, cachedReadTokens: 300, sessions: 1 },
    });
    assert.equal(JSON.stringify(ROUTED_USAGE), before);
});

test('attributeRoutedModelUsage: sums every token counter, including cache writes and thinking', () => {
    const usage: ModelUsage = {
        a: { inputTokens: 10, outputTokens: 1, cachedReadTokens: 2, cacheCreationTokens: 3, cacheCreation1hTokens: 1, thinkingTokens: 4, sessions: 1 },
        b: { inputTokens: 20, outputTokens: 2, cachedReadTokens: 4, cacheCreationTokens: 6, cacheCreation1hTokens: 2, thinkingTokens: 8, sessions: 1 },
    };
    assert.deepEqual(attributeRoutedModelUsage(usage, { hydrafusion: counters({ calls: 1 }) }), {
        hydrafusion: { inputTokens: 30, outputTokens: 3, cachedReadTokens: 6, cacheCreationTokens: 9, cacheCreation1hTokens: 3, thinkingTokens: 12, sessions: 1 },
    });
});

test('attributeRoutedModelUsage: a model also picked by name keeps its own usage', () => {
    // The user ran part of the session on claude-opus-5 directly, then switched
    // to hydrafusion: opus's usage stays its own, the other leg models fold.
    const out = attributeRoutedModelUsage(ROUTED_USAGE, {
        hydrafusion: counters({ calls: 2 }),
        'claude-opus-5': counters({ calls: 1 }),
    });
    assert.deepEqual(Object.keys(out ?? {}).sort(), ['claude-opus-5', 'hydrafusion']);
    assert.equal(out?.['hydrafusion'].inputTokens, 800);
    assert.equal(out?.['claude-opus-5'].inputTokens, 200);
});

test('attributeRoutedModelUsage: returns the input untouched for an unrouted session', () => {
    assert.equal(attributeRoutedModelUsage(ROUTED_USAGE, { 'gpt-5.6-sol': counters({ calls: 1 }) }), ROUTED_USAGE);
    assert.equal(attributeRoutedModelUsage(undefined, { hydrafusion: counters({ calls: 1 }) }), undefined);
});

test('accumulateDailyModelTokens: a routed session lands on the router, priced at each real model\'s rate', () => {
    const daily: DailyModelEfficiency = {};
    accumulateDailyModelTokens(daily, ROUTED_USAGE, ROUTED_PRICING, { hydrafusion: counters({ calls: 3, editTurns: 2 }) });
    assert.deepEqual(Object.keys(daily), ['hydrafusion']);
    assert.equal(daily['hydrafusion'].inputTokens, 1000);
    assert.equal(daily['hydrafusion'].outputTokens, 200);
    assert.equal(daily['hydrafusion'].cachedReadTokens, 300);
    // One session, not one per real model the router spread it over.
    assert.equal(daily['hydrafusion'].sessions, 1);
    // sol: 800e-6*1 + 100e-6*2 = 0.001; opus: 200e-6*10 + 100e-6*20 = 0.004
    assert.ok(Math.abs(daily['hydrafusion'].cost - 0.005) < 1e-9, `cost ${daily['hydrafusion'].cost}`);
});

test('accumulateDailyModelTokens: `auto` is re-keyed the same way as hydrafusion', () => {
    const daily: DailyModelEfficiency = {};
    accumulateDailyModelTokens(daily, ROUTED_USAGE, ROUTED_PRICING, { auto: counters({ calls: 1 }) });
    assert.deepEqual(Object.keys(daily), ['auto']);
    assert.equal(daily['auto'].sessions, 1);
});

test('accumulateDailyModelTokens: without turn counters nothing is re-keyed', () => {
    const daily: DailyModelEfficiency = {};
    accumulateDailyModelTokens(daily, ROUTED_USAGE, ROUTED_PRICING);
    assert.deepEqual(Object.keys(daily).sort(), ['claude-opus-5', 'gpt-5.6-sol']);
});

test('accumulateDailyModelCounters: a routed session\'s session share and LOC follow its turn counters', () => {
    const daily: DailyModelEfficiency = {};
    const input: SessionEfficiencyAttribution = {
        modelUsage: attributeRoutedModelUsage(ROUTED_USAGE, { hydrafusion: counters({ calls: 3, editTurns: 2, oneShotEditTurns: 1 }) }),
        modelEfficiency: { hydrafusion: counters({ calls: 3, editTurns: 2, oneShotEditTurns: 1 }) },
        activeDurationMs: 120_000, linesAdded: 40, linesRemoved: 10, applies: 0, codeBlocks: 0,
    };
    accumulateDailyModelCounters(daily, input);
    assert.deepEqual(Object.keys(daily), ['hydrafusion']);
    assert.equal(daily['hydrafusion'].sessionShare, 1);
    assert.equal(daily['hydrafusion'].editTurns, 2);
    assert.equal(daily['hydrafusion'].activeDurationMs, 120_000);
    assert.equal(daily['hydrafusion'].linesAdded, 40);
});

test('buildSessionEfficiencyAttribution: re-keys a routed session cache entry', () => {
    const attribution = buildSessionEfficiencyAttribution({
        modelUsage: ROUTED_USAGE,
        usageAnalysis: { modelEfficiency: { hydrafusion: counters({ calls: 2 }) } },
    } as unknown as SessionFileCache);
    assert.deepEqual(Object.keys(attribution.modelUsage ?? {}), ['hydrafusion']);
    assert.equal(attribution.modelUsage?.['hydrafusion'].inputTokens, 1000);
});

test('accumulateDayAndEditorModelTokens: a routed session is re-keyed in both the day total and the editor slice', () => {
    const entry = emptyDay();
    accumulateDayAndEditorModelTokens(entry, 'Copilot CLI', ROUTED_USAGE, ROUTED_PRICING, { hydrafusion: counters({ calls: 1 }) });
    assert.deepEqual(Object.keys(entry.modelEfficiency ?? {}), ['hydrafusion']);
    assert.deepEqual(Object.keys(entry.editorModelEfficiency?.['Copilot CLI'] ?? {}), ['hydrafusion']);
    assert.deepEqual(mergedEditorSlices(entry), entry.modelEfficiency);
});
