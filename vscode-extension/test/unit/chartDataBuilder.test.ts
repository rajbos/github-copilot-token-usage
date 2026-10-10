import test from 'node:test';
import * as assert from 'node:assert/strict';

import { buildChartData, getModelBillingProvider, getBillingGroup, COPILOT_EDITOR_NAMES } from '../../../src/chartDataBuilder';
import type { DailyTokenStats, ModelUsage } from '../../../src/types';

// ── getModelBillingProvider ───────────────────────────────────────────────────

test('getModelBillingProvider: claude maps to Anthropic', () => {
	assert.equal(getModelBillingProvider('claude-3-5-sonnet'), 'Anthropic');
});

test('getModelBillingProvider: anthropic prefix maps to Anthropic', () => {
	assert.equal(getModelBillingProvider('anthropic-some-model'), 'Anthropic');
});

test('getModelBillingProvider: gemini maps to Google', () => {
	assert.equal(getModelBillingProvider('gemini-2.0-flash'), 'Google');
});

test('getModelBillingProvider: google prefix maps to Google', () => {
	assert.equal(getModelBillingProvider('google-something'), 'Google');
});

test('getModelBillingProvider: glm maps to Z.ai rather than falling through to Other', () => {
	// Mistral Vibe routes to GLM models, and they are priced in modelPricing.json — so
	// without a prefix entry their real cost would land in the generic "Other" bucket.
	assert.equal(getModelBillingProvider('glm-5-2'), 'Z.ai');
	assert.equal(getModelBillingProvider('glm-4.6'), 'Z.ai');
});

test('getModelBillingProvider: mistral maps to Mistral AI', () => {
	assert.equal(getModelBillingProvider('mistral-large'), 'Mistral AI');
});

test('getModelBillingProvider: codestral maps to Mistral AI', () => {
	assert.equal(getModelBillingProvider('codestral-latest'), 'Mistral AI');
});

test('getModelBillingProvider: magistral maps to Mistral AI', () => {
	assert.equal(getModelBillingProvider('magistral-medium'), 'Mistral AI');
});

test('getModelBillingProvider: gpt maps to OpenAI', () => {
	assert.equal(getModelBillingProvider('gpt-4o'), 'OpenAI');
});

test('getModelBillingProvider: o1 maps to OpenAI', () => {
	assert.equal(getModelBillingProvider('o1-mini'), 'OpenAI');
});

test('getModelBillingProvider: o3 maps to OpenAI', () => {
	assert.equal(getModelBillingProvider('o3'), 'OpenAI');
});

test('getModelBillingProvider: o4 maps to OpenAI', () => {
	assert.equal(getModelBillingProvider('o4-mini'), 'OpenAI');
});

test('getModelBillingProvider: grok maps to xAI', () => {
	assert.equal(getModelBillingProvider('grok-2'), 'xAI');
});

test('getModelBillingProvider: qwen maps to Alibaba', () => {
	assert.equal(getModelBillingProvider('qwen2.5-coder'), 'Alibaba');
});

test('getModelBillingProvider: custom endpoint model maps to the user-chosen provider group', () => {
	assert.equal(getModelBillingProvider('customendpoint/Mistral/mistral-medium-latest'), 'Mistral (Custom)');
});

test('getModelBillingProvider: two-part model IDs are not treated as custom endpoints', () => {
	assert.equal(getModelBillingProvider('mistral/mistral-medium-latest'), 'Mistral AI');
});

test('getModelBillingProvider: mai- maps to Microsoft', () => {
	assert.equal(getModelBillingProvider('mai-ds-r1'), 'Microsoft');
});

test('getModelBillingProvider: HydraFusion belongs to GitHub Copilot, not to any model vendor', () => {
	// The models behind hydrafusion vary per turn, so the only honest provider is
	// the one running the router — and the Efficiency view's vendor filter must
	// not file it under "Other".
	assert.equal(getModelBillingProvider('hydrafusion'), 'GitHub Copilot');
});

test('getModelBillingProvider: the bare auto id is not claimed for Copilot', () => {
	// Kiro CLI records every session under `auto` as well; without editor
	// context this helper cannot tell the two apart, so it stays unclassified.
	assert.equal(getModelBillingProvider('auto'), 'Other');
});

test('getModelBillingProvider: unknown model maps to Other', () => {
	assert.equal(getModelBillingProvider('some-unknown-model'), 'Other');
});

test('getModelBillingProvider: case insensitive', () => {
	assert.equal(getModelBillingProvider('Claude-3-Opus'), 'Anthropic');
	assert.equal(getModelBillingProvider('GPT-4O'), 'OpenAI');
});

test('getModelBillingProvider: classifies prefixed catalog model IDs', () => {
	assert.equal(getModelBillingProvider('copilot/claude-sonnet-4.6'), 'Anthropic');
	assert.equal(
		getModelBillingProvider('83a386ed-9f05-4fd9-83d4-f453d20c994c/mistral-medium-latest'),
		'Mistral AI'
	);
});

// ── getBillingGroup ───────────────────────────────────────────────────────────

test('getBillingGroup: VS Code editor returns GitHub Copilot', () => {
	assert.equal(getBillingGroup('VS Code', 'gpt-4o'), 'GitHub Copilot');
});

test('getBillingGroup: Visual Studio editor returns GitHub Copilot', () => {
	assert.equal(getBillingGroup('Visual Studio', 'claude-3-5-sonnet'), 'GitHub Copilot');
});

test('getBillingGroup: JetBrains editor returns GitHub Copilot', () => {
	assert.equal(getBillingGroup('JetBrains', 'gemini-2.0-flash'), 'GitHub Copilot');
});

test('getBillingGroup: Copilot CLI editor returns GitHub Copilot', () => {
	assert.equal(getBillingGroup('Copilot CLI', 'claude-sonnet-4-5'), 'GitHub Copilot');
});

test('getBillingGroup: Claude Code editor returns Anthropic from model', () => {
	assert.equal(getBillingGroup('Claude Code', 'claude-3-5-sonnet'), 'Anthropic');
});

test('getBillingGroup: Gemini CLI editor returns Google from model', () => {
	assert.equal(getBillingGroup('Gemini CLI', 'gemini-2.0-flash'), 'Google');
});

test('getBillingGroup: unknown editor with OpenAI model returns OpenAI', () => {
	assert.equal(getBillingGroup('Some Editor', 'gpt-4o'), 'OpenAI');
});

test('getBillingGroup: custom endpoint model keeps its own group on a Copilot surface', () => {
	// BYOK endpoints are billed by the user's own provider, not through Copilot credits.
	assert.equal(getBillingGroup('VS Code', 'customendpoint/Mistral/mistral-medium-latest'), 'Mistral (Custom)');
	assert.equal(getBillingGroup('VS Code', 'customendpoint/Mistral/MistralMedium3.5'), 'Mistral (Custom)');
});

test('getBillingGroup: custom endpoint model on a non-Copilot surface uses the same group', () => {
	assert.equal(getBillingGroup('Some Editor', 'unify-chat-provider/OpenCode%20Go/qwen3.7-max'), 'OpenCode Go (Custom)');
});

// ── COPILOT_EDITOR_NAMES ─────────────────────────────────────────────────────

test('COPILOT_EDITOR_NAMES includes VS Code', () => {
	assert.ok(COPILOT_EDITOR_NAMES.has('VS Code'));
});

test('COPILOT_EDITOR_NAMES includes Visual Studio', () => {
	assert.ok(COPILOT_EDITOR_NAMES.has('Visual Studio'));
});

test('COPILOT_EDITOR_NAMES includes JetBrains', () => {
	assert.ok(COPILOT_EDITOR_NAMES.has('JetBrains'));
});

test('buildChartData: includes task-category token/session/cost datasets', () => {
	const modelUsage: ModelUsage = {
		'gpt-4o': { inputTokens: 800, outputTokens: 200, sessions: 1 },
	};
	const daily: DailyTokenStats[] = [{
		date: '2026-08-30',
		tokens: 1000,
		sessions: 2,
		interactions: 4,
		modelUsage,
		editorUsage: { 'VS Code': { tokens: 1000, sessions: 2 } },
		repositoryUsage: { 'https://github.com/a/b': { tokens: 1000, sessions: 2 } },
		taskCategoryTokens: { Coding: 600, Testing: 400 },
		taskCategorySessions: { Coding: 1.25, Testing: 0.75 },
		taskCategoryModelUsage: {
			Coding: { 'gpt-4o': { inputTokens: 480, outputTokens: 120, sessions: 1 } },
			Testing: { 'gpt-4o': { inputTokens: 320, outputTokens: 80, sessions: 1 } },
		},
	}];
	const payload = buildChartData(daily, {
		getRepoDisplayName: (url) => url.split('/').slice(-2).join('/'),
		calculateEstimatedCost: (usage) => Object.values(usage).reduce((sum, u) => sum + (u.inputTokens + u.outputTokens) / 1_000_000, 0),
		backendConfigured: false,
		compactNumbers: false,
		now: new Date('2026-08-31T00:00:00.000Z'),
	});
	const taskTokenSets = payload.periods.day.taskCategoryTokenDatasets as Array<{ label: string; data: number[] }>;
	const taskSessionSets = payload.periods.day.taskCategorySessionDatasets as Array<{ label: string; data: number[] }>;
	const taskCostSets = payload.periods.day.taskCategoryCostDatasets as Array<{ label: string; data: number[] }>;
	assert.ok(taskTokenSets.some(ds => ds.label === 'Coding' && ds.data.some(v => v === 600)));
	assert.ok(taskSessionSets.some(ds => ds.label === 'Testing' && ds.data.some(v => v === 0.75)));
	assert.ok(taskCostSets.some(ds => ds.label === 'Coding' && ds.data.some(v => v > 0)));
});

// ── buildChartData sessions splits ────────────────────────────────────────────

const testDailyStats: DailyTokenStats[] = [
	{
		date: '2025-01-01',
		tokens: 1000,
		sessions: 2,
		interactions: 10,
		modelUsage: {
			'gpt-4o': { inputTokens: 400, outputTokens: 100, sessions: 1 },
			'claude-3-5-sonnet': { inputTokens: 300, outputTokens: 200, sessions: 1 },
		},
		editorUsage: { 'VS Code': { tokens: 1000, sessions: 2 } },
		repositoryUsage: { 'owner/repo': { tokens: 1000, sessions: 2 } },
		editorModelUsage: {
			'VS Code': {
				'gpt-4o': { inputTokens: 400, outputTokens: 100, sessions: 1 },
				'claude-3-5-sonnet': { inputTokens: 300, outputTokens: 200, sessions: 1 },
			},
		},
	},
	{
		date: '2025-01-02',
		tokens: 500,
		sessions: 1,
		interactions: 5,
		modelUsage: { 'gpt-4o': { inputTokens: 300, outputTokens: 200, sessions: 1 } },
		editorUsage: { 'VS Code': { tokens: 500, sessions: 1 } },
		repositoryUsage: { 'owner/repo': { tokens: 500, sessions: 1 } },
		editorModelUsage: {
			'VS Code': { 'gpt-4o': { inputTokens: 300, outputTokens: 200, sessions: 1 } },
		},
	},
];

const testDeps = {
	getRepoDisplayName: (url: string) => url,
	calculateEstimatedCost: () => 0,
	backendConfigured: false,
	compactNumbers: false,
	now: new Date('2025-01-15T12:00:00Z'),
};

test('buildChartData builds non-empty model session datasets', () => {
	const data = buildChartData(testDailyStats, testDeps);
	assert.ok(data.periods.day.modelSessionsDatasets);
	assert.equal(data.periods.day.modelSessionsDatasets.length, 2);
	const totals = data.periods.day.modelSessionsDatasets.map((d: any) => d.data.reduce((a: number, b: number) => a + b, 0)).sort((a: number, b: number) => a - b);
	assert.deepEqual(totals, [1, 2]);
});

test('buildChartData builds non-empty editor session datasets', () => {
	const data = buildChartData(testDailyStats, testDeps);
	const vsCodeDataset = data.periods.day.editorSessionsDatasets?.find((d: any) => d.label === 'VS Code');
	assert.ok(vsCodeDataset, 'expected VS Code session dataset');
	assert.equal((vsCodeDataset as any).data.reduce((a: number, b: number) => a + b, 0), 3);
});

test('buildChartData builds non-empty provider session datasets', () => {
	const data = buildChartData(testDailyStats, testDeps);
	assert.ok(data.periods.day.providerSessionsDatasets);
	assert.ok(data.periods.day.providerSessionsDatasets!.length > 0);
	const copilotDataset = data.periods.day.providerSessionsDatasets!.find((d: any) => d.label === 'GitHub Copilot');
	assert.ok(copilotDataset, 'expected GitHub Copilot provider session dataset');
	assert.equal((copilotDataset as any).data.reduce((a: number, b: number) => a + b, 0), 3);
});

// ── modelCostDatasets ─────────────────────────────────────────────────────────

/** Test cost stub: $1 per input token + $2 per output token, doubled for 'provider' pricing source. */
const costPerModelDeps = {
	...testDeps,
	calculateEstimatedCost: (usage: Record<string, { inputTokens: number; outputTokens: number }>, pricingSource: 'provider' | 'copilot') => {
		const multiplier = pricingSource === 'provider' ? 2 : 1;
		return Object.values(usage).reduce((sum, u) => sum + (u.inputTokens * 1 + u.outputTokens * 2) * multiplier, 0);
	},
};

test('buildChartData builds non-empty model cost datasets', () => {
const data = buildChartData(testDailyStats, costPerModelDeps);
assert.ok(data.periods.day.modelCostDatasets && data.periods.day.modelCostDatasets.length > 0);
const total = data.periods.day.modelCostDatasets.reduce((sum, ds: any) => sum + (ds.data ?? []).reduce((a: number, b: number) => a + b, 0), 0);
assert.ok(total > 0);
});

test('buildChartData model cost datasets include GPT-4o totals matching the daily usage', () => {
const data = buildChartData(testDailyStats, costPerModelDeps);
assert.ok(data.periods.day.modelCostDatasets);
const gptDataset = data.periods.day.modelCostDatasets!.find((d: any) => d.label.toLowerCase().includes('gpt-4o') || d.label.toLowerCase().includes('4o'));
assert.ok(gptDataset, 'expected a GPT-4o model cost dataset');
// Both days' gpt-4o usage is via VS Code (Copilot pricing, multiplier 1):
// day1: 400*1 + 100*2 = 600, day2: 300*1 + 200*2 = 700
assert.equal((gptDataset as any).data.reduce((a: number, b: number) => a + b, 0), 1300);
});

test('buildChartData model cost datasets sum to same total as billing group cost datasets', () => {
const data = buildChartData(testDailyStats, costPerModelDeps);
const modelTotal = (data.periods.day.modelCostDatasets ?? []).reduce((sum: number, ds: any) => sum + ds.data.reduce((a: number, b: number) => a + b, 0), 0);
const providerTotal = (data.periods.day.billingGroupCostDatasets ?? []).reduce((sum: number, ds: any) => sum + ds.data.reduce((a: number, b: number) => a + b, 0), 0);
assert.equal(modelTotal, providerTotal);
});

// ── providerTokensDatasets ────────────────────────────────────────────────────

test('buildChartData builds non-empty provider token datasets', () => {
const data = buildChartData(testDailyStats, testDeps);
assert.ok(data.periods.day.providerTokensDatasets);
assert.ok(data.periods.day.providerTokensDatasets!.length > 0);
const copilotDataset = data.periods.day.providerTokensDatasets!.find((d: any) => d.label === 'GitHub Copilot');
assert.ok(copilotDataset, 'expected GitHub Copilot provider token dataset');
// All usage in testDailyStats comes from VS Code (a Copilot surface):
// day1: (400+100)+(300+200)=1000, day2: 300+200=500
assert.equal((copilotDataset as any).data.reduce((a: number, b: number) => a + b, 0), 1500);
});
