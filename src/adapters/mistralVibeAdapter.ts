import * as fs from 'fs';
import type { ModelUsage, ChatTurn } from '../types';
import type { IEcosystemAdapter, IDiscoverableEcosystem, IAnalyzableEcosystem, DiscoveryResult, CandidatePath, UsageAnalysisAdapterContext } from '../ecosystemAdapter';
import { MistralVibeDataAccess } from '../mistralvibe';
import { createEmptyContextRefs } from '../tokenEstimation';
import { createEmptySessionUsageAnalysis, applyModelTierClassification } from '../usageAnalysis';

export class MistralVibeAdapter implements IEcosystemAdapter, IDiscoverableEcosystem, IAnalyzableEcosystem {
	readonly id = 'mistralvibe';
	readonly reportsCacheReads = true;
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
		const result = await this.mistralVibe.getTokensFromSession(sessionFile);
		return { ...result, actualTokens: result.tokens };
	}

	async countInteractions(sessionFile: string): Promise<number> {
		return this.mistralVibe.countInteractions(sessionFile);
	}

	async getModelUsage(sessionFile: string): Promise<ModelUsage> {
		return this.mistralVibe.getModelUsage(sessionFile);
	}

	async getMeta(sessionFile: string): Promise<{ title: string | undefined; firstInteraction: string | null; lastInteraction: string | null; workspacePath?: string }> {
		const meta = await this.mistralVibe.getSessionMeta(sessionFile);
		return {
			title: meta.title,
			firstInteraction: meta.firstInteraction,
			lastInteraction: meta.lastInteraction,
		};
	}

	getEditorRoot(_sessionFile: string): string {
		return this.mistralVibe.getSessionLogDir();
	}

	async discover(log: (msg: string) => void): Promise<DiscoveryResult> {
		const candidatePaths = this.getCandidatePaths();
		const sessionFiles: string[] = [];
		try {
			const files = await this.mistralVibe.discoverSessions();
			if (files.length > 0) {
				log(`📄 Found ${files.length} session file(s) in Mistral Vibe (~/.vibe/logs/session)`);
				sessionFiles.push(...files);
			}
		} catch (e) {
			log(`Could not read Mistral Vibe session files: ${e}`);
		}
		return { sessionFiles, candidatePaths };
	}

	getCandidatePaths(): CandidatePath[] {
		return [{ path: this.mistralVibe.getSessionLogDir(), source: 'Mistral Vibe' }];
	}

	async buildTurns(sessionFile: string): Promise<{ turns: ChatTurn[]; actualTokens?: number }> {
		const turns: ChatTurn[] = [];
		const messages = await this.mistralVibe.readSessionMessages(sessionFile);
		const sessionMeta = await this.mistralVibe.getSessionMeta(sessionFile);
		const tokenData = await this.mistralVibe.getTokensFromSession(sessionFile);
		const model: string = sessionMeta.model || 'devstral';
		const userMsgIndices = this.findUserMessageIndices(messages);

		for (let t = 0; t < userMsgIndices.length; t++) {
			const userIdx = userMsgIndices[t];
			const nextUserIdx = t + 1 < userMsgIndices.length ? userMsgIndices[t + 1] : messages.length;
			turns.push(this.buildMistralTurn(messages, userIdx, nextUserIdx, sessionMeta, model, t + 1));
		}

		return { turns, actualTokens: tokenData.tokens };
	}

	private findUserMessageIndices(messages: any[]): number[] {
		const indices: number[] = [];
		for (let i = 0; i < messages.length; i++) {
			if (messages[i].role === 'user' && messages[i].injected !== true) {
				indices.push(i);
			}
		}
		return indices;
	}

	private buildMistralTurn(messages: any[], userIdx: number, nextUserIdx: number, sessionMeta: any, model: string, turnNumber: number): ChatTurn {
		const userMsg = messages[userIdx];
		const userText = typeof userMsg.content === 'string' ? userMsg.content : '';
		const { assistantText, toolCalls } = this.collectMistralTurnContent(messages, userIdx, nextUserIdx);
		return {
			turnNumber,
			timestamp: sessionMeta.firstInteraction,
			mode: 'cli',
			userMessage: userText,
			assistantResponse: assistantText,
			model,
			toolCalls,
			contextReferences: createEmptyContextRefs(),
			mcpTools: [],
			inputTokensEstimate: 0,
			outputTokensEstimate: 0,
			thinkingTokensEstimate: 0
		};
	}

	private collectMistralTurnContent(messages: any[], userIdx: number, nextUserIdx: number): {
		assistantText: string; toolCalls: { toolName: string; arguments?: string; result?: string }[];
	} {
		let assistantText = '';
		const toolCalls: { toolName: string; arguments?: string; result?: string }[] = [];
		for (let j = userIdx + 1; j < nextUserIdx; j++) {
			const msg = messages[j];
			if (msg.role === 'assistant') {
				assistantText += this.processMistralAssistantMsg(msg, toolCalls);
			} else if (msg.role === 'tool') {
				const last = toolCalls[toolCalls.length - 1];
				if (last) { last.result = typeof msg.content === 'string' ? msg.content : undefined; }
			}
		}
		return { assistantText, toolCalls };
	}

	private processMistralAssistantMsg(
		msg: any,
		toolCalls: { toolName: string; arguments?: string; result?: string }[]
	): string {
		let text = '';
		if (typeof msg.content === 'string') { text = msg.content; }
		for (const tc of (Array.isArray(msg.tool_calls) ? msg.tool_calls : [])) {
			toolCalls.push({
				toolName: tc.function?.name || tc.name || 'unknown',
				arguments: tc.function?.arguments ? JSON.stringify(tc.function.arguments) : undefined
			});
		}
		return text;
	}

	async analyzeUsage(sessionFile: string, ctx: UsageAnalysisAdapterContext): Promise<import('../types').SessionUsageAnalysis> {
		const analysis = createEmptySessionUsageAnalysis();
		const messages = await this.mistralVibe.readSessionMessages(sessionFile);
		const meta = await this.mistralVibe.getSessionMeta(sessionFile);
		const model = meta.model || 'devstral';
		const models: string[] = [];
		for (const msg of messages) {
			if (msg.role === 'user' && msg.injected !== true) {
				analysis.modeUsage.cli++;
			} else if (msg.role === 'assistant') {
				models.push(model);
				if (Array.isArray(msg.tool_calls)) {
					for (const tc of msg.tool_calls) {
						analysis.toolCalls.total++;
						const toolName = String(tc.function?.name || tc.name || 'tool');
						analysis.toolCalls.byTool[toolName] = (analysis.toolCalls.byTool[toolName] || 0) + 1;
					}
				}
			}
		}
		const uniqueModels = [...new Set(models)];
		analysis.modelSwitching.uniqueModels = uniqueModels;
		analysis.modelSwitching.modelCount = uniqueModels.length;
		analysis.modelSwitching.totalRequests = models.length;
		analysis.modelSwitching.switchCount = 0;
		applyModelTierClassification(ctx.modelPricing, uniqueModels, models, analysis);
		return analysis;
	}
}
