import * as fs from 'fs';
import * as path from 'path';
import { decodeMulti } from '@msgpack/msgpack';
import type { ModelUsage, ChatTurn } from '../types';
import type { IEcosystemAdapter, IDiscoverableEcosystem, IAnalyzableEcosystem, DiscoveryResult, CandidatePath, UsageAnalysisAdapterContext } from '../ecosystemAdapter';
import { VisualStudioDataAccess } from '../visualstudio';
import { createEmptyContextRefs } from '../tokenEstimation';
import { isMcpTool, normalizeMcpToolName, extractMcpServerName, normalizePathForComparison } from '../workspaceHelpers';
import { createEmptySessionUsageAnalysis, applyModelTierClassification } from '../usageAnalysis';

export class VisualStudioAdapter implements IEcosystemAdapter, IDiscoverableEcosystem, IAnalyzableEcosystem {
	readonly id = 'visualstudio';
	readonly displayName = 'Visual Studio';

	constructor(
		private readonly visualStudio: VisualStudioDataAccess,
		private readonly estimateTokens: (text: string, model?: string) => number
	) {}

	handles(sessionFile: string): boolean {
		return this.visualStudio.isVSSessionFile(sessionFile);
	}

	getDisplayName(sessionFile: string): string {
		const n = normalizePathForComparison(sessionFile);
		return n.includes('/ssmsgithubcopilot/') ? 'SSMS' : 'Visual Studio';
	}

	getBackingPath(sessionFile: string): string {
		return sessionFile;
	}

	async stat(sessionFile: string): Promise<fs.Stats> {
		return this.visualStudio.statSessionFile(sessionFile);
	}

	async getTokens(sessionFile: string): Promise<{ tokens: number; thinkingTokens: number; actualTokens: number }> {
		const result = await this.visualStudio.getTokenEstimates(sessionFile, this.estimateTokens);
		return { ...result, actualTokens: result.tokens };
	}

	async countInteractions(sessionFile: string): Promise<number> {
		const objects = await this.visualStudio.decodeSessionFile(sessionFile);
		return this.visualStudio.countInteractions(objects);
	}

	async getModelUsage(sessionFile: string): Promise<ModelUsage> {
		return this.visualStudio.getModelUsage(sessionFile, this.estimateTokens);
	}

	async getMeta(sessionFile: string): Promise<{ title: string | undefined; firstInteraction: string | null; lastInteraction: string | null; workspacePath?: string }> {
		const objects = await this.visualStudio.decodeSessionFile(sessionFile);
		const title = this.visualStudio.getSessionTitle(objects);
		const ts = this.visualStudio.getSessionTimestamps(objects);
		const timestamps: number[] = [];
		if (ts.timeCreated) { timestamps.push(new Date(ts.timeCreated).getTime()); }
		if (ts.timeUpdated) { timestamps.push(new Date(ts.timeUpdated).getTime()); }
		timestamps.sort((a, b) => a - b);
		return {
			title,
			firstInteraction: timestamps.length > 0 ? new Date(timestamps[0]).toISOString() : null,
			lastInteraction: timestamps.length > 0 ? new Date(timestamps[timestamps.length - 1]).toISOString() : null,
		};
	}

	getEditorRoot(sessionFile: string): string {
		return path.dirname(sessionFile);
	}

	readonly skipBackendSync = true;

	async discover(log: (msg: string) => void): Promise<DiscoveryResult> {
		const candidatePaths = this.getCandidatePaths();
		const sessionFiles: string[] = [];
		try {
			const sessions = await this.visualStudio.discoverSessions();
			if (sessions.length > 0) {
				log(`📄 Found ${sessions.length} session file(s) in Visual Studio Copilot`);
				sessionFiles.push(...sessions);
			}
		} catch (e) {
			log(`Could not read Visual Studio session files: ${e}`);
		}
		return { sessionFiles, candidatePaths };
	}

	getCandidatePaths(): CandidatePath[] {
		return [
			{ path: this.visualStudio.getLogDir(), source: 'Visual Studio (log dir)' },
			{ path: this.visualStudio.getVsAppDataSessionsDir(), source: 'Visual Studio (AppData sessions dir)' },
			{ path: this.visualStudio.getSsmsSessionsDir(), source: 'SSMS (sessions dir)' },
		];
	}

	getRawFileContent(sessionFile: string): string {
		try {
			const buf = fs.readFileSync(sessionFile);
			const objects = buf.length >= 2 ? Array.from(decodeMulti(buf.slice(1)) as Iterable<any>) : [];
			const readable = objects.map((obj: any, i: number) => i === 0 ? obj : obj?.[1] ?? obj);
			return JSON.stringify(readable, null, 2);
		} catch {
			return '[]';
		}
	}

	async buildTurns(sessionFile: string): Promise<{ turns: ChatTurn[]; actualTokens?: number }> {
		const turns: ChatTurn[] = [];
		const objects = await this.visualStudio.decodeSessionFile(sessionFile);
		let turnNumber = 0;
		for (let i = 1; i < objects.length; i += 2) {
			const req = objects[i];
			const res = objects[i + 1];
			if (!req) { continue; }
			turnNumber++;
			turns.push(this.buildVSTurn(req, res, turnNumber));
		}
		return { turns };
	}

	private buildVSTurn(req: any, res: any, turnNumber: number): ChatTurn {
		const reqData = req[1];
		const resData = res?.[1];
		const userText = this.visualStudio.extractTextFromContent(reqData?.Content || []);
		const assistantText = res ? this.visualStudio.extractTextFromContent(resData?.Content || []) : '';
		const model = this.visualStudio.getModelId(resData ?? reqData, !resData);
		const contextText = this.visualStudio.extractContextText(reqData?.Context);
		const inputTokens = this.estimateTokens(userText + contextText, model ?? 'gpt-4');
		const outputTokens = res ? this.estimateTokens(assistantText, model ?? 'gpt-4') : 0;
		return {
			turnNumber,
			timestamp: reqData?.Timestamp ? new Date(reqData.Timestamp).toISOString() : null,
			mode: 'ask' as const,
			userMessage: userText,
			assistantResponse: assistantText,
			model,
			toolCalls: this.extractVSToolCalls(resData),
			contextReferences: createEmptyContextRefs(),
			mcpTools: [],
			inputTokensEstimate: inputTokens,
			outputTokensEstimate: outputTokens,
			thinkingTokensEstimate: 0
		};
	}

	private extractVSToolCalls(resData: any): { toolName: string; arguments?: string; result?: string }[] {
		const toolCalls: { toolName: string; arguments?: string; result?: string }[] = [];
		for (const c of (resData?.Content || [])) {
			const inner = Array.isArray(c) ? c[1] : null;
			if (inner?.Function) {
				toolCalls.push({
					toolName: String(inner.Function.Description || 'tool'),
					result: typeof inner.Function.Result === 'string' ? inner.Function.Result : undefined
				});
			}
		}
		return toolCalls;
	}

	async analyzeUsage(sessionFile: string, ctx: UsageAnalysisAdapterContext): Promise<import('../types').SessionUsageAnalysis> {
		const analysis = createEmptySessionUsageAnalysis();
		const objects = await this.visualStudio.decodeSessionFile(sessionFile);
		const models: string[] = [];
		for (let i = 1; i < objects.length; i++) {
			const isRequest = i % 2 === 1;
			if (isRequest) {
				analysis.modeUsage.ask++;
			} else {
				this.processVSResponseObject(objects[i]?.[1], analysis, models, ctx);
			}
		}
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

	private processVSResponseObject(objData: any, analysis: import('../types').SessionUsageAnalysis, models: string[], ctx: UsageAnalysisAdapterContext): void {
		const model = this.visualStudio.getModelId(objData, false);
		if (model) { models.push(model); }
		for (const c of ((objData?.Content ?? []) as any[])) {
			const inner: any = Array.isArray(c) ? c[1] : null;
			if (!inner?.Function) { continue; }
			analysis.toolCalls.total++;
			const toolName = String(inner.Function.Name || inner.Function.Description || 'tool');
			if (isMcpTool(toolName)) {
				analysis.mcpTools.total++;
				const serverName = extractMcpServerName(toolName, ctx.toolNameMap);
				analysis.mcpTools.byServer[serverName] = (analysis.mcpTools.byServer[serverName] || 0) + 1;
				const normalizedTool = normalizeMcpToolName(toolName);
				analysis.mcpTools.byTool[normalizedTool] = (analysis.mcpTools.byTool[normalizedTool] || 0) + 1;
				analysis.toolCalls.total--;
			} else {
				analysis.toolCalls.byTool[toolName] = (analysis.toolCalls.byTool[toolName] || 0) + 1;
			}
		}
	}
}
