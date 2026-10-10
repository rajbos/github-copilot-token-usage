import { describe, test } from 'node:test';
import * as assert from 'node:assert/strict';

import { buildDarkFactoryChatPrompt, buildDarkFactorySectionHtml } from '../../src/webview/maturity/darkFactorySection';
import { buildDarkFactoryReport, scoreDarkFactoryReadiness, type DarkFactoryObservation } from '../../../src/darkFactoryReadiness';
import type { DarkFactoryReport } from '../../../src/types';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function repoReport(overrides: {
	name?: string;
	nameWithOwner?: string;
	observations?: Record<string, DarkFactoryObservation>;
	facts?: { agentFileNames?: string[]; writeAllWorkflows?: string[] };
} = {}) {
	return scoreDarkFactoryReadiness({
		name: overrides.name ?? 'demo',
		repoRoot: '/tmp/demo',
		nameWithOwner: overrides.nameWithOwner,
		observations: overrides.observations ?? {},
		facts: overrides.facts,
	});
}

function report(repos: ReturnType<typeof repoReport>[], options: Partial<DarkFactoryReport> = {}): DarkFactoryReport {
	return {
		...buildDarkFactoryReport(repos, {
			scannedAt: '2026-09-01T12:00:00.000Z',
			apiSignalsIncluded: false,
			skippedRepoCount: 0,
		}),
		...options,
	};
}

describe('buildDarkFactorySectionHtml', () => {
	test('renders nothing when no scan ran — an absent scan is not an empty repository', () => {
		assert.equal(buildDarkFactorySectionHtml(undefined), '');
	});

	test('renders an explicit empty state when the workspace has no repositories', () => {
		const html = buildDarkFactorySectionHtml(report([]));
		assert.match(html, /No git repositories were found/);
		assert.match(html, /never people/);
	});

	test('states that readiness is per repository and that stage 5 is never awarded', () => {
		const html = buildDarkFactorySectionHtml(report([repoReport()]));
		assert.match(html, /per repository and never per person/);
		assert.match(html, /A checklist, not a green light/);
		assert.match(html, /Stage 5 is not\./);
	});

	test('renders each repository as a collapsed row whose summary carries the overview', () => {
		const html = buildDarkFactorySectionHtml(report([
			repoReport({ name: 'alpha', observations: { 'codeowners': { state: 'absent', detail: 'none' } } }),
			repoReport({ name: 'beta', facts: { agentFileNames: ['refactor.agent.md'] } }),
		]));
		const cards = html.match(/<details class="df-repo-card" data-df-repo="\d+">/g) ?? [];
		assert.equal(cards.length, 2);
		assert.equal(/<details class="df-repo-card" open/.test(html), false);
		const summary = html.slice(html.indexOf('<summary class="df-repo-summary">'), html.indexOf('</summary>', html.indexOf('df-repo-summary')));
		assert.match(summary, /alpha/);
		assert.match(summary, /Stage 0 confirmed/);
		assert.match(summary, /missing for Stage 1/);
		assert.match(summary, /unchecked/);
		assert.equal(/Missing for Stage 1 &mdash;/.test(summary), false, 'detail blocks live in the expandable body');
		assert.match(html, /1 anti-pattern</);
	});

	test('tallies every scanned repository in a one-line overview', () => {
		const html = buildDarkFactorySectionHtml(report([
			repoReport({ name: 'a' }),
			repoReport({ name: 'b', facts: { agentFileNames: ['refactor.agent.md'] } }),
		]));
		assert.match(html, /<strong>2<\/strong> repositories scanned/);
		assert.match(html, /<strong>2<\/strong> at Stage 0/);
		assert.match(html, /<strong>1<\/strong> with anti-patterns/);
	});

	test('keeps the full explanation behind a collapsed "What this measures" toggle', () => {
		const html = buildDarkFactorySectionHtml(report([repoReport()]));
		assert.match(html, /<details class="df-about">\s*<summary>📋 What this measures<\/summary>/);
	});

	test('shows the confirmed/ceiling band when evidence is incomplete', () => {
		const html = buildDarkFactorySectionHtml(report([repoReport()]));
		assert.match(html, /Stage 0 confirmed/);
		assert.match(html, /control\(s\) not checked/);
	});

	test('explains that missing API evidence means unchecked, not missing', () => {
		const html = buildDarkFactorySectionHtml(report([repoReport()], { apiSignalsIncluded: false }));
		assert.match(html, /reported as unchecked rather than missing/);
	});

	test('says when pull-request evidence was included', () => {
		const html = buildDarkFactorySectionHtml(report([repoReport()], { apiSignalsIncluded: true }));
		assert.match(html, /Pull-request evidence/);
	});

	test('lists the specific controls blocking the next stage together with their remediation', () => {
		const html = buildDarkFactorySectionHtml(report([repoReport({
			observations: { 'codeowners': { state: 'absent', detail: 'none' } },
		})]));
		assert.match(html, /Missing for Stage 1/);
		assert.match(html, /CODEOWNERS/);
		assert.match(html, /Add a CODEOWNERS file/);
	});

	test('lists unchecked controls with the reason they could not be checked', () => {
		const html = buildDarkFactorySectionHtml(report([repoReport()]));
		assert.match(html, /Could not check for Stage 1/);
		assert.match(html, /Needs a GitHub token/);
	});

	test('marks heuristic controls so a pattern match is not read as a verdict', () => {
		const html = buildDarkFactorySectionHtml(report([repoReport({
			observations: { 'ci-test-execution': { state: 'absent', detail: 'none' } },
		})]));
		assert.match(html, /df-heuristic/);
	});

	test('renders detected anti-patterns with their severity', () => {
		const html = buildDarkFactorySectionHtml(report([repoReport({
			facts: { agentFileNames: ['refactor.agent.md'] },
		})]));
		assert.match(html, /Anti-patterns detected/);
		assert.match(html, /No independent evaluator agent/);
	});

	test('reports the repositories it did not scan rather than truncating silently', () => {
		const html = buildDarkFactorySectionHtml(report([repoReport()], { skippedRepoCount: 7 }));
		assert.match(html, /7 further repositories were found but not scanned/);
	});

	test('uses the singular when exactly one repository was skipped', () => {
		const html = buildDarkFactorySectionHtml(report([repoReport()], { skippedRepoCount: 1 }));
		assert.match(html, /1 further repository was found but not scanned/);
	});

	test('says nothing about skipped repositories when none were skipped', () => {
		const html = buildDarkFactorySectionHtml(report([repoReport()], { skippedRepoCount: 0 }));
		assert.equal(/further repositor/.test(html), false);
	});

	test('marks a repository whose GitHub remote could not be resolved', () => {
		const html = buildDarkFactorySectionHtml(report([repoReport({ nameWithOwner: undefined })]));
		assert.match(html, /no GitHub remote resolved/);
	});

	test('shows owner/repo when it is known', () => {
		const html = buildDarkFactorySectionHtml(report([repoReport({ nameWithOwner: 'rajbos/demo' })]));
		assert.match(html, /rajbos\/demo/);
	});

	test('escapes repository names so a hostile folder name cannot inject markup', () => {
		const html = buildDarkFactorySectionHtml(report([repoReport({
			name: '<img src=x onerror="alert(1)">',
			nameWithOwner: '"><script>alert(2)</script>',
		})]));
		assert.equal(html.includes('<img'), false);
		assert.equal(html.includes('<script>'), false);
		assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
		assert.match(html, /&lt;script&gt;alert\(2\)/);
	});

	test('escapes control detail text coming from the filesystem', () => {
		const html = buildDarkFactorySectionHtml(report([repoReport({
			observations: { 'codeowners': { state: 'unknown', detail: '<script>alert(3)</script>' } },
		})]));
		assert.equal(html.includes('<script>alert(3)</script>'), false);
	});
});

describe('Copilot Chat action', () => {
	const codeownersAbsent = { 'codeowners': { state: 'absent' as const, detail: 'none' } };

	test('offers a checked selection box for each missing control and anti-pattern, not for unchecked controls', () => {
		const html = buildDarkFactorySectionHtml(report([repoReport({
			observations: codeownersAbsent,
			facts: { agentFileNames: ['refactor.agent.md'] },
		})]));
		assert.match(html, /class="df-pick" data-df-kind="control" data-df-id="codeowners" checked/);
		assert.match(html, /class="df-pick" data-df-kind="finding" data-df-id="[^"]+" checked/);
		const unknownBlock = html.slice(html.indexOf('Could not check for Stage 1'));
		const unknownList = unknownBlock.slice(0, unknownBlock.indexOf('</ul>'));
		assert.equal(unknownList.includes('df-pick'), false);
		assert.match(html, /class="button df-chat-btn" data-df-repo="0"/);
	});

	test('omits the action when there is nothing to implement', () => {
		const repo = repoReport();
		const empty = { ...repo, findings: [], stages: repo.stages.map(stage => ({ ...stage, missing: [] })) };
		const html = buildDarkFactorySectionHtml(report([empty]));
		assert.equal(html.includes('df-chat-btn'), false);
	});

	test('builds a prompt naming the repository and only the selected items', () => {
		const repo = repoReport({
			nameWithOwner: 'rajbos/demo',
			observations: { ...codeownersAbsent, 'ci-test-execution': { state: 'absent', detail: 'none' } },
			facts: { agentFileNames: ['refactor.agent.md'] },
		});
		const prompt = buildDarkFactoryChatPrompt(repo, ['codeowners'], [repo.findings[0].id]);
		assert.ok(prompt);
		assert.match(prompt, /rajbos\/demo \(\/tmp\/demo\)/);
		assert.match(prompt, /CODEOWNERS \(Stage 1\): Add a CODEOWNERS file/);
		assert.match(prompt, /No independent evaluator agent/);
		assert.equal(prompt.includes('Tests executed in CI'), false);
		assert.match(prompt, /Do not claim the repository is ready/);
	});

	test('ignores ids that are unknown or not absent, and returns nothing for an empty selection', () => {
		const repo = repoReport({ observations: codeownersAbsent });
		assert.equal(buildDarkFactoryChatPrompt(repo, [], []), undefined);
		assert.equal(buildDarkFactoryChatPrompt(repo, ['not-a-control', 'required-reviews'], ['nope']), undefined);
	});
});
