import test from 'node:test';
import * as assert from 'node:assert/strict';
import {
	compareInstructionCohorts,
	computeReworkRates,
	isInstructionFile,
	median,
	mergeKnowledgeFiles,
	summarizeInstructionFiles,
	MIN_REPO_TURN_DETAIL_SESSIONS,
} from '../../../src/knowledgeSignals';
import { repoRow, totals } from './agenticFixtures';

test('computeReworkRates: rates use the turn-detail and edit-turn denominators', () => {
	const rates = computeReworkRates(totals({
		sessions: 50, sessionsWithTurnDetail: 10, correctionMoments: 5, sessionsWithCorrections: 4,
		editTurns: 20, oneShotEditTurns: 15, retries: 2, toolErrors: 3, toolCalls: 60,
	}));
	assert.equal(rates.correctionsPerSession, 0.5);
	assert.equal(rates.correctedSessionShare, 0.4);
	assert.equal(rates.oneShotRate, 0.75);
	assert.equal(rates.retriesPerEditTurn, 0.1);
	assert.equal(rates.toolErrorsPerSession, 0.3);
	assert.equal(rates.toolCallsPerEditTurn, 3);
});

test('computeReworkRates: zero denominators give null, never 0 or NaN', () => {
	const rates = computeReworkRates(totals({ sessions: 5 }));
	assert.equal(rates.correctionsPerSession, null);
	assert.equal(rates.oneShotRate, null);
	assert.equal(rates.toolCallsPerEditTurn, null);
});

test('isInstructionFile: instruction types and well-known basenames', () => {
	assert.equal(isInstructionFile({ type: 'instructions', relativePath: '.github/copilot-instructions.md' }), true);
	assert.equal(isInstructionFile({ type: 'non-copilot-instructions', relativePath: 'GEMINI.md' }), true);
	assert.equal(isInstructionFile({ type: 'agent', relativePath: 'docs/AGENTS.md' }), true);
	assert.equal(isInstructionFile({ type: 'agent', relativePath: 'CLAUDE.md' }), true);
	assert.equal(isInstructionFile({ type: 'agent', relativePath: '.github/agents/review.agent.md' }), false);
	assert.equal(isInstructionFile({ type: 'mcp-config', relativePath: '.vscode/mcp.json' }), false);
});

test('summarizeInstructionFiles: counts instruction files and stale ones', () => {
	assert.deepEqual(summarizeInstructionFiles([
		{ type: 'instructions', relativePath: '.github/copilot-instructions.md', isStale: true },
		{ type: 'agent', relativePath: 'AGENTS.md', isStale: false },
		{ type: 'skill', relativePath: '.github/skills/x/SKILL.md', isStale: true },
	]), { instructionFiles: 2, staleInstructionFiles: 1 });
	assert.deepEqual(summarizeInstructionFiles([]), { instructionFiles: 0, staleInstructionFiles: 0 });
});

test('mergeKnowledgeFiles: keeps the richer scan of the same repository', () => {
	const none = { instructionFiles: 0, staleInstructionFiles: 0 };
	const some = { instructionFiles: 2, staleInstructionFiles: 0 };
	assert.deepEqual(mergeKnowledgeFiles(undefined, none), none);
	assert.deepEqual(mergeKnowledgeFiles(none, some), some);
	assert.deepEqual(mergeKnowledgeFiles(some, none), some);
});

test('median: odd, even and empty', () => {
	assert.equal(median([3, 1, 2]), 2);
	assert.equal(median([4, 1, 2, 3]), 2.5);
	assert.equal(median([]), null);
});

function repo(name: string, instructionFiles: number | undefined, sessionsWithTurnDetail: number, correctionMoments: number) {
	return repoRow(name, {
		sessions: sessionsWithTurnDetail, sessionsWithTurnDetail, correctionMoments,
		editTurns: 10, oneShotEditTurns: 8,
		knowledge: instructionFiles === undefined ? undefined : { instructionFiles, staleInstructionFiles: 0 },
	});
}

test('compareInstructionCohorts: qualifies with enough repos and sessions, and reports the median reduction', () => {
	const rows = [
		repo('a/with1', 1, 10, 2), repo('a/with2', 2, 10, 4), repo('a/with3', 1, 10, 6),
		repo('b/none1', 0, 10, 8), repo('b/none2', 0, 10, 10), repo('b/none3', 0, 10, 12),
	];
	const result = compareInstructionCohorts(rows);
	assert.equal(result.qualifies, true);
	assert.equal(result.withInstructions.medianCorrectionsPerSession, 0.4);
	assert.equal(result.withoutInstructions.medianCorrectionsPerSession, 1);
	assert.equal(Math.round(result.correctionsReductionPct!), 60);
});

test('compareInstructionCohorts: unscanned and small repositories do not take part', () => {
	const rows = [
		repo('a/with1', 1, 10, 2), repo('a/with2', 1, 10, 2), repo('a/unscanned', undefined, 10, 2),
		repo('a/tiny', 1, MIN_REPO_TURN_DETAIL_SESSIONS - 1, 0),
		repo('b/none1', 0, 10, 8), repo('b/none2', 0, 10, 10), repo('b/none3', 0, 10, 12),
	];
	const result = compareInstructionCohorts(rows);
	assert.equal(result.withInstructions.repos, 2);
	assert.equal(result.qualifies, false);
	assert.equal(result.correctionsReductionPct, null);
});

test('compareInstructionCohorts: a higher rate with instructions is reported as a negative reduction', () => {
	const rows = [
		repo('a/w1', 1, 10, 10), repo('a/w2', 1, 10, 10), repo('a/w3', 1, 10, 10),
		repo('b/n1', 0, 10, 5), repo('b/n2', 0, 10, 5), repo('b/n3', 0, 10, 5),
	];
	assert.equal(compareInstructionCohorts(rows).correctionsReductionPct, -100);
});

test('compareInstructionCohorts: zero corrections without instructions gives no percentage', () => {
	const rows = [
		repo('a/w1', 1, 10, 0), repo('a/w2', 1, 10, 0), repo('a/w3', 1, 10, 0),
		repo('b/n1', 0, 10, 0), repo('b/n2', 0, 10, 0), repo('b/n3', 0, 10, 0),
	];
	const result = compareInstructionCohorts(rows);
	assert.equal(result.qualifies, true);
	assert.equal(result.correctionsReductionPct, null);
});
