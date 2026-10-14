import test from 'node:test';
import * as assert from 'node:assert/strict';

import {
	DARK_FACTORY_CONTROLS,
	MAX_ASSESSABLE_STAGE,
	agentPullRequestObservation,
	buildDarkFactoryReport,
	detectFindings,
	evaluatorAgentNames,
	hasEvaluatorAgent,
	nextStageToClose,
	resolveControl,
	scoreDarkFactoryReadiness,
	type DarkFactoryObservation,
	type DarkFactoryRepoFacts,
} from '../darkFactoryReadiness';
import type { DarkFactoryControlDefinition, DarkFactoryControlResult } from '../types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Every scannable control id, i.e. everything a collector could legitimately answer. */
function scannableControlIds(): string[] {
	return DARK_FACTORY_CONTROLS
		.filter(c => c.evidence !== 'not-scannable' && c.tier !== 'governance')
		.map(c => c.id);
}

/** Observations marking every scannable control up to and including `throughStage` as present. */
function presentThrough(throughStage: number, overrides: Record<string, DarkFactoryObservation> = {}): Record<string, DarkFactoryObservation> {
	const observations: Record<string, DarkFactoryObservation> = {};
	for (const control of DARK_FACTORY_CONTROLS) {
		if (control.evidence === 'not-scannable' || control.tier === 'governance') { continue; }
		observations[control.id] = control.stage <= throughStage
			? { state: 'present', detail: 'fixture' }
			: { state: 'absent', detail: 'fixture' };
	}
	return { ...observations, ...overrides };
}

function score(observations: Record<string, DarkFactoryObservation>, facts?: DarkFactoryRepoFacts) {
	return scoreDarkFactoryReadiness({ name: 'demo', repoRoot: '/tmp/demo', observations, facts });
}

function controlDef(overrides: Partial<DarkFactoryControlDefinition> = {}): DarkFactoryControlDefinition {
	return {
		id: 'test-control',
		stage: 1,
		label: 'Test control',
		tier: 'filesystem',
		evidence: 'direct',
		why: 'because',
		remediation: 'do the thing',
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// Catalogue integrity
// ---------------------------------------------------------------------------

test('catalogue: stage 5 is never assessable', () => {
	assert.equal(MAX_ASSESSABLE_STAGE, 4);
	assert.equal(DARK_FACTORY_CONTROLS.some(c => c.stage > MAX_ASSESSABLE_STAGE), false);
});

test('catalogue: control ids are unique and every control names a remediation', () => {
	const ids = DARK_FACTORY_CONTROLS.map(c => c.id);
	assert.equal(new Set(ids).size, ids.length);
	for (const control of DARK_FACTORY_CONTROLS) {
		assert.ok(control.remediation.length > 0, `${control.id} has no remediation`);
		assert.ok(control.why.length > 0, `${control.id} has no rationale`);
		assert.ok(control.stage >= 1 && control.stage <= MAX_ASSESSABLE_STAGE, `${control.id} has an unassessable stage`);
	}
});

test('catalogue: every assessable stage has at least one control', () => {
	for (let stage = 1; stage <= MAX_ASSESSABLE_STAGE; stage++) {
		assert.ok(DARK_FACTORY_CONTROLS.some(c => c.stage === stage), `stage ${stage} has no controls`);
	}
});

// ---------------------------------------------------------------------------
// resolveControl — the honesty policy
// ---------------------------------------------------------------------------

test('resolveControl: a control with no observation is unknown, never absent', () => {
	const result = resolveControl(controlDef(), undefined);
	assert.equal(result.state, 'unknown');
	assert.equal(result.detail, 'Not checked by this scan.');
});

test('resolveControl: an unobserved API control says a token is needed', () => {
	const result = resolveControl(controlDef({ tier: 'api' }), undefined);
	assert.equal(result.state, 'unknown');
	assert.match(result.detail ?? '', /GitHub token/);
});

test('resolveControl: an explicit unknown observation stays unknown and keeps its reason', () => {
	const result = resolveControl(controlDef({ tier: 'api' }), { state: 'unknown', detail: '403 from the API' });
	assert.equal(result.state, 'unknown');
	assert.equal(result.detail, '403 from the API');
});

test('resolveControl: absence resolves to unknown when absence is not observable', () => {
	const def = controlDef({ tier: 'hybrid', unknownWhenAbsent: true, unknownReason: 'default setup leaves no file' });
	const result = resolveControl(def, { state: 'absent', detail: 'no workflow matched' });
	assert.equal(result.state, 'unknown');
	assert.equal(result.detail, 'default setup leaves no file');
});

test('resolveControl: presence is still reported for a control whose absence is unobservable', () => {
	const def = controlDef({ tier: 'hybrid', unknownWhenAbsent: true });
	const result = resolveControl(def, { state: 'present', detail: 'codeql.yml' });
	assert.equal(result.state, 'present');
	assert.equal(result.detail, 'codeql.yml');
});

test('resolveControl: a governance control is unknown even when a collector claims it is present', () => {
	const def = controlDef({ tier: 'governance', evidence: 'not-scannable' });
	const result = resolveControl(def, { state: 'present', detail: 'someone said so' });
	assert.equal(result.state, 'unknown');
});

test('resolveControl: a present observation passes through with its detail', () => {
	const result = resolveControl(controlDef(), { state: 'present', detail: '.github/dependabot.yml' });
	assert.equal(result.state, 'present');
	assert.equal(result.detail, '.github/dependabot.yml');
});

test('resolveControl: an absent observation on a plain filesystem control stays absent', () => {
	const result = resolveControl(controlDef(), { state: 'absent', detail: 'looked in .github' });
	assert.equal(result.state, 'absent');
});

// ---------------------------------------------------------------------------
// Stage verdicts and the confirmed/ceiling band
// ---------------------------------------------------------------------------

test('scoring: an empty repository confirms stage 0 and blocks stage 1', () => {
	const report = score({});
	assert.equal(report.confirmedStage, 0);
	const stage1 = report.stages.find(s => s.stage === 1);
	assert.equal(stage1?.verdict, 'indeterminate', 'nothing observed means unverifiable, not failed');
	assert.equal(stage1?.missing.length, 0);
});

test('scoring: an absent control blocks its stage and is named as missing', () => {
	const report = score(presentThrough(1, { 'codeowners': { state: 'absent', detail: 'none' } }));
	const stage1 = report.stages.find(s => s.stage === 1);
	assert.equal(stage1?.verdict, 'blocked');
	assert.ok(stage1?.missing.includes('codeowners'));
	assert.equal(report.confirmedStage, 0);
	assert.equal(report.ceilingStage, 0, 'a blocked stage caps the ceiling too');
});

test('scoring: unknowns make a stage indeterminate rather than attained or blocked', () => {
	const report = score(presentThrough(1, { 'branch-protection': { state: 'unknown', detail: 'no token' } }));
	const stage1 = report.stages.find(s => s.stage === 1);
	assert.equal(stage1?.verdict, 'indeterminate');
	assert.equal(stage1?.missing.length, 0);
	assert.ok(stage1?.unknown.includes('branch-protection'));
});

test('scoring: unknowns never lift the confirmed stage but do lift the ceiling', () => {
	// Everything through stage 2 is present except one unverifiable stage-1 control;
	// stage 3 is genuinely absent.
	const report = score(presentThrough(2, { 'branch-protection': { state: 'unknown', detail: 'no token' } }));
	assert.equal(report.confirmedStage, 0, 'an unverified stage-1 control blocks confirmation of every stage above it');
	assert.equal(report.ceilingStage, 2, 'nothing observed rules out stage 2');
	assert.equal(report.fullyEvidenced, false);
	assert.ok(report.unknownCount > 0);
});

test('scoring: confirmed equals ceiling when every control was observed', () => {
	// Stage 1 fully present, stage 2 genuinely absent, and no unknowns anywhere.
	const observations = presentThrough(1);
	for (const control of DARK_FACTORY_CONTROLS) {
		if (control.unknownWhenAbsent || control.tier === 'api' || control.tier === 'governance') {
			observations[control.id] = { state: 'present', detail: 'fixture' };
		}
	}
	// Re-absent everything above stage 1 that we just blanket-set.
	for (const control of DARK_FACTORY_CONTROLS) {
		if (control.stage > 1 && control.evidence !== 'not-scannable' && control.tier !== 'governance') {
			observations[control.id] = { state: 'absent', detail: 'fixture' };
		}
	}
	const report = score(observations);
	const stage1 = report.stages.find(s => s.stage === 1);
	assert.equal(stage1?.verdict, 'attained');
	assert.equal(report.confirmedStage, 1);
	assert.equal(report.ceilingStage, 1);
});

test('scoring: the confirmed stage stops at the first non-attained stage even if a later one is complete', () => {
	const observations = presentThrough(4);
	observations['copilot-instructions'] = { state: 'absent', detail: 'fixture' }; // a stage-2 control
	const report = score(observations);
	assert.equal(report.stages.find(s => s.stage === 2)?.verdict, 'blocked');
	assert.equal(report.stages.find(s => s.stage === 3)?.verdict, 'attained', 'stage 3 is complete in this fixture');
	assert.equal(report.confirmedStage, 1, 'a complete stage 3 cannot compensate for a blocked stage 2');
	assert.equal(report.ceilingStage, 1, 'stage 2 is blocked, so the ceiling stops below it');
});

test('scoring: every catalogue control appears in the result exactly once', () => {
	const report = score(presentThrough(4));
	assert.equal(report.controls.length, DARK_FACTORY_CONTROLS.length);
	const ids = report.controls.map((c: DarkFactoryControlResult) => c.id);
	assert.equal(new Set(ids).size, ids.length);
});

test('scoring: governance controls are reported as unknown even in a fully present fixture', () => {
	const observations = presentThrough(4);
	for (const id of scannableControlIds()) { observations[id] = { state: 'present' }; }
	const report = score(observations);
	const governance = report.controls.filter(c => c.tier === 'governance');
	assert.ok(governance.length > 0, 'the catalogue should carry governance controls');
	for (const control of governance) {
		assert.equal(control.state, 'unknown', `${control.id} must stay unknown`);
	}
	assert.equal(report.fullyEvidenced, false, 'a repository can never be fully evidenced while policy controls exist');
});

test('nextStageToClose: points at the first stage above the confirmed one', () => {
	const report = score({});
	assert.equal(nextStageToClose(report)?.stage, 1);
});

// ---------------------------------------------------------------------------
// Anti-pattern findings
// ---------------------------------------------------------------------------

function controlResults(states: Array<Partial<DarkFactoryControlResult> & { id: string; state: DarkFactoryControlResult['state'] }>): DarkFactoryControlResult[] {
	return states.map(s => ({ ...controlDef({ id: s.id, stage: s.stage ?? 1, label: s.label ?? s.id }), ...s }));
}

test('findings: AI customization ahead of delivery is reported as high severity', () => {
	const controls = controlResults([
		{ id: 'ci-workflows', state: 'absent', stage: 1 },
		{ id: 'copilot-instructions', state: 'present', stage: 2, label: 'Repository instructions' },
	]);
	const findings = detectFindings(controls);
	const finding = findings.find(f => f.id === 'agents-before-delivery');
	assert.ok(finding, 'expected the agents-before-delivery finding');
	assert.equal(finding?.severity, 'high');
	assert.match(finding?.detail ?? '', /Repository instructions/);
});

test('findings: delivery gaps alone do not raise agents-before-delivery', () => {
	const controls = controlResults([
		{ id: 'ci-workflows', state: 'absent', stage: 1 },
		{ id: 'copilot-instructions', state: 'absent', stage: 2 },
	]);
	assert.equal(detectFindings(controls).some(f => f.id === 'agents-before-delivery'), false);
});

test('findings: an unknown delivery control is not treated as a gap', () => {
	const controls = controlResults([
		{ id: 'ci-workflows', state: 'unknown', stage: 1 },
		{ id: 'copilot-instructions', state: 'present', stage: 2 },
	]);
	assert.equal(detectFindings(controls).some(f => f.id === 'agents-before-delivery'), false);
});

test('findings: agents without an evaluator are flagged', () => {
	const findings = detectFindings([], { agentFileNames: ['implementer.agent.md', 'refactor.agent.md'] });
	const finding = findings.find(f => f.id === 'no-independent-evaluator');
	assert.equal(finding?.severity, 'medium');
});

test('findings: a review agent satisfies the evaluator requirement', () => {
	const findings = detectFindings([], { agentFileNames: ['implementer.agent.md', 'code-quality-review.agent.md'] });
	assert.equal(findings.some(f => f.id === 'no-independent-evaluator'), false);
});

test('findings: no agents at all does not raise the evaluator finding', () => {
	assert.equal(detectFindings([], { agentFileNames: [] }).some(f => f.id === 'no-independent-evaluator'), false);
});

test('findings: write-all workflow permissions are flagged and named', () => {
	const findings = detectFindings([], { writeAllWorkflows: ['release.yml'] });
	const finding = findings.find(f => f.id === 'unbounded-workflow-permissions');
	assert.match(finding?.detail ?? '', /release\.yml/);
});

test('findings: long-lived cloud credentials are flagged and named', () => {
	const findings = detectFindings([], { longLivedCredentialWorkflows: ['deploy.yml'] });
	const finding = findings.find(f => f.id === 'long-lived-cloud-credentials');
	assert.match(finding?.detail ?? '', /deploy\.yml/);
});

test('findings: a clean repository produces none', () => {
	assert.deepEqual(detectFindings([], {}), []);
});

test('evaluatorAgentNames: matches review, test, security and quality roles', () => {
	assert.deepEqual(
		evaluatorAgentNames(['architecture-expert.agent.md', 'test-expert.agent.md', 'security-audit.md', 'refactor.agent.md']),
		['test-expert.agent.md', 'security-audit.md'],
	);
	assert.equal(hasEvaluatorAgent(['refactor.agent.md']), false);
});

// ---------------------------------------------------------------------------
// Pull-request derived signal
// ---------------------------------------------------------------------------

test('agentPullRequestObservation: no statistics is unknown, not absent', () => {
	assert.equal(agentPullRequestObservation(undefined).state, 'unknown');
});

test('agentPullRequestObservation: a fetch error is unknown and carries the error', () => {
	const observation = agentPullRequestObservation({ totalPrs: 0, aiAuthoredPrs: 0, error: 'Access denied' });
	assert.equal(observation.state, 'unknown');
	assert.equal(observation.detail, 'Access denied');
});

test('agentPullRequestObservation: an empty window is unknown, not absent', () => {
	const observation = agentPullRequestObservation({ totalPrs: 0, aiAuthoredPrs: 0 });
	assert.equal(observation.state, 'unknown');
	assert.match(observation.detail ?? '', /No pull requests/);
});

test('agentPullRequestObservation: pull requests with no agent authorship is absent', () => {
	const observation = agentPullRequestObservation({ totalPrs: 12, aiAuthoredPrs: 0 });
	assert.equal(observation.state, 'absent');
	assert.match(observation.detail ?? '', /12/);
});

test('agentPullRequestObservation: agent-authored pull requests are present', () => {
	const observation = agentPullRequestObservation({ totalPrs: 12, aiAuthoredPrs: 3 });
	assert.equal(observation.state, 'present');
	assert.match(observation.detail ?? '', /3 agent-authored/);
});

// ---------------------------------------------------------------------------
// Report assembly
// ---------------------------------------------------------------------------

test('buildDarkFactoryReport: sorts by confirmed stage then name and carries the caps', () => {
	const low = { ...score({}), name: 'zeta' };
	const high = { ...score({}), name: 'alpha', confirmedStage: 2 };
	const alsoLow = { ...score({}), name: 'beta' };
	const report = buildDarkFactoryReport([low, alsoLow, high], {
		scannedAt: '2026-09-01T00:00:00.000Z',
		apiSignalsIncluded: false,
		skippedRepoCount: 4,
	});
	assert.deepEqual(report.repos.map(r => r.name), ['alpha', 'beta', 'zeta']);
	assert.equal(report.apiSignalsIncluded, false);
	assert.equal(report.skippedRepoCount, 4);
	assert.equal(report.maxAssessableStage, MAX_ASSESSABLE_STAGE);
});

test('buildDarkFactoryReport: defaults the skipped count to zero and does not mutate its input', () => {
	const repos = [{ ...score({}), name: 'b' }, { ...score({}), name: 'a' }];
	const report = buildDarkFactoryReport(repos, { scannedAt: '2026-09-01T00:00:00.000Z', apiSignalsIncluded: true });
	assert.equal(report.skippedRepoCount, 0);
	assert.deepEqual(repos.map(r => r.name), ['b', 'a'], 'the caller\'s array must not be reordered');
});
