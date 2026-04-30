/**
 * JetBrains IDE Copilot Chat session parser.
 *
 * Parses the JSONL partition files that the GitHub Copilot plugin for
 * JetBrains IDEs writes under `~/.copilot/jb/{conversationId}/partition-{n}.jsonl`.
 *
 * Schema reference: docs/logFilesSchema/jetbrains-session-schema.json
 *
 * The JetBrains JSONL does NOT carry actual API token counts or a model
 * identifier. This parser produces best-effort estimates compatible with the
 * "common output" used by the rest of the extension:
 *
 *   { tokens, thinkingTokens, actualTokens, interactions, modelUsage,
 *     mode, modelHint, firstInteraction, lastInteraction, source, conversationId }
 *
 * Mode detection (ask vs. agent):
 *   - If the partition contains any `tool.execution_start` event, the user
 *     was in agent mode (ask mode cannot invoke tools).
 *   - Otherwise the partition is classified as ask mode.
 *
 * Model attribution:
 *   - Preferred: `assistant.turn_start.data.model` if present (not observed
 *     in current Rider builds, but harmless to support).
 *   - Heuristic from `tool.execution_start.data.toolCallId` prefix:
 *       "toolu_*" → Anthropic Claude (often "toolu_bdrk_*" for Bedrock),
 *       "call_*"  → OpenAI.
 *   - Otherwise "unknown".
 */
import type { ModelUsage } from './types';
import { estimateTokensFromText } from './tokenEstimation';

export type JetBrainsMode = 'ask' | 'agent';

export interface JetBrainsParsedSession {
	/** Sum of estimated input + output tokens (excludes thinking). */
	tokens: number;
	/** Estimated thinking-only tokens (Claude-style chain-of-thought). */
	thinkingTokens: number;
	/** JetBrains files don't expose API-side token counts. Always 0. */
	actualTokens: number;
	/** Count of `user.message` events (one per user turn). */
	interactions: number;
	/** Best-effort model usage. Empty object when no model could be derived. */
	modelUsage: ModelUsage;
	/** Conversation-level mode. */
	mode: JetBrainsMode;
	/** Best-effort model name; `'unknown'` when not derivable. */
	modelHint: string;
	/** ISO-8601 timestamp of the first user message, or null. */
	firstInteraction: string | null;
	/** ISO-8601 timestamp of the last assistant turn end / message, or null. */
	lastInteraction: string | null;
	/** Conversation source from `partition.created.data.source` (e.g. "panel"). */
	source: string | null;
	/** Conversation UUID from `partition.created.data.conversationId`. */
	conversationId: string | null;
	/**
	 * Per-tool-call entries in execution order. Mirrors the per-turn
	 * `ChatTurn.toolCalls` shape used by the rest of the extension so callers
	 * can render them uniformly.
	 */
	toolCalls: JetBrainsToolCall[];
	/**
	 * Aggregate count per tool name across the whole partition (e.g.
	 * `{ run_in_terminal: 27, read_file: 2 }`). Empty when no tools ran.
	 */
	toolCounts: Record<string, number>;
}

export interface JetBrainsToolCall {
	toolName: string;
	/** Stringified `data.arguments` from `tool.execution_start`, when present. */
	arguments?: string;
	/** Concatenated text blocks from `tool.execution_complete.data.result.result[]`. */
	result?: string;
	/** Mirrors `tool.execution_complete.data.success`. */
	success?: boolean;
}

/**
 * Heuristic mapping from `toolCallId` prefix to a model family.
 * Returns `null` when the prefix is unfamiliar.
 */
export function modelHintFromToolCallId(toolCallId: string | undefined): string | null {
	if (!toolCallId || typeof toolCallId !== 'string') { return null; }
	if (toolCallId.startsWith('toolu_')) {
		// Anthropic uses `toolu_*`. The Bedrock variant is `toolu_bdrk_*`.
		return 'claude';
	}
	if (toolCallId.startsWith('call_')) {
		// OpenAI uses `call_*`.
		return 'gpt';
	}
	return null;
}

/**
 * Parse a JetBrains partition file's raw JSONL content into the canonical
 * "common output" shape used by the rest of the extension.
 *
 * Malformed lines are skipped silently — partition files are append-only and
 * may legitimately have a half-written final line if read mid-write.
 */
export function parseJetBrainsPartition(content: string): JetBrainsParsedSession {
	const lines = content.split(/\r?\n/);
	const result: JetBrainsParsedSession = {
		tokens: 0,
		thinkingTokens: 0,
		actualTokens: 0,
		interactions: 0,
		modelUsage: {},
		mode: 'ask',
		modelHint: 'unknown',
		firstInteraction: null,
		lastInteraction: null,
		source: null,
		conversationId: null,
		toolCalls: [],
		toolCounts: {},
	};

	let inputTokens = 0;
	let outputTokens = 0;
	let firstUserTs: string | null = null;
	let lastTurnTs: string | null = null;
	let modelFromTurnStart: string | null = null;
	let modelFromToolCallId: string | null = null;
	let sawToolCall = false;

	// Index tool calls by toolCallId so `tool.execution_complete` can attach
	// success/result data to the entry created by `tool.execution_start`.
	const toolCallById = new Map<string, JetBrainsToolCall>();

	// Pre-parse the line stream once so we know which turnIds have a
	// `user.message_rendered` event. The rendered version subsumes the bare
	// `user.message` text, so we must NOT count both for the same turn.
	const parsed: any[] = [];
	const renderedTurnIds = new Set<string>();
	for (const line of lines) {
		if (!line) { continue; }
		try {
			const event = JSON.parse(line);
			if (!event || typeof event !== 'object') { continue; }
			parsed.push(event);
			if (event.type === 'user.message_rendered' && typeof event.data?.turnId === 'string') {
				renderedTurnIds.add(event.data.turnId);
			}
		} catch {
			// skip malformed lines
		}
	}

	for (const event of parsed) {
		switch (event.type) {
			case 'partition.created': {
				if (event.data?.conversationId) { result.conversationId = String(event.data.conversationId); }
				if (event.data?.source) { result.source = String(event.data.source); }
				break;
			}
			case 'user.message': {
				result.interactions++;
				if (typeof event.timestamp === 'string' && firstUserTs === null) {
					firstUserTs = event.timestamp;
				}
				const turnId = event.data?.turnId;
				// Skip the bare user message text when a rendered version exists for
				// the same turn — the rendered event already includes this content.
				if (typeof event.data?.content === 'string' && (typeof turnId !== 'string' || !renderedTurnIds.has(turnId))) {
					inputTokens += estimateTokensFromText(event.data.content);
				}
				break;
			}
			case 'user.message_rendered': {
				const rendered = event.data?.renderedMessage;
				if (typeof rendered === 'string') {
					inputTokens += estimateTokensFromText(rendered);
				}
				break;
			}
			case 'assistant.turn_start': {
				if (typeof event.data?.model === 'string' && !modelFromTurnStart) {
					modelFromTurnStart = event.data.model;
				}
				break;
			}
			case 'assistant.message': {
				if (typeof event.data?.text === 'string' && event.data.text) {
					outputTokens += estimateTokensFromText(event.data.text);
				}
				const thinking = event.data?.thinking?.text;
				if (typeof thinking === 'string' && thinking) {
					result.thinkingTokens += estimateTokensFromText(thinking);
				}
				if (typeof event.timestamp === 'string') { lastTurnTs = event.timestamp; }
				break;
			}
			case 'tool.execution_start': {
				sawToolCall = true;
				if (!modelFromToolCallId) {
					const hint = modelHintFromToolCallId(event.data?.toolCallId);
					if (hint) { modelFromToolCallId = hint; }
				}
				const toolName = typeof event.data?.toolName === 'string' ? event.data.toolName : 'unknown';
				const tc: JetBrainsToolCall = { toolName };
				if (event.data?.arguments !== undefined) {
					try { tc.arguments = JSON.stringify(event.data.arguments); } catch { /* ignore */ }
				}
				result.toolCalls.push(tc);
				result.toolCounts[toolName] = (result.toolCounts[toolName] || 0) + 1;
				const callId = event.data?.toolCallId;
				if (typeof callId === 'string') { toolCallById.set(callId, tc); }
				break;
			}
			case 'tool.execution_complete': {
				const blocks = event.data?.result?.result;
				let resultText = '';
				if (Array.isArray(blocks)) {
					for (const block of blocks) {
						if (block && typeof block.value === 'string') {
							outputTokens += estimateTokensFromText(block.value);
							resultText += (resultText ? '\n' : '') + block.value;
						}
					}
				}
				const callId = event.data?.toolCallId;
				if (typeof callId === 'string') {
					const tc = toolCallById.get(callId);
					if (tc) {
						if (typeof event.data?.success === 'boolean') { tc.success = event.data.success; }
						if (resultText) { tc.result = resultText; }
					}
				}
				break;
			}
			case 'assistant.turn_end': {
				if (typeof event.timestamp === 'string') { lastTurnTs = event.timestamp; }
				break;
			}
		}
	}

	result.mode = sawToolCall ? 'agent' : 'ask';
	result.modelHint = modelFromTurnStart || modelFromToolCallId || 'unknown';
	result.tokens = inputTokens + outputTokens;
	result.firstInteraction = firstUserTs;
	result.lastInteraction = lastTurnTs;

	if (result.tokens > 0 && result.modelHint !== 'unknown') {
		result.modelUsage[result.modelHint] = {
			inputTokens,
			outputTokens,
		};
	}

	return result;
}

/**
 * Lightweight model-hint detector. Scans for the first `tool.execution_start`
 * with a `toolCallId` whose prefix maps to a known model family. Returns
 * `'unknown'` when no usable hint is present (e.g. ask-mode sessions with no
 * tool calls).
 *
 * This is separate from {@link parseJetBrainsPartition} so callers that only
 * need the model hint (e.g. for per-turn `ChatTurn.model`) can avoid the cost
 * of building the full common-output object.
 */
export function detectJetBrainsModelHintFromContent(content: string): string {
	const lines = content.split(/\r?\n/);
	for (const line of lines) {
		if (!line || line.indexOf('tool.execution_start') === -1) { continue; }
		try {
			const event = JSON.parse(line);
			if (event && event.type === 'tool.execution_start') {
				const hint = modelHintFromToolCallId(event.data?.toolCallId);
				if (hint) { return hint; }
			}
		} catch { /* skip malformed */ }
	}
	return 'unknown';
}

/**
 * Lightweight mode-only detector. Reads the JSONL only far enough to find a
 * `tool.execution_start` event; falls back to ask mode if none is present.
 *
 * Used by `usageAnalysis.ts` to bucket JetBrains turns into ask vs. agent
 * instead of the catch-all `cli` bucket.
 */
export function detectJetBrainsModeFromContent(content: string): JetBrainsMode {
	const lines = content.split(/\r?\n/);
	for (const line of lines) {
		if (!line) { continue; }
		// Cheap substring check first; only parse JSON when the keyword is present.
		if (line.indexOf('tool.execution_start') === -1) { continue; }
		try {
			const event = JSON.parse(line);
			if (event && event.type === 'tool.execution_start') { return 'agent'; }
		} catch {
			// Ignore malformed lines.
		}
	}
	return 'ask';
}
