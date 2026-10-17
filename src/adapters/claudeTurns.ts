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

	for (const event of events) {
		if (event.type === 'user' && !event.isSidechain && event.message?.role === 'user' && isHumanUserTurn(event)) {
			const turn = buildTurnFromEvents(currentUserEvent, pendingAssistantEvents, processAssistantEvents, turns.length + 1, estimateTokens);
			if (turn) { turns.push(turn); }
			currentUserEvent = event;
			pendingAssistantEvents.length = 0;
		} else if (event.type === 'assistant' && event.message?.stop_reason && event.message?.role === 'assistant') {
			pendingAssistantEvents.push(event);
		}
	}
	const finalTurn = buildTurnFromEvents(currentUserEvent, pendingAssistantEvents, processAssistantEvents, turns.length + 1, estimateTokens);
	if (finalTurn) { turns.push(finalTurn); }

	return turns;
}

function buildTurnFromEvents(
	userEvent: any,
	pendingAssistantEvents: any[],
	processAssistantEvents: (pendingAssistantEvents: any[]) => ClaudeAssistantTurnData,
	turnNumber: number,
	estimateTokens: (text: string, model?: string) => number
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
