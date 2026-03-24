/**
 * Token estimation and model-related utility functions.
 * Pure or near-pure functions extracted from CopilotTokenTracker for reusability.
 */
import type { ModelUsage, ModelPricing, ContextReferenceUsage } from './types';


export function estimateTokensFromText(text: string, model: string = 'gpt-4', tokenEstimators: { [key: string]: number } = {}): number {
	// Token estimation based on character count and model
	let tokensPerChar = 0.25; // default

	// Find matching model
	for (const [modelKey, ratio] of Object.entries(tokenEstimators)) {
		if (model.includes(modelKey) || model.includes(modelKey.replace('-', ''))) {
			tokensPerChar = ratio;
			break;
		}
	}

	return Math.ceil(text.length * tokensPerChar);
}

/**
 * Estimate tokens from a JSONL session file (used by Copilot CLI/Agent mode and VS Code incremental format)
 * Each line is a separate JSON object representing an event in the session
 */
export function estimateTokensFromJsonlSession(fileContent: string): { tokens: number; thinkingTokens: number; actualTokens: number } {
	let totalTokens = 0;
	let totalThinkingTokens = 0;
	const lines = fileContent.trim().split('\n');

	// For delta-based formats, reconstruct full state to reliably extract actual usage.
	// Usage data can arrive at many different delta path levels, so line-by-line matching
	// is fragile. Reconstructing the state (like the logviewer does) is the reliable approach.
	let sessionState: any = {};
	let isDeltaBased = false;
	let parseFailedLines = 0;
	// For CLI (non-delta) format: accumulate actual token totals from session.shutdown
	let cliActualTokens = 0;

	for (const line of lines) {
		if (!line.trim()) { continue; }

		try {
			const event = JSON.parse(line);

			// Detect and reconstruct delta-based format in parallel with estimation
			if (typeof event.kind === 'number') {
				isDeltaBased = true;
				sessionState = applyDelta(sessionState, event);
			}

			// Copilot CLI: session.shutdown contains exact token totals per model
			if (event.type === 'session.shutdown' && event.data?.modelMetrics) {
				for (const metrics of Object.values(event.data.modelMetrics) as any[]) {
					const usage = metrics?.usage;
					if (usage) {
						cliActualTokens += (typeof usage.inputTokens === 'number' ? usage.inputTokens : 0)
							+ (typeof usage.outputTokens === 'number' ? usage.outputTokens : 0);
					}
				}
			}

			// Handle Copilot CLI event types
			if (event.type === 'user.message' && event.data?.content) {
				totalTokens += estimateTokensFromText(event.data.content);
			} else if (event.type === 'assistant.message' && event.data?.content) {
				totalTokens += estimateTokensFromText(event.data.content);
			} else if (event.type === 'tool.result' && event.data?.output) {
				totalTokens += estimateTokensFromText(event.data.output);
			} else if (event.content) {
				// Fallback for other formats that might have content
				totalTokens += estimateTokensFromText(event.content);
			}

			// Handle VS Code incremental format (kind: 2 with requests or response)
			if (event.kind === 2 && event.k?.[0] === 'requests' && Array.isArray(event.v)) {
				for (const request of event.v) {
					if (request.message?.text) {
						totalTokens += estimateTokensFromText(request.message.text);
					}
				}
			}

			if (event.kind === 2 && event.k?.includes('response') && Array.isArray(event.v)) {
				for (const responseItem of event.v) {
					// Separate thinking tokens
					if (responseItem.kind === 'thinking' && responseItem.value) {
						totalThinkingTokens += estimateTokensFromText(responseItem.value);
						continue;
					}
					if (responseItem.value) {
						totalTokens += estimateTokensFromText(responseItem.value);
					} else if (responseItem.kind === 'markdownContent' && responseItem.content?.value) {
						totalTokens += estimateTokensFromText(responseItem.content.value);
					}
				}
			}
		} catch (e) {
			// Track parse failures for regex fallback
			parseFailedLines++;
		}
	}

	// Extract actual tokens from the reconstructed state (handles all delta path patterns)
	// Use per-request regex fallback (like the logviewer) so that requests whose result
	// lines failed JSON.parse still contribute actual tokens instead of being silently lost.
	let totalActualTokens = 0;
	if (isDeltaBased) {
		const rawUsageFallback = parseFailedLines > 0 ? extractPerRequestUsageFromRawLines(lines) : new Map<number, { promptTokens: number; outputTokens: number }>();
		const requests = (sessionState.requests && Array.isArray(sessionState.requests)) ? sessionState.requests : [];
		// Determine highest request index: max of reconstructed array length and regex-extracted keys
		let maxIndex = requests.length;
		for (const idx of rawUsageFallback.keys()) {
			if (idx + 1 > maxIndex) { maxIndex = idx + 1; }
		}
		for (let i = 0; i < maxIndex; i++) {
			const request = requests[i];
			let found = false;
			// Try reconstructed state first
			if (request?.result) {
				const result = request.result;
				if (typeof result.promptTokens === 'number' && typeof result.outputTokens === 'number') {
					totalActualTokens += result.promptTokens + result.outputTokens;
					found = true;
				} else if (result.metadata && typeof result.metadata.promptTokens === 'number' && typeof result.metadata.outputTokens === 'number') {
					// INSIDERS FORMAT (Feb 2026+): Tokens nested under result.metadata
					totalActualTokens += result.metadata.promptTokens + result.metadata.outputTokens;
					found = true;
				} else if (result.usage) {
					const u = result.usage;
					const prompt = typeof u.promptTokens === 'number' ? u.promptTokens : 0;
					const completion = typeof u.completionTokens === 'number' ? u.completionTokens : 0;
					totalActualTokens += prompt + completion;
					found = true;
				}
			}
			// Per-request fallback: if reconstruction missed this request's result, use regex
			if (!found) {
				const extracted = rawUsageFallback.get(i);
				if (extracted) {
					totalActualTokens += extracted.promptTokens + extracted.outputTokens;
				}
			}
		}
	}

	// If CLI session.shutdown provided actual totals, use them; otherwise fall back to per-request delta totals
	const finalActualTokens = !isDeltaBased && cliActualTokens > 0 ? cliActualTokens : totalActualTokens;
	return { tokens: totalTokens + totalThinkingTokens, thinkingTokens: totalThinkingTokens, actualTokens: finalActualTokens };
}

/**
 * Extract per-request actual token usage from raw JSONL lines using regex.
 * Handles cases where lines with result data fail JSON.parse due to bad escape characters.
 * Supports both old format (usage.promptTokens/completionTokens) and new format (promptTokens/outputTokens).
 */
export function extractPerRequestUsageFromRawLines(lines: string[]): Map<number, { promptTokens: number; outputTokens: number }> {
	const usage = new Map<number, { promptTokens: number; outputTokens: number }>();
	for (const line of lines) {
		if (!line.includes('"result"')) { continue; }
		const resultMatch = line.match(/"k":\s*\["requests",\s*(\d+),\s*"result"\]/);
		if (!resultMatch) { continue; }
		const requestIndex = parseInt(resultMatch[1], 10);
		const promptMatch = line.match(/"promptTokens":(\d+)/);
		const outputMatch = line.match(/"outputTokens":(\d+)/);
		const completionMatch = line.match(/"completionTokens":(\d+)/);
		if (promptMatch && (outputMatch || completionMatch)) {
			usage.set(requestIndex, {
				promptTokens: parseInt(promptMatch[1], 10),
				outputTokens: parseInt(outputMatch?.[1] || completionMatch![1], 10)
			});
		}
	}
	return usage;
}

export function getModelFromRequest(request: any, modelPricing: { [key: string]: ModelPricing } = {}): string {
	// Try to determine model from request metadata (most reliable source)
	// First check the top-level modelId field (VS Code format)
	if (request.modelId) {
		// Remove "copilot/" prefix if present
		return request.modelId.replace(/^copilot\//, '');
	}

	if (request.result && request.result.metadata && request.result.metadata.modelId) {
		return request.result.metadata.modelId.replace(/^copilot\//, '');
	}

	// Build a lookup map from display names to model IDs from modelPricing.json
	if (request.result && request.result.details) {
		// Create reverse lookup: displayName -> modelId
		const displayNameToModelId: { [displayName: string]: string } = {};
		for (const [modelId, pricing] of Object.entries(modelPricing)) {
			if (pricing.displayNames) {
				for (const displayName of pricing.displayNames) {
					displayNameToModelId[displayName] = modelId;
				}
			}
		}

		// Check which display name appears in the details
		// Sort by length descending to match longer names first (e.g., "Gemini 3 Pro (Preview)" before "Gemini 3 Pro")
		const sortedDisplayNames = Object.keys(displayNameToModelId).sort((a, b) => b.length - a.length);
		for (const displayName of sortedDisplayNames) {
			if (request.result.details.includes(displayName)) {
				return displayNameToModelId[displayName];
			}
		}
	}

	return 'gpt-4'; // default
}

/**
 * Detect if file content is JSONL format (multiple JSON objects, one per line)
 * This handles cases where .json files actually contain JSONL content
 */
export function isJsonlContent(content: string): boolean {
	const trimmed = content.trim();
	// JSONL typically has multiple lines, each starting with { and ending with }
	if (!trimmed.includes('\n')) {
		return false; // Single line - not JSONL
	}
	const lines = trimmed.split('\n').filter(l => l.trim());
	if (lines.length < 2) {
		return false; // Need multiple lines for JSONL
	}
	// Check if first two non-empty lines look like separate JSON objects
	const firstLine = lines[0].trim();
	const secondLine = lines[1].trim();
	return firstLine.startsWith('{') && firstLine.endsWith('}') &&
		secondLine.startsWith('{') && secondLine.endsWith('}');
}

/**
 * Check if file content is a UUID-only pointer file (new Copilot CLI format).
 * These files contain only a session ID instead of actual session data.
 * @param content The file content to check
 * @returns true if the content is a UUID-only pointer file
 */
export function isUuidPointerFile(content: string): boolean {
	const trimmedContent = content.trim();
	return /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(trimmedContent);
}

/**
 * Apply a delta to reconstruct session state from delta-based JSONL format.
 * VS Code Insiders uses this format where:
 * - kind: 0 = initial state (full replacement)
 * - kind: 1 = update value at key path
 * - kind: 2 = append to array at key path
 * - k = key path (array of strings)
 * - v = value
 */
export function applyDelta(state: any, delta: any): any {
	if (typeof delta !== 'object' || delta === null) {
		return state;
	}

	const { kind, k, v } = delta;

	if (kind === 0) {
		// Initial state - full replacement
		return v;
	}

	if (!Array.isArray(k) || k.length === 0) {
		return state;
	}

	const pathArr = k.map(String);
	let root = typeof state === 'object' && state !== null ? state : {};
	let current: any = root;

	// Traverse to the parent of the target location
	for (let i = 0; i < pathArr.length - 1; i++) {
		const seg = pathArr[i];
		const nextSeg = pathArr[i + 1];
		const wantsArray = /^\d+$/.test(nextSeg);

		if (Array.isArray(current)) {
			const idx = Number(seg);
			if (!current[idx] || typeof current[idx] !== 'object') {
				current[idx] = wantsArray ? [] : {};
			}
			current = current[idx];
		} else {
			if (!current[seg] || typeof current[seg] !== 'object') {
				current[seg] = wantsArray ? [] : {};
			}
			current = current[seg];
		}
	}

	const lastSeg = pathArr[pathArr.length - 1];

	if (kind === 1) {
		// Set value at key path
		if (Array.isArray(current)) {
			current[Number(lastSeg)] = v;
		} else {
			current[lastSeg] = v;
		}
		return root;
	}

	if (kind === 2) {
		// Append value(s) to array at key path
		let target: any[];
		if (Array.isArray(current)) {
			const idx = Number(lastSeg);
			if (!Array.isArray(current[idx])) {
				current[idx] = [];
			}
			target = current[idx];
		} else {
			if (!Array.isArray(current[lastSeg])) {
				current[lastSeg] = [];
			}
			target = current[lastSeg];
		}

		if (Array.isArray(v)) {
			target.push(...v);
		} else {
			target.push(v);
		}
		return root;
	}

	return root;
}

export function getModelTier(modelId: string, modelPricing: { [key: string]: ModelPricing } = {}): 'standard' | 'premium' | 'unknown' {
	// Determine tier based on multiplier: 0 = standard, >0 = premium
	// Look up from modelPricing.json
	const pricingInfo = modelPricing[modelId];
	if (pricingInfo && typeof pricingInfo.multiplier === 'number') {
		return pricingInfo.multiplier === 0 ? 'standard' : 'premium';
	}

	// Fallback: try to match partial model names
	for (const [key, value] of Object.entries(modelPricing)) {
		if (modelId.includes(key) || key.includes(modelId)) {
			if (typeof value.multiplier === 'number') {
				return value.multiplier === 0 ? 'standard' : 'premium';
			}
		}
	}

	return 'unknown';
}

/**
 * Calculate estimated cost in USD based on model usage
 * Assumes 50/50 split between input and output tokens for estimation
 * @param modelUsage Object with model names as keys and token counts as values
 * @returns Estimated cost in USD
 */
export function calculateEstimatedCost(modelUsage: ModelUsage, modelPricing: { [key: string]: ModelPricing } = {}): number {
	let totalCost = 0;

	for (const [model, usage] of Object.entries(modelUsage)) {
		const pricing = modelPricing[model];

		if (pricing) {
			// Use actual input and output token counts
			const inputCost = (usage.inputTokens / 1_000_000) * pricing.inputCostPerMillion;
			const outputCost = (usage.outputTokens / 1_000_000) * pricing.outputCostPerMillion;

			totalCost += inputCost + outputCost;
		} else {
			// Fallback for models without pricing data - use GPT-4o-mini as default
			const fallbackPricing = modelPricing['gpt-4o-mini'];

			const inputCost = (usage.inputTokens / 1_000_000) * fallbackPricing.inputCostPerMillion;
			const outputCost = (usage.outputTokens / 1_000_000) * fallbackPricing.outputCostPerMillion;

			totalCost += inputCost + outputCost;

			// log(`No pricing data for model '${model}', using fallback pricing (gpt-4o-mini)`);
		}
	}

	return totalCost;
}

/**
 * Create empty context references object.
 */
export function createEmptyContextRefs(): ContextReferenceUsage {
	return {
		file: 0, selection: 0, implicitSelection: 0, symbol: 0, codebase: 0,
		workspace: 0, terminal: 0, vscode: 0,
		terminalLastCommand: 0, terminalSelection: 0, clipboard: 0, changes: 0, outputPanel: 0, problemsPanel: 0,
		byKind: {}, copilotInstructions: 0, agentsMd: 0, byPath: {}
	};
}

// Helper method to get total tokens from ModelUsage
export function getTotalTokensFromModelUsage(modelUsage: ModelUsage): number {
	return Object.values(modelUsage).reduce((sum, usage) => sum + usage.inputTokens + usage.outputTokens, 0);
}
