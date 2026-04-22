import * as fs from 'fs';
import * as path from 'path';
import type { ModelUsage, ChatTurn } from '../types';
import type { IEcosystemAdapter } from '../ecosystemAdapter';
import { CrushDataAccess } from '../crush';
import { createEmptyContextRefs } from '../tokenEstimation';

export class CrushAdapter implements IEcosystemAdapter {
	readonly id = 'crush';
	readonly displayName = 'Crush';

	constructor(private readonly crush: CrushDataAccess) {}

	handles(sessionFile: string): boolean {
		return this.crush.isCrushSessionFile(sessionFile);
	}

	getBackingPath(sessionFile: string): string {
		return this.crush.getCrushDbPath(sessionFile);
	}

	async stat(sessionFile: string): Promise<fs.Stats> {
		return this.crush.statSessionFile(sessionFile);
	}

	async getTokens(sessionFile: string): Promise<{ tokens: number; thinkingTokens: number; actualTokens: number }> {
		const result = await this.crush.getTokensFromCrushSession(sessionFile);
		return { ...result, actualTokens: result.tokens };
	}

	async countInteractions(sessionFile: string): Promise<number> {
		return this.crush.countCrushInteractions(sessionFile);
	}

	async getModelUsage(sessionFile: string): Promise<ModelUsage> {
		return this.crush.getCrushModelUsage(sessionFile);
	}

	async getMeta(sessionFile: string): Promise<{ title: string | undefined; firstInteraction: string | null; lastInteraction: string | null; workspacePath?: string }> {
		const timestamps: number[] = [];
		const session = await this.crush.readCrushSession(sessionFile);
		let title: string | undefined;
		if (session) {
			title = session.title || undefined;
			if (session.created_at) { timestamps.push(session.created_at * 1000); } // epoch seconds → ms
			if (session.updated_at) { timestamps.push(session.updated_at * 1000); }
		}
		const messages = await this.crush.getCrushMessages(sessionFile);
		for (const msg of messages) {
			if (msg.created_at) { timestamps.push(msg.created_at * 1000); }
			if (msg.finished_at) { timestamps.push(msg.finished_at * 1000); }
		}
		timestamps.sort((a, b) => a - b);
		return {
			title,
			firstInteraction: timestamps.length > 0 ? new Date(timestamps[0]).toISOString() : null,
			lastInteraction: timestamps.length > 0 ? new Date(timestamps[timestamps.length - 1]).toISOString() : null,
		};
	}

	getEditorRoot(sessionFile: string): string {
		return path.dirname(this.crush.getCrushDbPath(sessionFile));
	}

	async buildTurns(sessionFile: string): Promise<{ turns: ChatTurn[]; actualTokens?: number }> {
		const turns: ChatTurn[] = [];
		const messages = await this.crush.getCrushMessages(sessionFile);
		const session = await this.crush.readCrushSession(sessionFile);
		const userMessages = messages.filter(m => m.role === 'user');
		const numTurns = userMessages.length;
		let turnNumber = 0;
		for (let i = 0; i < messages.length; i++) {
			const msg = messages[i];
			if (msg.role !== 'user') { continue; }
			turnNumber++;
			const turnAssistantMsgs: any[] = [];
			for (let j = i + 1; j < messages.length; j++) {
				if (messages[j].role === 'user') { break; }
				if (messages[j].role === 'assistant') { turnAssistantMsgs.push(messages[j]); }
			}
			const userParts: any[] = Array.isArray(msg.parts) ? msg.parts : [];
			const userText = userParts
				.filter(p => p?.type === 'text' && p?.text)
				.map(p => p.text as string)
				.join('\n');
			let assistantText = '';
			const toolCalls: { toolName: string; arguments?: string; result?: string }[] = [];
			let model: string | null = null;
			for (const assistantMsg of turnAssistantMsgs) {
				if (!model) { model = assistantMsg.model || null; }
				const parts: any[] = Array.isArray(assistantMsg.parts) ? assistantMsg.parts : [];
				for (const part of parts) {
					if (part?.type === 'text' && part?.text) {
						assistantText += part.text;
					} else if (part?.type === 'tool_call' && part?.data?.name) {
						toolCalls.push({
							toolName: part.data.name,
							arguments: part.data.arguments ? JSON.stringify(part.data.arguments) : undefined
						});
					}
				}
			}
			const perTurnInput = session?.prompt_tokens && numTurns > 0 ? Math.round(session.prompt_tokens / numTurns) : 0;
			const perTurnOutput = session?.completion_tokens && numTurns > 0 ? Math.round(session.completion_tokens / numTurns) : 0;
			turns.push({
				turnNumber,
				timestamp: msg.created_at ? new Date(msg.created_at * 1000).toISOString() : null,
				mode: 'agent',
				userMessage: userText,
				assistantResponse: assistantText,
				model,
				toolCalls,
				contextReferences: createEmptyContextRefs(),
				mcpTools: [],
				inputTokensEstimate: perTurnInput,
				outputTokensEstimate: perTurnOutput,
				thinkingTokensEstimate: 0
			});
		}
		return { turns };
	}
}
