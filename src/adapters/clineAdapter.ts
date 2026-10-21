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
import { ClineDataAccess } from '../cline';
import type { ClineTurn } from '../cline';
import { createEmptyContextRefs } from '../tokenEstimation';
import { createEmptySessionUsageAnalysis, applyModelTierClassification } from '../usageAnalysis';

/**
 * Ecosystem adapter for the Cline VS Code extension (saoudrizwan.claude-dev).
 * Sessions are per-task folders under the host editor's globalStorage; the
 * canonical session file is each task's ui_messages.json. Token counts are
 * REAL API counts recorded by Cline per request (api_req_started messages),
 * with authoritative per-task totals in state/taskHistory.json as fallback.
 */
export class ClineAdapter implements IEcosystemAdapter, IDiscoverableEcosystem, IAnalyzableEcosystem {
	readonly id = 'cline';
	readonly reportsCacheReads = true;
	readonly displayName = 'Cline';

	constructor(private readonly cline: ClineDataAccess) {}

	handles(sessionFile: string): boolean {
		return this.cline.isClineSessionFile(sessionFile);
	}

	getBackingPath(sessionFile: string): string {
		return sessionFile;
	}

	async stat(sessionFile: string): Promise<fs.Stats> {
		return fs.promises.stat(sessionFile);
	}

	async getTokens(sessionFile: string): Promise<{ tokens: number; thinkingTokens: number; actualTokens: number }> {
		const result = await this.cline.getTokensFromClineSession(sessionFile);
		// Cline records real API token counts, so actualTokens equals tokens.
		return { ...result, actualTokens: result.tokens };
	}

	async countInteractions(sessionFile: string): Promise<number> {
		return await this.cline.countClineInteractions(sessionFile);
	}

	async getModelUsage(sessionFile: string): Promise<ModelUsage> {
		return await this.cline.getClineModelUsage(sessionFile);
	}

	async getMeta(sessionFile: string): Promise<{ title: string | undefined; firstInteraction: string | null; lastInteraction: string | null; workspacePath?: string }> {
		return await this.cline.getClineSessionMeta(sessionFile);
	}

	getEditorRoot(sessionFile: string): string {
		return this.cline.getClineRootFromSessionFile(sessionFile);
	}

	async discover(log: (msg: string) => void): Promise<DiscoveryResult> {
		const candidatePaths = this.getCandidatePaths();
		const sessionFiles: string[] = [];
		try {
			const files = await this.cline.getClineSessionFiles();
			if (files.length > 0) {
				log(`📄 Found ${files.length} session file(s) in Cline (saoudrizwan.claude-dev/tasks)`);
				sessionFiles.push(...files);
			}
		} catch (error) {
			log(`Could not read Cline session files: ${error}`);
		}
		return { sessionFiles, candidatePaths };
	}

	getCandidatePaths(): CandidatePath[] {
		return this.cline.getClineTasksDirs().map(dir => ({ path: dir, source: 'Cline' }));
	}

	async buildTurns(sessionFile: string): Promise<{ turns: ChatTurn[]; actualTokens?: number }> {
		const clineTurns = await this.cline.buildClineTurns(sessionFile);
		const tokenResult = await this.cline.getTokensFromClineSession(sessionFile);
		const emptyContextRefs = createEmptyContextRefs();
		const turns: ChatTurn[] = clineTurns.map((turn, index) => ({
			turnNumber: index + 1,
			timestamp: turn.timestampMs !== null ? new Date(turn.timestampMs).toISOString() : null,
			mode: this.toChatMode(turn),
			userMessage: turn.userText,
			assistantResponse: turn.assistantText,
			model: turn.model,
			toolCalls: turn.toolCalls,
			contextReferences: emptyContextRefs,
			mcpTools: turn.mcpTools,
			inputTokensEstimate: turn.inputTokens,
			outputTokensEstimate: turn.outputTokens,
			thinkingTokensEstimate: 0,
			actualUsage: (turn.inputTokens > 0 || turn.outputTokens > 0)
				? { promptTokens: turn.inputTokens, completionTokens: turn.outputTokens }
				: undefined,
		}));
		return { turns, actualTokens: tokenResult.tokens };
	}

	/** Cline runs in 'act' (agentic) or 'plan' mode. */
	private toChatMode(turn: ClineTurn): ChatTurn['mode'] {
		return turn.mode === 'plan' ? 'plan' : 'agent';
	}

	async getDailyFractions(sessionFile: string): Promise<Record<string, number>> {
		return await this.cline.getClineDailyFractions(sessionFile);
	}

	async analyzeUsage(sessionFile: string, ctx: UsageAnalysisAdapterContext): Promise<import('../types').SessionUsageAnalysis> {
		const analysis = createEmptySessionUsageAnalysis();
		const turns = await this.cline.buildClineTurns(sessionFile);
		for (const turn of turns) {
			if (turn.mode === 'plan') { analysis.modeUsage.plan++; } else { analysis.modeUsage.agent++; }
			for (const toolCall of turn.toolCalls) {
				analysis.toolCalls.total++;
				analysis.toolCalls.byTool[toolCall.toolName] = (analysis.toolCalls.byTool[toolCall.toolName] || 0) + 1;
			}
			for (const mcp of turn.mcpTools) {
				analysis.mcpTools.total++;
				analysis.mcpTools.byServer[mcp.server] = (analysis.mcpTools.byServer[mcp.server] || 0) + 1;
				analysis.mcpTools.byTool[mcp.tool] = (analysis.mcpTools.byTool[mcp.tool] || 0) + 1;
			}
		}
		// Model switching is tracked per API request (each carries its modelInfo).
		const requests = await this.cline.getApiRequests(sessionFile);
		const models = requests.map(r => r.model).filter((m): m is string => !!m);
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
		return analysis;
	}
}
