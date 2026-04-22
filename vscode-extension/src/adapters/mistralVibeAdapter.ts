import * as fs from 'fs';
import type { ModelUsage, ChatTurn } from '../types';
import type { IEcosystemAdapter } from '../ecosystemAdapter';
import { MistralVibeDataAccess } from '../mistralvibe';
import { createEmptyContextRefs } from '../tokenEstimation';

export class MistralVibeAdapter implements IEcosystemAdapter {
	readonly id = 'mistralvibe';
	readonly displayName = 'Mistral Vibe';

	constructor(private readonly mistralVibe: MistralVibeDataAccess) {}

	handles(sessionFile: string): boolean {
		return this.mistralVibe.isVibeSessionFile(sessionFile);
	}

	getBackingPath(sessionFile: string): string {
		return sessionFile;
	}

	async stat(sessionFile: string): Promise<fs.Stats> {
		return fs.promises.stat(sessionFile);
	}

	async getTokens(sessionFile: string): Promise<{ tokens: number; thinkingTokens: number; actualTokens: number }> {
		const result = this.mistralVibe.getTokensFromSession(sessionFile);
		return { ...result, actualTokens: result.tokens };
	}

	async countInteractions(sessionFile: string): Promise<number> {
		return Promise.resolve(this.mistralVibe.countInteractions(sessionFile));
	}

	async getModelUsage(sessionFile: string): Promise<ModelUsage> {
		return Promise.resolve(this.mistralVibe.getModelUsage(sessionFile));
	}

	async getMeta(sessionFile: string): Promise<{ title: string | undefined; firstInteraction: string | null; lastInteraction: string | null; workspacePath?: string }> {
		const meta = this.mistralVibe.getSessionMeta(sessionFile);
		return {
			title: meta.title,
			firstInteraction: meta.firstInteraction,
			lastInteraction: meta.lastInteraction,
		};
	}

	getEditorRoot(_sessionFile: string): string {
		return this.mistralVibe.getSessionLogDir();
	}

	async buildTurns(sessionFile: string): Promise<{ turns: ChatTurn[]; actualTokens?: number }> {
		const turns: ChatTurn[] = [];
		const messages = this.mistralVibe.readSessionMessages(sessionFile);
		const sessionMeta = this.mistralVibe.getSessionMeta(sessionFile);
		const tokenData = this.mistralVibe.getTokensFromSession(sessionFile);
		const model: string = sessionMeta.model || 'devstral';

		const userMsgIndices: number[] = [];
		for (let i = 0; i < messages.length; i++) {
			if (messages[i].role === 'user' && messages[i].injected !== true) {
				userMsgIndices.push(i);
			}
		}

		for (let t = 0; t < userMsgIndices.length; t++) {
			const userIdx = userMsgIndices[t];
			const nextUserIdx = t + 1 < userMsgIndices.length ? userMsgIndices[t + 1] : messages.length;
			const userMsg = messages[userIdx];
			const userText = typeof userMsg.content === 'string' ? userMsg.content : '';
			let assistantText = '';
			const toolCalls: { toolName: string; arguments?: string; result?: string }[] = [];

			for (let j = userIdx + 1; j < nextUserIdx; j++) {
				const msg = messages[j];
				if (msg.role === 'assistant') {
					if (typeof msg.content === 'string') { assistantText += msg.content; }
					if (Array.isArray(msg.tool_calls)) {
						for (const tc of msg.tool_calls) {
							toolCalls.push({
								toolName: tc.function?.name || tc.name || 'unknown',
								arguments: tc.function?.arguments ? JSON.stringify(tc.function.arguments) : undefined
							});
						}
					}
				} else if (msg.role === 'tool') {
					const last = toolCalls[toolCalls.length - 1];
					if (last) { last.result = typeof msg.content === 'string' ? msg.content : undefined; }
				}
			}

			turns.push({
				turnNumber: t + 1,
				timestamp: sessionMeta.firstInteraction,
				mode: 'agent',
				userMessage: userText,
				assistantResponse: assistantText,
				model,
				toolCalls,
				contextReferences: createEmptyContextRefs(),
				mcpTools: [],
				inputTokensEstimate: 0,
				outputTokensEstimate: 0,
				thinkingTokensEstimate: 0
			});
		}

		return { turns, actualTokens: tokenData.tokens };
	}
}
