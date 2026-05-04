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
		const result = this.geminiCli.getTokensFromGeminiCliSession(sessionFile);
		return { ...result, actualTokens: result.tokens };
	}

	async countInteractions(sessionFile: string): Promise<number> {
		return Promise.resolve(this.geminiCli.countGeminiCliInteractions(sessionFile));
	}

	async getModelUsage(sessionFile: string): Promise<ModelUsage> {
		return Promise.resolve(this.geminiCli.getGeminiCliModelUsage(sessionFile));
	}

	async getMeta(sessionFile: string): Promise<{ title: string | undefined; firstInteraction: string | null; lastInteraction: string | null; workspacePath?: string }> {
		return Promise.resolve(this.geminiCli.getGeminiCliSessionMeta(sessionFile));
	}

	getEditorRoot(_sessionFile: string): string {
		return this.geminiCli.getGeminiDataDir();
	}

	async discover(log: (msg: string) => void): Promise<DiscoveryResult> {
		const candidatePaths = this.getCandidatePaths();
		const sessionFiles: string[] = [];

		try {
			const files = this.geminiCli.getGeminiCliSessionFiles();
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
		return Promise.resolve(this.geminiCli.buildGeminiCliTurns(sessionFile));
	}

	async getDailyFractions(sessionFile: string): Promise<Record<string, number>> {
		return Promise.resolve(this.geminiCli.getGeminiCliDailyFractions(sessionFile));
	}

	async analyzeUsage(sessionFile: string, ctx: UsageAnalysisAdapterContext): Promise<import('../types').SessionUsageAnalysis> {
		const analysis = createEmptySessionUsageAnalysis();
		const session = this.geminiCli.readGeminiCliSession(sessionFile);
		const models: string[] = [];

		analysis.modeUsage.cli += session.userRecords.length;

		for (const assistant of session.assistantRecords) {
			const model = normalizeGeminiModelId(assistant.model || 'unknown');
			models.push(model);

			for (const toolCall of Array.isArray(assistant.toolCalls) ? assistant.toolCalls : []) {
				const toolName = typeof toolCall?.name === 'string' && toolCall.name.trim().length > 0
					? toolCall.name.trim()
					: typeof toolCall?.displayName === 'string' && toolCall.displayName.trim().length > 0
						? toolCall.displayName.trim()
						: '';
				if (!toolName) {
					continue;
				}

				analysis.toolCalls.total++;
				analysis.toolCalls.byTool[toolName] = (analysis.toolCalls.byTool[toolName] || 0) + 1;
			}
		}

		const uniqueModels = [...new Set(models)];
		analysis.modelSwitching.uniqueModels = uniqueModels;
		analysis.modelSwitching.modelCount = uniqueModels.length;
		analysis.modelSwitching.totalRequests = models.length;

		let switchCount = 0;
		for (let index = 1; index < models.length; index++) {
			if (models[index] !== models[index - 1]) {
				switchCount++;
			}
		}
		analysis.modelSwitching.switchCount = switchCount;
		applyModelTierClassification(ctx.modelPricing, uniqueModels, models, analysis);

		return analysis;
	}
}
