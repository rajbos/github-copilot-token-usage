import { describe, test } from 'node:test';
import * as assert from 'node:assert/strict';

import { aiuToUsd } from '../../../src/hydrafusion';
import {
	buildMcpAndContextRefsCard,
	formatTopListWithOther,
	sumSessionCost,
	type McpAndContextRefsCardStats,
} from '../../src/webview/logviewer/summaryCards';

function stats(overrides: Partial<McpAndContextRefsCardStats> = {}): McpAndContextRefsCardStats {
	return {
		usageMcpTotal: 0,
		usageTopMcpTools: [],
		usageContextTotal: 0,
		usageContextImplicit: 0,
		usageContextExplicit: 0,
		...overrides,
	};
}

describe('formatTopListWithOther', () => {
	test('returns "None" for an empty list', () => {
		assert.equal(formatTopListWithOther([], 0), 'None');
	});

	test('lists every entry when they already sum to the total', () => {
		const html = formatTopListWithOther([{ key: 'toolA', value: 2 }, { key: 'toolB', value: 1 }], 3);
		assert.match(html, /toolA: 2/);
		assert.match(html, /toolB: 1/);
		assert.doesNotMatch(html, /Other/);
	});

	test('appends an "Other: N" row when the total exceeds the listed entries', () => {
		const html = formatTopListWithOther([{ key: 'toolA', value: 2 }], 5);
		assert.match(html, /Other: 3/);
	});
});

describe('buildMcpAndContextRefsCard', () => {
	test('collapses to a single "None" line when both MCP tools and context refs are zero, instead of repeating each label', () => {
		const html = buildMcpAndContextRefsCard(stats());
		// The zero counts are already shown in the compact rows above; the
		// sub-text must not restate "MCP Tools: None" / "Context Refs: None".
		assert.doesNotMatch(html, /MCP Tools:/);
		assert.doesNotMatch(html, /Context Refs:/);
		const noneMatches = html.match(/None/g) ?? [];
		assert.equal(noneMatches.length, 1);
	});

	test('shows only the MCP breakdown line when MCP tools are used but no context refs are', () => {
		const html = buildMcpAndContextRefsCard(stats({
			usageMcpTotal: 3,
			usageTopMcpTools: [{ key: 'github', value: 3 }],
		}));
		assert.match(html, /github: 3/);
		assert.doesNotMatch(html, /implicit/);
		assert.doesNotMatch(html, /None/);
	});

	test('shows only the context-refs breakdown line when context refs are used but no MCP tools are', () => {
		const html = buildMcpAndContextRefsCard(stats({
			usageContextTotal: 5,
			usageContextImplicit: 3,
			usageContextExplicit: 2,
		}));
		assert.match(html, /implicit 3, explicit 2/);
		assert.doesNotMatch(html, /None/);
	});

	test('shows both breakdown lines when both MCP tools and context refs are used', () => {
		const html = buildMcpAndContextRefsCard(stats({
			usageMcpTotal: 2,
			usageTopMcpTools: [{ key: 'github', value: 2 }],
			usageContextTotal: 4,
			usageContextImplicit: 1,
			usageContextExplicit: 3,
		}));
		assert.match(html, /github: 2/);
		assert.match(html, /implicit 1, explicit 3/);
		assert.doesNotMatch(html, /None/);
	});

	test('still renders the compact-row counts unconditionally', () => {
		const html = buildMcpAndContextRefsCard(stats({ usageMcpTotal: 7, usageContextTotal: 9 }));
		assert.match(html, /summary-compact-val">7</);
		assert.match(html, /summary-compact-val">9</);
	});
});

describe('sumSessionCost', () => {
	test('returns 0 when no turn carries a cost', () => {
		assert.equal(sumSessionCost({ turns: [{ toolCalls: [] }, { toolCalls: [{}] }] }), 0);
	});

	test('sums per-turn estimates and sub-agent costs for ordinary sessions', () => {
		const total = sumSessionCost({ turns: [
			{ estimatedCost: 0.5, toolCalls: [] },
			{ estimatedCost: 0.25, toolCalls: [{ subAgentCost: 0.125 }, {}] },
		] });
		assert.equal(total, 0.875);
	});

	test('HydraFusion AIU replaces turn estimates but sub-agent costs are still added', () => {
		const total = sumSessionCost({
			turns: [{ estimatedCost: 99, toolCalls: [{ subAgentCost: 0.5 }] }],
			hydraFusion: { totalAiu: 200 },
		});
		assert.equal(total, aiuToUsd(200) + 0.5);
	});
});
