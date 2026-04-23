import * as fs from 'fs';
import type { ModelUsage, ChatTurn } from '../types';
import type { IEcosystemAdapter, IDiscoverableEcosystem, IAnalyzableEcosystem, DiscoveryResult, CandidatePath, UsageAnalysisAdapterContext } from '../ecosystemAdapter';
import { ContinueDataAccess } from '../continue';
import { createEmptyContextRefs } from '../tokenEstimation';
import { createEmptySessionUsageAnalysis, applyModelTierClassification } from '../usageAnalysis';

export class ContinueAdapter implements IEcosystemAdapter, IDiscoverableEcosystem, IAnalyzableEcosystem {
	readonly id = 'continue';
	readonly displayName = 'Continue';

	constructor(private readonly continue_: ContinueDataAccess) {}

	handles(sessionFile: string): boolean {
		return this.continue_.isContinueSessionFile(sessionFile);
	}

	getBackingPath(sessionFile: string): string {
		return sessionFile;
	}

	async stat(sessionFile: string): Promise<fs.Stats> {
		return fs.promises.stat(sessionFile);
	}

	async getTokens(sessionFile: string): Promise<{ tokens: number; thinkingTokens: number; actualTokens: number }> {
		const result = this.continue_.getTokensFromContinueSession(sessionFile);
		return { ...result, actualTokens: result.tokens };
	}

	async countInteractions(sessionFile: string): Promise<number> {
		return Promise.resolve(this.continue_.countContinueInteractions(sessionFile));
	}

	async getModelUsage(sessionFile: string): Promise<ModelUsage> {
		return Promise.resolve(this.continue_.getContinueModelUsage(sessionFile));
	}

	async getMeta(sessionFile: string): Promise<{ title: string | undefined; firstInteraction: string | null; lastInteraction: string | null; workspacePath?: string }> {
		const meta = this.continue_.getContinueSessionMeta(sessionFile);
		const sessionId = this.continue_.getContinueSessionId(sessionFile);
		const indexEntry = this.continue_.readSessionsIndex().get(sessionId);
		let firstInteraction: string | null = null;
		let lastInteraction: string | null = null;
		if (indexEntry?.dateCreated) {
			firstInteraction = new Date(indexEntry.dateCreated).toISOString();
			try {
				const fileStat = await fs.promises.stat(sessionFile);
				lastInteraction = fileStat.mtime.toISOString();
			} catch { /* ignore */ }
		}
		let workspacePath: string | undefined;
		if (meta?.workspaceDirectory) {
			try {
				workspacePath = decodeURIComponent(meta.workspaceDirectory.replace(/^file:\/\/\//, '').replace(/^file:\/\//, ''));
			} catch { /* ignore */ }
		}
		return {
			title: meta?.title,
			firstInteraction,
			lastInteraction,
			workspacePath,
		};
	}

	getEditorRoot(_sessionFile: string): string {
		return this.continue_.getContinueDataDir();
	}

	async discover(log: (msg: string) => void): Promise<DiscoveryResult> {
		const candidatePaths = this.getCandidatePaths();
		const sessionFiles: string[] = [];
		try {
			const files = this.continue_.getContinueSessionFiles();
			if (files.length > 0) {
				log(`📄 Found ${files.length} session file(s) in Continue (~/.continue/sessions)`);
				sessionFiles.push(...files);
			}
		} catch (e) {
			log(`Could not read Continue session files: ${e}`);
		}
		return { sessionFiles, candidatePaths };
	}

	getCandidatePaths(): CandidatePath[] {
		return [{ path: this.continue_.getContinueSessionsDir(), source: 'Continue' }];
	}

	async buildTurns(sessionFile: string): Promise<{ turns: ChatTurn[]; actualTokens?: number }> {
		const turns: ChatTurn[] = [];
		const continueTurns = this.continue_.buildContinueTurns(sessionFile);
		const emptyContextRefs = createEmptyContextRefs();
		for (const ct of continueTurns) {
			turns.push({
				turnNumber: turns.length + 1,
				timestamp: null,
				mode: 'ask',
				userMessage: ct.userText,
				assistantResponse: ct.assistantText,
				model: ct.model,
				toolCalls: ct.toolCalls,
				contextReferences: emptyContextRefs,
				mcpTools: [],
				inputTokensEstimate: ct.inputTokens,
				outputTokensEstimate: ct.outputTokens,
				thinkingTokensEstimate: 0
			});
		}
		return { turns };
	}

	async analyzeUsage(sessionFile: string, ctx: UsageAnalysisAdapterContext): Promise<import('../types').SessionUsageAnalysis> {
		const analysis = createEmptySessionUsageAnalysis();
		const turns = this.continue_.buildContinueTurns(sessionFile);
		const meta = this.continue_.getContinueSessionMeta(sessionFile);
		const models: string[] = [];
		for (const turn of turns) {
			analysis.modeUsage.ask++;
			if (turn.model) { models.push(turn.model); }
			for (const tc of turn.toolCalls) {
				analysis.toolCalls.total++;
				analysis.toolCalls.byTool[tc.toolName] = (analysis.toolCalls.byTool[tc.toolName] || 0) + 1;
			}
		}
		if (meta?.mode === 'agent') {
			for (let k = 0; k < turns.length; k++) {
				analysis.modeUsage.ask--;
				analysis.modeUsage.agent++;
			}
		}
		const uniqueModels = [...new Set(models)];
		analysis.modelSwitching.uniqueModels = uniqueModels;
		analysis.modelSwitching.modelCount = uniqueModels.length;
		analysis.modelSwitching.totalRequests = models.length;
		let switchCount = 0;
		for (let ki = 1; ki < models.length; ki++) {
			if (models[ki] !== models[ki - 1]) { switchCount++; }
		}
		analysis.modelSwitching.switchCount = switchCount;
		applyModelTierClassification(ctx.modelPricing, uniqueModels, models, analysis);
		return analysis;
	}
}
