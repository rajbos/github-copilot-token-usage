import type { ChatTurn, ActualUsage } from '../types';
import { isHumanUserTurn } from '../utils/claudeUserTurns';
import { createEmptyContextRefs } from '../tokenEstimation';

/** What a Claude-family adapter extracts from the assistant events belonging to one turn. */
export interface ClaudeAssistantTurnData {
	assistantText: string;
	model: string | null;
	actualInputTokens: number;
	actualOutputTokens: number;
	toolCalls: { toolName: string; arguments?: string }[];
	mcpTools: { server: string; tool: string }[];
}

/**
 * Group Claude Code / Claude Desktop JSONL events into chat turns: each real human
 * `user` event starts a new turn, and the final assistant events that follow it
 * belong to that turn.
 *
 * The adapters differ only in how they read assistant events (e.g. which id they
 * deduplicate streamed fragments by), so that step is passed in.
 */
export function buildClaudeChatTurns(
	events: any[],
	processAssistantEvents: (pendingAssistantEvents: any[]) => ClaudeAssistantTurnData,
	estimateTokens: (text: string, model?: string) => number
): ChatTurn[] {
	const turns: ChatTurn[] = [];
	let currentUserEvent: any = null;
	const pendingAssistantEvents: any[] = [];
	// Latest timestamp of any event (assistant output, tool results, sub-agent work) since the human message.
	let lastEventTime: string | null = null;

	for (const event of events) {
		if (event.type === 'user' && !event.isSidechain && event.message?.role === 'user' && isHumanUserTurn(event)) {
			const turn = buildTurnFromEvents(currentUserEvent, pendingAssistantEvents, processAssistantEvents, turns.length + 1, estimateTokens, lastEventTime);
			if (turn) { turns.push(turn); }
			currentUserEvent = event;
			pendingAssistantEvents.length = 0;
			lastEventTime = null;
		} else if (event.type === 'assistant' && event.message?.stop_reason && event.message?.role === 'assistant') {
			pendingAssistantEvents.push(event);
		}
		lastEventTime = advanceLastEventTime(lastEventTime, event, currentUserEvent);
	}
	const finalTurn = buildTurnFromEvents(currentUserEvent, pendingAssistantEvents, processAssistantEvents, turns.length + 1, estimateTokens, lastEventTime);
	if (finalTurn) { turns.push(finalTurn); }

	return turns;
}

/** Moves the turn end forward for assistant and tool-result events that follow the human message. */
function advanceLastEventTime(current: string | null, event: { type?: unknown; timestamp?: unknown }, currentUserEvent: unknown): string | null {
	const isResponseEvent = (event.type === 'assistant' || event.type === 'user') && event !== currentUserEvent;
	return currentUserEvent && isResponseEvent ? laterTimestamp(current, event.timestamp) : current;
}

function laterTimestamp(current: string | null, candidate: unknown): string | null {
	if (typeof candidate !== 'string') { return current; }
	const candidateMs = Date.parse(candidate);
	if (!Number.isFinite(candidateMs)) { return current; }
	return current === null || candidateMs > Date.parse(current) ? candidate : current;
}

function buildTurnFromEvents(
	userEvent: any,
	pendingAssistantEvents: any[],
	processAssistantEvents: (pendingAssistantEvents: any[]) => ClaudeAssistantTurnData,
	turnNumber: number,
	estimateTokens: (text: string, model?: string) => number,
	lastEventTime: string | null
): ChatTurn | null {
	if (!userEvent) { return null; }
	const content = userEvent.message?.content;
	const userMessage = typeof content === 'string' ? content
		: Array.isArray(content) ? content.filter((c: any) => c.type === 'text').map((c: any) => c.text || '').join('\n')
		: '';
	const { assistantText, model, actualInputTokens, actualOutputTokens, toolCalls, mcpTools } =
		processAssistantEvents(pendingAssistantEvents);
	const usedModel = model || 'claude-sonnet-4-6';
	const actualUsage: ActualUsage | undefined = (actualInputTokens > 0 || actualOutputTokens > 0) ? {
		promptTokens: actualInputTokens,
		completionTokens: actualOutputTokens
	} : undefined;
	return {
		turnNumber,
		timestamp: userEvent.timestamp ? new Date(userEvent.timestamp).toISOString() : null,
		...(lastEventTime && !Number.isNaN(Date.parse(lastEventTime)) ? { endTimestamp: new Date(lastEventTime).toISOString() } : {}),
		mode: 'agent',
		userMessage,
		assistantResponse: assistantText,
		model: usedModel,
		toolCalls,
		contextReferences: createEmptyContextRefs(),
		mcpTools,
		inputTokensEstimate: actualInputTokens || estimateTokens(userMessage, usedModel),
		outputTokensEstimate: actualOutputTokens || estimateTokens(assistantText, usedModel),
		thinkingTokensEstimate: 0,
		actualUsage
	};
}
