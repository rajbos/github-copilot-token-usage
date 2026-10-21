import * as fs from 'fs';
import type { ChatTurn, ModelUsage } from '../types';
import type {
	CandidatePath,
	DiscoveryResult,
	IAnalyzableEcosystem,
	IDiscoverableEcosystem,
	IEcosystemAdapter,
	UsageAnalysisAdapterContext,
} from '../ecosystemAdapter';
import {
	GeminiCliDataAccess,
	normalizeGeminiModelId,
} from '../geminicli';
import { createEmptySessionUsageAnalysis, applyModelTierClassification } from '../usageAnalysis';

export class GeminiCliAdapter implements IEcosystemAdapter, IDiscoverableEcosystem, IAnalyzableEcosystem {
	readonly id = 'geminicli';
	readonly reportsCacheReads = true;
	readonly displayName = 'Gemini CLI';

	constructor(private readonly geminiCli: GeminiCliDataAccess) {}

	handles(sessionFile: string): boolean {
		return this.geminiCli.isGeminiCliSessionFile(sessionFile);
	}

	getBackingPath(sessionFile: string): string {
		return sessionFile;
	}

	async stat(sessionFile: string): Promise<fs.Stats> {
		return fs.promises.stat(sessionFile);
	}

	async getTokens(sessionFile: string): Promise<{ tokens: number; thinkingTokens: number; actualTokens: number }> {
		const result = await this.geminiCli.getTokensFromGeminiCliSession(sessionFile);
		return { ...result, actualTokens: result.tokens };
	}

	async countInteractions(sessionFile: string): Promise<number> {
		return await this.geminiCli.countGeminiCliInteractions(sessionFile);
	}

	async getModelUsage(sessionFile: string): Promise<ModelUsage> {
		return await this.geminiCli.getGeminiCliModelUsage(sessionFile);
	}

	async getMeta(sessionFile: string): Promise<{ title: string | undefined; firstInteraction: string | null; lastInteraction: string | null; workspacePath?: string }> {
		return await this.geminiCli.getGeminiCliSessionMeta(sessionFile);
	}

	getEditorRoot(_sessionFile: string): string {
		return this.geminiCli.getGeminiDataDir();
	}

	async discover(log: (msg: string) => void): Promise<DiscoveryResult> {
		const candidatePaths = this.getCandidatePaths();
		const sessionFiles: string[] = [];

		try {
			const files = await this.geminiCli.getGeminiCliSessionFiles();
			if (files.length > 0) {
				log(`📄 Found ${files.length} session file(s) in Gemini CLI (~/.gemini/tmp/*/chats)`);
				sessionFiles.push(...files);
			}
		} catch (error) {
			log(`Could not read Gemini CLI session files: ${error}`);
		}

		return { sessionFiles, candidatePaths };
	}

	getCandidatePaths(): CandidatePath[] {
		return [
			{ path: this.geminiCli.getGeminiTmpDir(), source: 'Gemini CLI (sessions)' },
			{ path: this.geminiCli.getGeminiProjectsPath(), source: 'Gemini CLI (projects.json)' },
			{ path: this.geminiCli.getGeminiLogsPath(), source: 'Gemini CLI (logs.json)' },
		];
	}

	async buildTurns(sessionFile: string): Promise<{ turns: ChatTurn[]; actualTokens?: number }> {
		return await this.geminiCli.buildGeminiCliTurns(sessionFile);
	}

	async getDailyFractions(sessionFile: string): Promise<Record<string, number>> {
		return await this.geminiCli.getGeminiCliDailyFractions(sessionFile);
	}

	async analyzeUsage(sessionFile: string, ctx: UsageAnalysisAdapterContext): Promise<import('../types').SessionUsageAnalysis> {
		const analysis = createEmptySessionUsageAnalysis();
		const session = await this.geminiCli.readGeminiCliSession(sessionFile);
		const models: string[] = [];

		analysis.modeUsage.cli += session.userRecords.length;

		for (const assistant of session.assistantRecords) {
			this.processGeminiAssistantRecord(assistant, analysis, models);
		}

		this.applyGeminiModelSwitchingStats(models, analysis);
		applyModelTierClassification(ctx.modelPricing, analysis.modelSwitching.uniqueModels, models, analysis);

		return analysis;
	}

	private processGeminiAssistantRecord(assistant: any, analysis: import('../types').SessionUsageAnalysis, models: string[]): void {
		const model = normalizeGeminiModelId(assistant.model || 'unknown');
		models.push(model);
		for (const toolCall of (Array.isArray(assistant.toolCalls) ? assistant.toolCalls : [])) {
			const toolName = this.resolveGeminiToolName(toolCall);
			if (!toolName) { continue; }
			analysis.toolCalls.total++;
			analysis.toolCalls.byTool[toolName] = (analysis.toolCalls.byTool[toolName] || 0) + 1;
		}
	}

	private resolveGeminiToolName(toolCall: any): string {
		if (typeof toolCall?.name === 'string' && toolCall.name.trim().length > 0) {
			return toolCall.name.trim();
		}
		if (typeof toolCall?.displayName === 'string' && toolCall.displayName.trim().length > 0) {
			return toolCall.displayName.trim();
		}
		return '';
	}

	private applyGeminiModelSwitchingStats(models: string[], analysis: import('../types').SessionUsageAnalysis): void {
		const uniqueModels = [...new Set(models)];
		analysis.modelSwitching.uniqueModels = uniqueModels;
		analysis.modelSwitching.modelCount = uniqueModels.length;
		analysis.modelSwitching.totalRequests = models.length;
		let switchCount = 0;
		for (let i = 1; i < models.length; i++) {
			if (models[i] !== models[i - 1]) { switchCount++; }
		}
		analysis.modelSwitching.switchCount = switchCount;
	}
}
