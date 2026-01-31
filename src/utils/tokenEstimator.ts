import * as fs from 'fs';

interface ModelPricing {
	inputCostPerMillion: number;
	outputCostPerMillion: number;
	category?: string;
	displayNames?: string[];
}

/**
 * TokenEstimator handles token estimation from session files
 * and provides model detection logic
 */
export class TokenEstimator {
	constructor(
		private tokenEstimators: { [key: string]: number },
		private modelPricing: { [key: string]: ModelPricing },
		private warn: (message: string) => void
	) {}

	/**
	 * Estimate tokens from a session file (JSON or JSONL)
	 */
	public async estimateTokensFromSession(sessionFilePath: string): Promise<number> {
		try {
			const fileContent = await fs.promises.readFile(sessionFilePath, 'utf8');
			
			// Handle .jsonl files (each line is a separate JSON object)
			if (sessionFilePath.endsWith('.jsonl')) {
				return this.estimateTokensFromJsonlSession(fileContent);
			}
			
			// Handle regular .json files
			const sessionContent = JSON.parse(fileContent);
			let totalInputTokens = 0;
			let totalOutputTokens = 0;

			if (sessionContent.requests && Array.isArray(sessionContent.requests)) {
				for (const request of sessionContent.requests) {
					// Estimate tokens from user message (input)
					if (request.message && request.message.parts) {
						for (const part of request.message.parts) {
							if (part.text) {
								totalInputTokens += this.estimateTokensFromText(part.text);
							}
						}
					}

					// Estimate tokens from assistant response (output)
					if (request.response && Array.isArray(request.response)) {
						for (const responseItem of request.response) {
							if (responseItem.value) {
								totalOutputTokens += this.estimateTokensFromText(responseItem.value, this.getModelFromRequest(request));
							}
						}
					}
				}
			}

			return totalInputTokens + totalOutputTokens;
		} catch (error) {
			this.warn(`Error parsing session file ${sessionFilePath}: ${error}`);
			return 0;
		}
	}

	/**
	 * Estimate tokens from a JSONL session file (used by Copilot CLI/Agent mode and VS Code incremental format)
	 * Each line is a separate JSON object representing an event in the session
	 */
	private estimateTokensFromJsonlSession(fileContent: string): number {
		let totalTokens = 0;
		const lines = fileContent.trim().split('\n');
		
		for (const line of lines) {
			if (!line.trim()) { continue; }
			
			try {
				const event = JSON.parse(line);
				
				// Handle Copilot CLI event types
				if (event.type === 'user.message' && event.data?.content) {
					totalTokens += this.estimateTokensFromText(event.data.content);
				} else if (event.type === 'assistant.message' && event.data?.content) {
					totalTokens += this.estimateTokensFromText(event.data.content);
				} else if (event.type === 'tool.result' && event.data?.output) {
					totalTokens += this.estimateTokensFromText(event.data.output);
				} else if (event.content) {
					// Fallback for other formats that might have content
					totalTokens += this.estimateTokensFromText(event.content);
				}
				
				// Handle VS Code incremental format (kind: 2 with requests or response)
				if (event.kind === 2 && event.k?.[0] === 'requests' && Array.isArray(event.v)) {
					for (const request of event.v) {
						if (request.message?.text) {
							totalTokens += this.estimateTokensFromText(request.message.text);
						}
					}
				}
				
				if (event.kind === 2 && event.k?.includes('response') && Array.isArray(event.v)) {
					for (const responseItem of event.v) {
						if (responseItem.value) {
							totalTokens += this.estimateTokensFromText(responseItem.value);
						} else if (responseItem.kind === 'markdownContent' && responseItem.content?.value) {
							totalTokens += this.estimateTokensFromText(responseItem.content.value);
						}
					}
				}
			} catch (e) {
				// Skip malformed lines
			}
		}
		
		return totalTokens;
	}

	/**
	 * Get the model identifier from a request object
	 */
	public getModelFromRequest(request: any): string {
		// Try to determine model from request metadata
		if (request.result && request.result.metadata && request.result.metadata.modelId) {
			return request.result.metadata.modelId;
		}
		
		// Build a lookup map from display names to model IDs from modelPricing.json
		if (request.result && request.result.details) {
			// Create reverse lookup: displayName -> modelId
			const displayNameToModelId: { [displayName: string]: string } = {};
			for (const [modelId, pricing] of Object.entries(this.modelPricing)) {
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
	 * Estimate tokens from text based on character count and model
	 */
	public estimateTokensFromText(text: string, model: string = 'gpt-4'): number {
		// Token estimation based on character count and model
		let tokensPerChar = 0.25; // default

		// Find matching model
		for (const [modelKey, ratio] of Object.entries(this.tokenEstimators)) {
			if (model.includes(modelKey) || model.includes(modelKey.replace('-', ''))) {
				tokensPerChar = ratio;
				break;
			}
		}

		return Math.ceil(text.length * tokensPerChar);
	}
}
