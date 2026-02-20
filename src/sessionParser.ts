export interface ModelUsage {
    [model: string]: { inputTokens: number; outputTokens: number };
}

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
	return typeof value === 'object' && value !== null;
}

function isSafePathSegment(seg: string): boolean {
	// Prevent prototype pollution and other surprising behavior.
	if (typeof seg !== 'string') {
		return false;
	}
	const forbidden = ['__proto__', 'prototype', 'constructor', 'hasOwnProperty'];
	return !forbidden.includes(seg) && !seg.startsWith('__');
}

function isArrayIndexSegment(seg: string): boolean {
	return /^\d+$/.test(seg);
}

function normalizeModelId(model: unknown, defaultModel: string): string {
	if (typeof model !== 'string') {
		return defaultModel;
	}
	const trimmed = model.trim();
	if (!trimmed) {
		return defaultModel;
	}
	return trimmed.startsWith('copilot/') ? trimmed.substring('copilot/'.length) : trimmed;
}

/**
 * Apply a delta to reconstruct session state from delta-based JSONL
 * VS Code Insiders uses this format where:
 * - kind: 0 = initial state (full replacement)
 * - kind: 1 = update at key path
 * - kind: 2 = append to array at key path
 * - k = key path (array of strings)
 * - v = value
 */
function applyDelta(state: unknown, delta: unknown): unknown {
	if (!isObject(delta)) {
		return state;
	}

	const kind = (delta as any).kind;
	const k = (delta as any).k;
	const v = (delta as any).v;

	if (kind === 0) {
		// Initial state - full replacement
		return v;
	}

	if (!Array.isArray(k) || k.length === 0) {
		return state;
	}

	const path = k.map(String);
	for (const seg of path) {
		if (!isSafePathSegment(seg)) {
			return state;
		}
	}

	let root: any = isObject(state) ? state : Object.create(null);
	let current: any = root;

	const ensureChildContainer = (parent: any, key: string, nextSeg: string): any => {
		const wantsArray = isArrayIndexSegment(nextSeg);
		let existing = parent[key];
		if (!isObject(existing)) {
			existing = wantsArray ? [] : Object.create(null);
			parent[key] = existing;
		}
		return existing;
	};

	// Traverse to the parent of the target location
	for (let i = 0; i < path.length - 1; i++) {
		const seg = path[i];
		const nextSeg = path[i + 1];

		if (Array.isArray(current) && isArrayIndexSegment(seg)) {
			const idx = Number(seg);
			let existing = current[idx];
			if (!isObject(existing)) {
				existing = isArrayIndexSegment(nextSeg) ? [] : Object.create(null);
				current[idx] = existing;
			}
			current = existing;
			continue;
		}

		if (!isObject(current)) {
			return root;
		}
		current = ensureChildContainer(current, seg, nextSeg);
	}

	const lastSeg = path[path.length - 1];
	if (kind === 1) {
		// Set value at key path
		if (Array.isArray(current) && isArrayIndexSegment(lastSeg)) {
			current[Number(lastSeg)] = v;
			return root;
		}
		if (isObject(current)) {
			// Use Object.defineProperty for safe assignment, preventing prototype pollution
			Object.defineProperty(current, lastSeg, {
				value: v,
				writable: true,
				enumerable: true,
				configurable: true
			});
		}
		return root;
	}

	if (kind === 2) {
		// Append value(s) to array at key path
		let target: any;
		if (Array.isArray(current) && isArrayIndexSegment(lastSeg)) {
			const idx = Number(lastSeg);
			if (!Array.isArray(current[idx])) {
				current[idx] = [];
			}
			target = current[idx];
		} else if (isObject(current)) {
			if (!Array.isArray((current as any)[lastSeg])) {
				// Use Object.defineProperty for safe assignment
				Object.defineProperty(current, lastSeg, {
					value: [],
					writable: true,
					enumerable: true,
					configurable: true
				});
			}
			target = (current as any)[lastSeg];
		}

		if (Array.isArray(target)) {
			if (Array.isArray(v)) {
				target.push(...v);
			} else {
				target.push(v);
			}
		}
		return root;
	}

	return root;
}

/**
 * Extract text content from response items, separating thinking text.
 */
function extractResponseAndThinkingText(response: unknown): { responseText: string; thinkingText: string } {
	if (!Array.isArray(response)) {
		return { responseText: '', thinkingText: '' };
	}
	let responseText = '';
	let thinkingText = '';
	for (const item of response) {
		if (!isObject(item)) {
			continue;
		}
		// Separate thinking items from regular response text
		if ((item as any).kind === 'thinking') {
			const value = (item as any).value;
			if (typeof value === 'string' && value) {
				thinkingText += value;
			}
			continue;
		}
		const contentValue = isObject((item as any).content) ? (item as any).content.value : undefined;
		const value = (item as any).value;
		// Prefer content.value when present to avoid double-counting wrapper text.
		if (typeof contentValue === 'string' && contentValue) {
			responseText += contentValue;
			continue;
		}
		if (typeof value === 'string' && value) {
			responseText += value;
		}
	}
	return { responseText, thinkingText };
}

export function parseSessionFileContent(
	sessionFilePath: string,
	fileContent: string,
	estimateTokensFromText: (text: string, model?: string) => number,
	getModelFromRequest?: (req: any) => string
) {
	const modelUsage: ModelUsage = {};
	let interactions = 0;
	let totalInputTokens = 0;
	let totalOutputTokens = 0;
	let totalThinkingTokens = 0;

	let sessionJson: any | undefined;

	const defaultModel = 'gpt-4o';

	const ensureModel = (m?: string) => (typeof m === 'string' && m ? m : defaultModel);

	const addInput = (model: string, text: string) => {
		const m = ensureModel(model);
		if (!modelUsage[m]) {modelUsage[m] = { inputTokens: 0, outputTokens: 0 };}
		const t = estimateTokensFromText(text, m);
		modelUsage[m].inputTokens += t;
		totalInputTokens += t;
	};

	const addOutput = (model: string, text: string) => {
		const m = ensureModel(model);
		if (!modelUsage[m]) {modelUsage[m] = { inputTokens: 0, outputTokens: 0 };}
		const t = estimateTokensFromText(text, m);
		modelUsage[m].outputTokens += t;
		totalOutputTokens += t;
	};

	// Handle delta-based JSONL format (VS Code Insiders)
	if (sessionFilePath.endsWith('.jsonl')) {
		const lines = fileContent.split(/\r?\n/).filter(l => l.trim());
		
		// Check if this is delta-based format (has "kind" field)
		let isDeltaBased = false;
		if (lines.length > 0) {
			try {
				const first = JSON.parse(lines[0]);
				if (first && typeof first.kind === 'number') {
					isDeltaBased = true;
				}
			} catch {
				// Not delta format
			}
		}

		if (isDeltaBased) {
			// Reconstruct session state from deltas
			let sessionState: unknown = Object.create(null);
			for (const line of lines) {
				try {
					const delta = JSON.parse(line);
					sessionState = applyDelta(sessionState, delta);
				} catch {
					// Skip invalid lines
				}
			}

			// Now process the reconstructed session state
			const requests = isObject(sessionState) && Array.isArray((sessionState as any).requests)
				? ((sessionState as any).requests as unknown[])
				: [];
			if (requests.length > 0) {
				// Count only requests that look like user interactions.
				interactions = requests.filter((r) => isObject(r) && isObject((r as any).message) && typeof (r as any).message.text === 'string' && (r as any).message.text.trim()).length;
				
				for (const request of requests) {
					if (!isObject(request)) {
						continue;
					}
					// Per-request model (user can select different model for each request)
					const requestModel = normalizeModelId(
						(request as any).modelId ?? (request as any).selectedModel?.identifier ?? (request as any).model,
						defaultModel
					);

					// Delta-based format is authoritative for per-request model selection.
					// Only allow callback override if it returns a non-default, non-empty model.
					const callbackModelRaw = getModelFromRequest ? getModelFromRequest(request as any) : undefined;
					const callbackModel = normalizeModelId(callbackModelRaw, '');
					const model = callbackModel && callbackModel !== defaultModel ? callbackModel : requestModel;
					
					// Extract user message text
					const message = (request as any).message;
					if (isObject(message) && typeof (message as any).text === 'string') {
						addInput(model, (message as any).text);
					}

					// Extract response text (separating thinking text)
					const { responseText, thinkingText } = extractResponseAndThinkingText((request as any).response);
					if (responseText) {
						addOutput(model, responseText);
					}
					if (thinkingText) {
						totalThinkingTokens += estimateTokensFromText(thinkingText, model);
					}
				}
			}

			return {
				tokens: totalInputTokens + totalOutputTokens + totalThinkingTokens,
				interactions,
				modelUsage,
				thinkingTokens: totalThinkingTokens
			};
		}

		// Not delta-based JSONL. Best-effort: sometimes files are JSON objects with a .jsonl extension.
		try {
			sessionJson = JSON.parse(fileContent.trim());
		} catch {
			return { tokens: 0, interactions: 0, modelUsage: {}, thinkingTokens: 0 };
		}
	}

	// Non-jsonl (JSON file) - try to parse full JSON
	if (!sessionJson) {
		try {
			sessionJson = JSON.parse(fileContent);
		} catch {
			return { tokens: 0, interactions: 0, modelUsage: {}, thinkingTokens: 0 };
		}
	}

	const requests = Array.isArray(sessionJson.requests) ? sessionJson.requests : (Array.isArray(sessionJson.history) ? sessionJson.history : []);
	interactions = requests.length;
	for (const request of requests) {
		const modelRaw = getModelFromRequest ? getModelFromRequest(request) : (request?.model || defaultModel);
		const model = normalizeModelId(modelRaw, defaultModel);
		if (!modelUsage[model]) {modelUsage[model] = { inputTokens: 0, outputTokens: 0 };}

		if (request?.message?.parts) {
			for (const part of request.message.parts) {
				if (typeof part?.text === 'string' && part.text) {
					const t = estimateTokensFromText(part.text, model);
					modelUsage[model].inputTokens += t;
					totalInputTokens += t;
				}
			}
		} else if (typeof request?.message?.text === 'string') {
			const t = estimateTokensFromText(request.message.text, model);
			modelUsage[model].inputTokens += t;
			totalInputTokens += t;
		}

		const responses = Array.isArray(request?.response) ? request.response : (Array.isArray(request?.responses) ? request.responses : []);
		for (const responseItem of responses) {
			// Separate thinking tokens
			if (responseItem?.kind === 'thinking' && typeof responseItem?.value === 'string' && responseItem.value) {
				totalThinkingTokens += estimateTokensFromText(responseItem.value, model);
				continue;
			}
			if (typeof responseItem?.value === 'string' && responseItem.value) {
				const t = estimateTokensFromText(responseItem.value, model);
				modelUsage[model].outputTokens += t;
				totalOutputTokens += t;
			}
			if (responseItem?.message?.parts) {
				for (const p of responseItem.message.parts) {
					if (typeof p?.text === 'string' && p.text) {
						const t = estimateTokensFromText(p.text, model);
						modelUsage[model].outputTokens += t;
						totalOutputTokens += t;
					}
				}
			}
		}
	}

	return {
		tokens: totalInputTokens + totalOutputTokens + totalThinkingTokens,
		interactions,
		modelUsage,
		thinkingTokens: totalThinkingTokens
	};
}

export default { parseSessionFileContent };
