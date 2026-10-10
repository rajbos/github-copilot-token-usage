import * as fs from 'fs';
import * as path from 'path';
import type { ModelUsage, ChatTurn } from '../types';
import type { IEcosystemAdapter, IDiscoverableEcosystem, IAnalyzableEcosystem, DiscoveryResult, CandidatePath, UsageAnalysisAdapterContext } from '../ecosystemAdapter';
import { CrushDataAccess } from '../crush';
import { createEmptyContextRefs } from '../tokenEstimation';
import { createEmptySessionUsageAnalysis, applyModelTierClassification } from '../usageAnalysis';
import { withErrorRecoverySync } from '../utils/errors';

export class CrushAdapter implements IEcosystemAdapter, IDiscoverableEcosystem, IAnalyzableEcosystem {
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

	async getLastActivity(sessionFile: string): Promise<Date | null> {
		const session = await this.crush.readCrushSession(sessionFile);
		const seconds = session?.updated_at ?? session?.created_at;
		return typeof seconds === 'number' ? new Date(seconds * 1000) : null; // epoch seconds → ms
	}

	getEditorRoot(sessionFile: string): string {
		return path.dirname(this.crush.getCrushDbPath(sessionFile));
	}

	async discover(log: (msg: string) => void): Promise<DiscoveryResult> {
		const candidatePaths = this.getCandidatePaths();
		const sessionFiles: string[] = [];

		try {
			const projects = this.crush.readCrushProjects();
			log(`📁 Crush: found ${projects.length} project(s) in projects.json`);

			const sessionArrays = await Promise.all(
				projects.map(async (project) => {
					const dbPath = path.join(project.data_dir, 'crush.db');
					log(`📁 Checking Crush DB path: ${dbPath}`);
					try {
						await fs.promises.access(dbPath);
						const sessionIds = await this.crush.discoverSessionsInDb(dbPath);
						return sessionIds.map(id => path.join(project.data_dir, `crush.db#${id}`));
					} catch (e) {
						log(`Could not read Crush database for ${project.path}: ${e}`);
					}
					return [] as string[];
				})
			);
			const total = sessionArrays.reduce((sum, arr) => sum + arr.length, 0);
			if (total > 0) {
				log(`📄 Found ${total} session(s) in Crush database(s)`);
			}
			sessionFiles.push(...sessionArrays.flat());
		} catch (e) {
			log(`Could not read Crush projects: ${e}`);
		}

		return { sessionFiles, candidatePaths };
	}

	getCandidatePaths(): CandidatePath[] {
		const configDir = this.crush.getCrushConfigDir();
		const candidates: CandidatePath[] = [
			{ path: path.join(configDir, 'projects.json'), source: 'Crush (projects.json)' },
		];
		const extraPaths = withErrorRecoverySync(
			() => this.crush.readCrushProjects().map(project => ({
				path: path.join(project.data_dir, 'crush.db'),
				source: `Crush (${path.basename(project.path)})`
			})),
			[] as CandidatePath[],
			'crushAdapter getCandidatePaths'
		);
		candidates.push(...extraPaths);
		return candidates;
	}

	async buildTurns(sessionFile: string): Promise<{ turns: ChatTurn[]; actualTokens?: number }> {
		const turns: ChatTurn[] = [];
		const messages = await this.crush.getCrushMessages(sessionFile);
		const session = await this.crush.readCrushSession(sessionFile);
		const numTurns = messages.filter(m => m.role === 'user').length;
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
			turns.push(this.buildCrushTurn(msg, turnAssistantMsgs, session, numTurns, turnNumber));
		}
		return { turns };
	}

	private buildCrushTurn(msg: any, turnAssistantMsgs: any[], session: any, numTurns: number, turnNumber: number): ChatTurn {
		const userParts: any[] = Array.isArray(msg.parts) ? msg.parts : [];
		const userText = userParts
			.filter(p => p?.type === 'text' && p?.text)
			.map(p => p.text as string)
			.join('\n');
		const { assistantText, toolCalls, model } = this.processAssistantMessagesForTurn(turnAssistantMsgs);
		const perTurnInput = session?.prompt_tokens && numTurns > 0 ? Math.round(session.prompt_tokens / numTurns) : 0;
		const perTurnOutput = session?.completion_tokens && numTurns > 0 ? Math.round(session.completion_tokens / numTurns) : 0;
		return {
			turnNumber,
			timestamp: msg.created_at ? new Date(msg.created_at * 1000).toISOString() : null,
			mode: 'cli',
			userMessage: userText,
			assistantResponse: assistantText,
			model,
			toolCalls,
			contextReferences: createEmptyContextRefs(),
			mcpTools: [],
			inputTokensEstimate: perTurnInput,
			outputTokensEstimate: perTurnOutput,
			thinkingTokensEstimate: 0
		};
	}

	private processAssistantMessagesForTurn(turnAssistantMsgs: any[]): {
		assistantText: string; toolCalls: { toolName: string; arguments?: string; result?: string }[]; model: string | null;
	} {
		let assistantText = '';
		const toolCalls: { toolName: string; arguments?: string; result?: string }[] = [];
		let model: string | null = null;
		for (const assistantMsg of turnAssistantMsgs) {
			if (!model) { model = assistantMsg.model || null; }
			for (const part of (Array.isArray(assistantMsg.parts) ? assistantMsg.parts : [])) {
				assistantText += this.processCrushMessagePart(part, toolCalls);
			}
		}
		return { assistantText, toolCalls, model };
	}

	private processCrushMessagePart(
		part: any,
		toolCalls: { toolName: string; arguments?: string; result?: string }[]
	): string {
		if (part?.type === 'text' && part?.text) { return part.text as string; }
		if (part?.type === 'tool_call' && part?.data?.name) {
			toolCalls.push({
				toolName: part.data.name,
				arguments: part.data.arguments ? JSON.stringify(part.data.arguments) : undefined
			});
		}
		return '';
	}

	async getSyncData(sessionFile: string): Promise<{ tokens: number; interactions: number; modelUsage: ModelUsage; timestamp: number }> {
		return this.crush.getCrushSessionData(sessionFile);
	}

	async analyzeUsage(sessionFile: string, ctx: UsageAnalysisAdapterContext): Promise<import('../types').SessionUsageAnalysis> {
		const analysis = createEmptySessionUsageAnalysis();
		const messages = await this.crush.getCrushMessages(sessionFile);
		const models: string[] = [];
		for (const msg of messages) {
			if (msg.role === 'user') { analysis.modeUsage.cli++; }
			if (msg.role === 'assistant') {
				this.processCrushAssistantMessage(msg, analysis, models);
			}
		}
		this.applyCrushModelSwitchingStats(models, analysis);
		applyModelTierClassification(ctx.modelPricing, analysis.modelSwitching.uniqueModels, models, analysis);
		return analysis;
	}

	private processCrushAssistantMessage(msg: any, analysis: import('../types').SessionUsageAnalysis, models: string[]): void {
		models.push(msg.model || 'unknown');
		for (const part of (Array.isArray(msg.parts) ? msg.parts : [])) {
			if (part?.type !== 'tool_call' || !part?.data?.name) { continue; }
			analysis.toolCalls.total++;
			const toolName = part.data.name as string;
			analysis.toolCalls.byTool[toolName] = (analysis.toolCalls.byTool[toolName] || 0) + 1;
		}
	}

	private applyCrushModelSwitchingStats(models: string[], analysis: import('../types').SessionUsageAnalysis): void {
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
