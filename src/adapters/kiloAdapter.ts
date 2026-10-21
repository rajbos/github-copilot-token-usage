import * as fs from 'fs';
import * as path from 'path';
import type { ModelUsage, ChatTurn } from '../types';
import type { IEcosystemAdapter, IDiscoverableEcosystem, IAnalyzableEcosystem, DiscoveryResult, CandidatePath, UsageAnalysisAdapterContext } from '../ecosystemAdapter';
import { KiloDataAccess } from '../kilo';
import { createEmptyContextRefs } from '../tokenEstimation';
import { createEmptySessionUsageAnalysis, applyModelTierClassification } from '../usageAnalysis';
import { pathExists } from '../utils/fsAsync';
import { isUnsafeObjectKey } from '../utils/protoGuard';

export class KiloAdapter implements IEcosystemAdapter, IDiscoverableEcosystem, IAnalyzableEcosystem {
	readonly id = 'kilo';
	readonly reportsCacheReads = true;
	readonly displayName = 'Kilo Code';

	constructor(private readonly kilo: KiloDataAccess) { }

	handles(sessionFile: string): boolean {
		return this.kilo.isKiloSessionFile(sessionFile);
	}

	getBackingPath(sessionFile: string): string {
		// All Kilo Code sessions are DB-backed; the backing file is kilo.db itself.
		return this.kilo.getKiloDbPath();
	}

	async stat(sessionFile: string): Promise<fs.Stats> {
		return this.kilo.statSessionFile(sessionFile);
	}

	async getTokens(sessionFile: string): Promise<{ tokens: number; thinkingTokens: number; actualTokens: number }> {
		const result = await this.kilo.getTokensFromKiloSession(sessionFile);
		return { ...result, actualTokens: result.tokens };
	}

	async countInteractions(sessionFile: string): Promise<number> {
		return this.kilo.countKiloInteractions(sessionFile);
	}

	async getModelUsage(sessionFile: string): Promise<ModelUsage> {
		return this.kilo.getKiloModelUsage(sessionFile);
	}

	async getMeta(sessionFile: string): Promise<{ title: string | undefined; firstInteraction: string | null; lastInteraction: string | null; workspacePath?: string }> {
		const timestamps: number[] = [];
		let title: string | undefined;
		let workspacePath: string | undefined;

		const session = await this.readKiloSessionData(sessionFile);
		if (session) {
			title = session.title || session.slug;
			workspacePath = session.directory || undefined;
			if (session.time?.created) { timestamps.push(session.time.created); }
			if (session.time?.updated) { timestamps.push(session.time.updated); }
		}

		const messages = await this.kilo.getKiloMessagesForSession(sessionFile);
		for (const msg of messages) {
			if (msg.time?.created) { timestamps.push(msg.time.created); }
			if (msg.time?.completed) { timestamps.push(msg.time.completed); }
		}

		timestamps.sort((a, b) => a - b);
		return {
			title,
			firstInteraction: timestamps.length > 0 ? new Date(timestamps[0]).toISOString() : null,
			lastInteraction: timestamps.length > 0 ? new Date(timestamps[timestamps.length - 1]).toISOString() : null,
			workspacePath,
		};
	}

	private async readKiloSessionData(sessionFile: string): Promise<any> {
		const sessionId = this.kilo.getKiloSessionId(sessionFile);
		if (!sessionId) { return null; }
		return this.kilo.readKiloDbSession(sessionId);
	}

	getEditorRoot(_sessionFile: string): string {
		return this.kilo.getKiloDataDir();
	}

	async discover(log: (msg: string) => void): Promise<DiscoveryResult> {
		const candidatePaths = this.getCandidatePaths();
		const sessionFiles: string[] = [];
		const dataDir = this.kilo.getKiloDataDir();
		const dbPath = this.kilo.getKiloDbPath();

		// All Kilo Code sessions live in the SQLite database.
		log(`📁 Checking Kilo Code DB path: ${dbPath}`);
		const dbExists = await pathExists(dbPath);
		if (dbExists) {
			try {
				const dbSessionIds = await this.kilo.discoverKiloDbSessions();
				for (const sessionId of dbSessionIds) {
					sessionFiles.push(path.join(dataDir, `kilo.db#${sessionId}`));
				}
				if (dbSessionIds.length > 0) {
					log(`📄 Found ${dbSessionIds.length} session(s) in Kilo Code database`);
				}
			} catch (err) {
				log(`Kilo Code DB exists but could not be read: ${err}`);
			}
		}

		return { sessionFiles, candidatePaths };
	}

	getCandidatePaths(): CandidatePath[] {
		return [
			{ path: this.kilo.getKiloDbPath(), source: 'Kilo Code (DB)' },
		];
	}

	async buildTurns(sessionFile: string): Promise<{ turns: ChatTurn[]; actualTokens?: number }> {
		const turns: ChatTurn[] = [];
		const messages = await this.kilo.getKiloMessagesForSession(sessionFile);
		let prevCumulativeTotal = 0;
		let turnNumber = 0;
		for (let i = 0; i < messages.length; i++) {
			const msg = messages[i];
			if (msg.role !== 'user') { continue; }
			turnNumber++;
			const turnAssistantMsgs = messages.filter((m, idx) => idx > i && m.role === 'assistant' && m.parentID === msg.id);
			const userParts = await this.kilo.getKiloPartsForMessage(msg.id);
			const userText = userParts.filter(p => p.type === 'text').map(p => p.text || '').join('\n');
			const turnData = await this.processKiloAssistantMessages(turnAssistantMsgs, prevCumulativeTotal);
			const turnInputTokens = Math.max(0, (turnData.turnCumulativeTotal - prevCumulativeTotal) - turnData.turnOutputAndThinking);
			turns.push({
				turnNumber,
				timestamp: msg.time?.created ? new Date(msg.time.created).toISOString() : null,
				mode: 'cli',
				userMessage: userText,
				assistantResponse: turnData.assistantText,
				model: turnData.model,
				toolCalls: turnData.toolCalls,
				contextReferences: createEmptyContextRefs(),
				mcpTools: [],
				inputTokensEstimate: turnInputTokens,
				outputTokensEstimate: turnData.turnOutputAndThinking - turnData.thinkingTokens,
				thinkingTokensEstimate: turnData.thinkingTokens
			});
			prevCumulativeTotal = turnData.turnCumulativeTotal;
		}
		return { turns };
	}

	private async processKiloAssistantMessages(turnAssistantMsgs: any[], prevCumulativeTotal: number): Promise<{
		assistantText: string; toolCalls: { toolName: string; arguments?: string; result?: string }[];
		model: string | null; thinkingTokens: number; turnCumulativeTotal: number; turnOutputAndThinking: number;
	}> {
		let assistantText = '';
		const toolCalls: { toolName: string; arguments?: string; result?: string }[] = [];
		let model: string | null = null;
		let thinkingTokens = 0;
		let turnCumulativeTotal = prevCumulativeTotal;
		for (const assistantMsg of turnAssistantMsgs) {
			if (!model) { model = assistantMsg.modelID || assistantMsg.model?.modelID || null; }
			thinkingTokens += assistantMsg.tokens?.reasoning || 0;
			if (typeof assistantMsg.tokens?.total === 'number') {
				turnCumulativeTotal = Math.max(turnCumulativeTotal, assistantMsg.tokens.total);
			}
			const assistantParts = await this.kilo.getKiloPartsForMessage(assistantMsg.id);
			for (const part of assistantParts) {
				assistantText += this.processKiloPart(part, toolCalls);
			}
		}
		const turnOutputAndThinking = turnAssistantMsgs.reduce((sum, m) => sum + (m.tokens?.output || 0) + (m.tokens?.reasoning || 0), 0);
		return { assistantText, toolCalls, model, thinkingTokens, turnCumulativeTotal, turnOutputAndThinking };
	}

	private processKiloPart(
		part: any,
		toolCalls: { toolName: string; arguments?: string; result?: string }[]
	): string {
		if (part.type === 'text' && part.text) { return part.text as string; }
		if (part.type === 'tool' && part.tool) {
			toolCalls.push({
				toolName: part.tool,
				arguments: part.state?.input ? JSON.stringify(part.state.input) : undefined,
				result: part.state?.output || undefined
			});
		}
		return '';
	}

	async getSyncData(sessionFile: string): Promise<{ tokens: number; interactions: number; modelUsage: ModelUsage; timestamp: number }> {
		return this.kilo.getKiloSessionData(sessionFile);
	}

	async analyzeUsage(sessionFile: string, ctx: UsageAnalysisAdapterContext): Promise<import('../types').SessionUsageAnalysis> {
		const analysis = createEmptySessionUsageAnalysis();
		const messages = await this.kilo.getKiloMessagesForSession(sessionFile);
		const models: string[] = [];
		for (const msg of messages) {
			if (msg.role === 'user') { analysis.modeUsage.cli++; }
			if (msg.role === 'assistant') {
				await this.processKiloAssistantMessage(msg, analysis, models);
			}
		}
		if (models.length > 0) {
			const uniqueModels = [...new Set(models)];
			analysis.modelSwitching.uniqueModels = uniqueModels;
			analysis.modelSwitching.modelCount = uniqueModels.length;
			analysis.modelSwitching.totalRequests = models.length;
			let switchCount = 0;
			for (let i = 1; i < models.length; i++) {
				if (models[i] !== models[i - 1]) { switchCount++; }
			}
			analysis.modelSwitching.switchCount = switchCount;
			applyModelTierClassification(ctx.modelPricing, uniqueModels, models, analysis);
		}
		return analysis;
	}

	private async processKiloAssistantMessage(msg: any, analysis: import('../types').SessionUsageAnalysis, models: string[]): Promise<void> {
		models.push(msg.modelID || 'unknown');
		const parts = await this.kilo.getKiloPartsForMessage(msg.id);
		for (const part of parts) {
			if (part.type !== 'tool' || !part.tool) { continue; }
			if (typeof part.tool !== 'string' || isUnsafeObjectKey(part.tool)) { continue; }
			analysis.toolCalls.total++;
			analysis.toolCalls.byTool[part.tool] = (analysis.toolCalls.byTool[part.tool] || 0) + 1;
		}
	}
}
