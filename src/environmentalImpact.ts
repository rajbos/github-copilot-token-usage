import type { ModelPricing, ModelUsage } from './types';
import modelPricingData from './modelPricing.json';
import { getModelLookupCandidates } from './webview/shared/modelUtils';

/**
 * Shared environmental-impact factors and helpers.
 *
 * Every factor below traces back to one source — Jegham et al., "How Hungry is
 * AI? Benchmarking Energy, Water, and Carbon Footprint of LLM Inference"
 * (arXiv:2505.09598, v6, 24 Nov 2025) — through the derivation published by
 * neuland in https://github.com/neuland/tokendashboard-backend/blob/main/docs/co2-methodology.md
 * (MIT). `test/unit/environmentalImpact.test.ts` recomputes the derivation from
 * the paper's inputs, so a constant cannot drift away from its source unnoticed.
 *
 * What comes from the paper (measured-ish estimates):
 *   - Claude 3.7 Sonnet, long prompt (10,000 input / 1,500 output tokens):
 *     5.671 ± 0.302 Wh per query, PUE-inclusive (Table 4)
 *   - AWS multipliers for Anthropic models (Table 1): PUE 1.14,
 *     WUE on-site 0.18 L/kWh, WUE off-site 5.11 L/kWh, CIF 0.287 kg CO₂e/kWh
 *   - Carbon  = E × CIF
 *   - Water   = E / PUE × WUE_site + E × WUE_source
 *
 * What is an approximation layered on top (neuland's choices, not the paper's):
 *   - One input token = 1/20 of an output token, giving the reference prompt
 *     2,000 "output-equivalent" tokens.
 *   - Cache writes = 1.25 × the input weight (Anthropic's 5-minute cache-write
 *     price premium).
 *   - Cache reads = 1% of the input weight. neuland is explicit that this is a
 *     guess: the real value "could just as well be 5%, 10%, or 20%".
 *   - Other models are scaled from Sonnet by the ratio of their output-token
 *     price. neuland does this for the Claude family only; we apply the same
 *     ratio to every model with a pricing entry, because a flat Sonnet factor
 *     would put a mini model on par with a frontier one.
 */

/** Inputs taken directly from Jegham et al. (arXiv:2505.09598 v6). */
export const PAPER_REFERENCE = {
	ARXIV_ID: '2505.09598',
	ARXIV_VERSION: 'v6',
	/** Long-form prompt configuration used for the reference measurement. */
	PROMPT_INPUT_TOKENS: 10_000,
	PROMPT_OUTPUT_TOKENS: 1_500,
	/** Claude 3.7 Sonnet, long prompt, Table 4 (PUE-inclusive). */
	ENERGY_WH_PER_QUERY: 5.671,
	ENERGY_WH_PER_QUERY_UNCERTAINTY: 0.302,
	/** AWS multipliers for Anthropic models, Table 1. */
	PUE: 1.14,
	WUE_SITE_L_PER_KWH: 0.18,
	WUE_SOURCE_L_PER_KWH: 5.11,
	CIF_KG_CO2E_PER_KWH: 0.287,
} as const;

/** Fixed methodology links the environmental view may ask the host to open, by id. */
export const ENVIRONMENTAL_METHODOLOGY_SOURCES: Readonly<Record<string, string>> = Object.freeze({
	paper: 'https://arxiv.org/abs/2505.09598',
	neuland: 'https://github.com/neuland/tokendashboard-backend/blob/main/docs/co2-methodology.md',
});

/**
 * Resolve a webview-supplied source id to its fixed URL. Only the map's own
 * keys match, so ids like `constructor` or `__proto__` cannot pull a
 * prototype member out and hand a non-URL to the host's open-external call.
 */
export function getEnvironmentalMethodologySourceUrl(id: unknown): string | undefined {
	return typeof id === 'string' && Object.prototype.hasOwnProperty.call(ENVIRONMENTAL_METHODOLOGY_SOURCES, id)
		? ENVIRONMENTAL_METHODOLOGY_SOURCES[id]
		: undefined;
}

const INPUT_WEIGHT = 1 / 20;

/** Output-equivalent tokens for the paper's reference prompt (1,500 + 10,000 / 20 = 2,000). */
const REFERENCE_OUTPUT_EQUIVALENT_TOKENS =
	PAPER_REFERENCE.PROMPT_OUTPUT_TOKENS + PAPER_REFERENCE.PROMPT_INPUT_TOKENS * INPUT_WEIGHT;

/** Water per reference query in litres: E / PUE × WUE_site + E × WUE_source. */
const REFERENCE_WATER_LITERS_PER_QUERY =
	(PAPER_REFERENCE.ENERGY_WH_PER_QUERY / 1000) / PAPER_REFERENCE.PUE * PAPER_REFERENCE.WUE_SITE_L_PER_KWH
	+ (PAPER_REFERENCE.ENERGY_WH_PER_QUERY / 1000) * PAPER_REFERENCE.WUE_SOURCE_L_PER_KWH;

export const ENVIRONMENTAL = {
	/**
	 * Claude Sonnet baseline. The paper's central value works out to ~814 g
	 * (range ~770–857 g from the reported ±0.302 Wh); neuland rounds up to 840 g
	 * toward the upper end of that range.
	 */
	CO2_GRAMS_PER_MILLION_OUTPUT_EQUIVALENT_TOKENS: 840,
	/** Claude Sonnet baseline, the paper's central value (~14.9 L), unrounded. */
	WATER_LITERS_PER_MILLION_OUTPUT_EQUIVALENT_TOKENS:
		REFERENCE_WATER_LITERS_PER_QUERY / REFERENCE_OUTPUT_EQUIVALENT_TOKENS * 1_000_000,
	/** One input token counts as 1/20th of an output token (neuland approximation). */
	INPUT_TOKEN_OUTPUT_EQUIVALENT_WEIGHT: INPUT_WEIGHT,
	/** Cache-write tokens are treated as 1.25x the input-token weight (neuland approximation). */
	CACHE_WRITE_OUTPUT_EQUIVALENT_WEIGHT: INPUT_WEIGHT * 1.25,
	/** Cache-read tokens are treated as 1% of the input-token weight (neuland approximation, highly uncertain). */
	CACHE_READ_OUTPUT_EQUIVALENT_WEIGHT: INPUT_WEIGHT * 0.01,
	/**
	 * Output-equivalent tokens per token when no input/output breakdown exists,
	 * taken from the reference prompt's own mix (2,000 / 11,500).
	 */
	UNATTRIBUTED_OUTPUT_EQUIVALENT_PER_TOKEN:
		REFERENCE_OUTPUT_EQUIVALENT_TOKENS / (PAPER_REFERENCE.PROMPT_INPUT_TOKENS + PAPER_REFERENCE.PROMPT_OUTPUT_TOKENS),
	/**
	 * Output-token price ($/1M) of the reference model (Claude Sonnet). A model's
	 * factor is baseline × (its output price / this price).
	 */
	REFERENCE_OUTPUT_COST_PER_MILLION: 15,
	CO2_ABSORPTION_PER_TREE_PER_YEAR: 21000,
} as const;

export interface EnvironmentalImpact {
	co2: number;
	waterUsage: number;
	treesEquivalent: number;
	/** Unscaled output-equivalent tokens across all models plus unattributed tokens. */
	outputEquivalentTokens: number;
	/** Tokens covered by a per-model breakdown. */
	attributedTokens: number;
	/** Tokens with no per-model breakdown, estimated with the reference prompt's mix. */
	unattributedTokens: number;
}

type PricingTable = { [key: string]: ModelPricing };

const DEFAULT_PRICING = (modelPricingData as { pricing: PricingTable }).pricing;

/**
 * Relative energy of a model versus the Claude Sonnet reference, using the
 * ratio of output-token prices. Models without a (positive) price fall back to
 * the Sonnet baseline rather than to zero: unknown or free is not energy-free.
 */
export function getModelEnvironmentalScale(model: string, pricing: PricingTable = DEFAULT_PRICING): number {
	for (const candidate of getModelLookupCandidates(model)) {
		const entry = pricing[candidate];
		if (entry) {
			return entry.outputCostPerMillion > 0
				? entry.outputCostPerMillion / ENVIRONMENTAL.REFERENCE_OUTPUT_COST_PER_MILLION
				: 1;
		}
	}
	return 1;
}

function outputEquivalentForUsage(usage: ModelUsage[string]): number {
	const cachedReadTokens = Math.max(0, usage.cachedReadTokens ?? 0);
	const cacheWriteTokens = Math.max(0, usage.cacheCreationTokens ?? 0);
	const uncachedInputTokens = Math.max(0, usage.inputTokens - cachedReadTokens - cacheWriteTokens);
	return Math.max(0, usage.outputTokens)
		+ uncachedInputTokens * ENVIRONMENTAL.INPUT_TOKEN_OUTPUT_EQUIVALENT_WEIGHT
		+ cacheWriteTokens * ENVIRONMENTAL.CACHE_WRITE_OUTPUT_EQUIVALENT_WEIGHT
		+ cachedReadTokens * ENVIRONMENTAL.CACHE_READ_OUTPUT_EQUIVALENT_WEIGHT;
}

export function calculateOutputEquivalentTokens(modelUsage: ModelUsage): number {
	let total = 0;
	for (const usage of Object.values(modelUsage)) {
		total += outputEquivalentForUsage(usage);
	}
	return total;
}

export function getTotalTokensFromModelUsage(modelUsage: ModelUsage): number {
	let total = 0;
	for (const usage of Object.values(modelUsage)) {
		total += Math.max(0, usage.inputTokens) + Math.max(0, usage.outputTokens);
	}
	return total;
}

/**
 * The synthetic bucket `reconcileModelUsageToTotal()` fills when a session has
 * no usable per-model split. It books every such token as input, so weighting
 * it would count a whole session at the input rate; treat it as unattributed.
 */
const UNATTRIBUTED_MODEL_KEY = 'unknown';

function withoutUnattributedBucket(modelUsage: ModelUsage): ModelUsage {
	if (!(UNATTRIBUTED_MODEL_KEY in modelUsage)) { return modelUsage; }
	const { [UNATTRIBUTED_MODEL_KEY]: _unattributed, ...attributed } = modelUsage;
	return attributed;
}

/**
 * CO₂, water and tree equivalent for a set of model usage.
 *
 * `totalTokens` may exceed what `modelUsage` accounts for (sessions without a
 * per-model breakdown), and an `unknown` bucket carries no real split. Both
 * are estimated with the reference
 * prompt's input/output mix at the Sonnet baseline, so it still counts instead
 * of silently dropping out of the total.
 */
export function calculateEnvironmentalImpact(
	modelUsage: ModelUsage,
	totalTokens?: number,
	pricing: PricingTable = DEFAULT_PRICING
): EnvironmentalImpact {
	const attributedUsage = withoutUnattributedBucket(modelUsage);
	const attributedTokens = getTotalTokensFromModelUsage(attributedUsage);
	const unattributedTokens = Math.max(0, (totalTokens ?? getTotalTokensFromModelUsage(modelUsage)) - attributedTokens);
	const unattributedOutputEquivalent = unattributedTokens * ENVIRONMENTAL.UNATTRIBUTED_OUTPUT_EQUIVALENT_PER_TOKEN;

	let outputEquivalentTokens = unattributedOutputEquivalent;
	let scaledOutputEquivalent = unattributedOutputEquivalent;
	for (const [model, usage] of Object.entries(attributedUsage)) {
		const outputEquivalent = outputEquivalentForUsage(usage);
		outputEquivalentTokens += outputEquivalent;
		scaledOutputEquivalent += outputEquivalent * getModelEnvironmentalScale(model, pricing);
	}

	const co2 = (scaledOutputEquivalent / 1_000_000) * ENVIRONMENTAL.CO2_GRAMS_PER_MILLION_OUTPUT_EQUIVALENT_TOKENS;
	return {
		co2,
		waterUsage: (scaledOutputEquivalent / 1_000_000) * ENVIRONMENTAL.WATER_LITERS_PER_MILLION_OUTPUT_EQUIVALENT_TOKENS,
		treesEquivalent: co2 / ENVIRONMENTAL.CO2_ABSORPTION_PER_TREE_PER_YEAR,
		outputEquivalentTokens,
		attributedTokens,
		unattributedTokens,
	};
}
