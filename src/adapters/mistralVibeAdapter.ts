import * as fs from 'fs';
import type { ModelUsage, ChatTurn, VendorSessionStats, SessionDurationData } from '../types';
import type { IEcosystemAdapter, IDiscoverableEcosystem, IAnalyzableEcosystem, DiscoveryResult, CandidatePath, UsageAnalysisAdapterContext } from '../ecosystemAdapter';
import { MistralVibeDataAccess, type VibeSessionStats } from '../mistralvibe';
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
		const stats = await this.mistralVibe.getSessionStats(sessionFile);
		const vendorStats = buildVendorStats(stats);
		if (vendorStats) { analysis.vendorStats = vendorStats; }
		const duration = wallClockDuration(meta.firstInteraction, meta.lastInteraction);
		if (duration) { analysis.sessionDuration = duration; }
		return analysis;
	}
}

/**
 * Wall-clock session duration from meta.json `start_time` / `end_time`. Vibe records no per-turn
 * timestamps, so this is the only duration available: it INCLUDES idle gaps between turns and is
 * used as `activeDurationMs` only as a fallback. Undefined when either timestamp is missing,
 * unparseable, or the range is not positive.
 */
function wallClockDuration(start: string | null, end: string | null): SessionDurationData | undefined {
	if (!start || !end) { return undefined; }
	const ms = new Date(end).getTime() - new Date(start).getTime();
	if (!Number.isFinite(ms) || ms <= 0) { return undefined; }
	return { totalDurationMs: ms, avgDurationMs: ms, avgFirstProgressMs: 0, avgTotalElapsedMs: 0, avgWaitTimeMs: 0, activeDurationMs: ms };
}

/** Map the parsed meta.json stats to the additive vendor-stats shape; undefined when none were reported. */
function buildVendorStats(s: VibeSessionStats): VendorSessionStats | undefined {
	const out: VendorSessionStats = {};
	if (s.tokensPerSecond !== undefined) { out.tokensPerSecond = { samples: 1, sum: s.tokensPerSecond }; }
	if (s.lastTurnDurationMs !== undefined) { out.lastTurnDurationMs = { samples: 1, sum: s.lastTurnDurationMs }; }
	if (s.sessionCostReported !== undefined) { out.reportedCostDollars = s.sessionCostReported; }
	if (s.steps !== undefined) { out.steps = s.steps; }
	const outcomes: NonNullable<VendorSessionStats['toolOutcomes']> = {};
	if (s.toolCallsSucceeded !== undefined) { outcomes.succeeded = s.toolCallsSucceeded; }
	if (s.toolCallsFailed !== undefined) { outcomes.failed = s.toolCallsFailed; }
	if (s.toolCallsRejected !== undefined) { outcomes.rejected = s.toolCallsRejected; }
	if (s.toolCallsAgreed !== undefined) { outcomes.agreed = s.toolCallsAgreed; }
	if (s.toolCallsHookDenied !== undefined) { outcomes.hookDenied = s.toolCallsHookDenied; }
	if (Object.keys(outcomes).length > 0) { out.toolOutcomes = outcomes; }
	return Object.keys(out).length > 0 ? out : undefined;
}
