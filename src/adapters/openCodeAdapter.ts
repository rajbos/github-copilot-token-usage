import * as fs from 'fs';
import * as path from 'path';
import type { ModelUsage, ChatTurn } from '../types';
import type { IEcosystemAdapter, IDiscoverableEcosystem, IAnalyzableEcosystem, DiscoveryResult, CandidatePath, UsageAnalysisAdapterContext } from '../ecosystemAdapter';
import { OpenCodeDataAccess } from '../opencode';
import { createEmptyContextRefs } from '../tokenEstimation';
import { createEmptySessionUsageAnalysis, applyModelTierClassification } from '../usageAnalysis';
import { withErrorRecovery } from '../utils/errors';
import { pathExists } from '../utils/fsAsync';
import { readTextFileWithSizeGuard } from '../utils/safeFileRead';

export class OpenCodeAdapter implements IEcosystemAdapter, IDiscoverableEcosystem, IAnalyzableEcosystem {
	readonly id = 'opencode';
	readonly displayName = 'OpenCode';

	constructor(private readonly openCode: OpenCodeDataAccess) {}

	handles(sessionFile: string): boolean {
		return this.openCode.isOpenCodeSessionFile(sessionFile);
	}

	getBackingPath(sessionFile: string): string {
		if (this.openCode.isOpenCodeDbSession(sessionFile)) {
			return path.join(this.openCode.getOpenCodeDataDir(), 'opencode.db');
		}
		return sessionFile;
	}

	async stat(sessionFile: string): Promise<fs.Stats> {
		return this.openCode.statSessionFile(sessionFile);
	}

	async getTokens(sessionFile: string): Promise<{ tokens: number; thinkingTokens: number; actualTokens: number }> {
		const result = await this.openCode.getTokensFromOpenCodeSession(sessionFile);
		return { ...result, actualTokens: result.tokens };
	}

	async countInteractions(sessionFile: string): Promise<number> {
		return this.openCode.countOpenCodeInteractions(sessionFile);
	}

	async getModelUsage(sessionFile: string): Promise<ModelUsage> {
		return this.openCode.getOpenCodeModelUsage(sessionFile);
	}

	async getMeta(sessionFile: string): Promise<{ title: string | undefined; firstInteraction: string | null; lastInteraction: string | null; workspacePath?: string }> {
		const timestamps: number[] = [];
		let title: string | undefined;
		let workspacePath: string | undefined;

		const session = await this.readOpenCodeSessionData(sessionFile);
		if (session) {
			title = session.title || session.slug;
			workspacePath = session.directory || undefined;
			if (session.time?.created) { timestamps.push(session.time.created); }
			if (session.time?.updated) { timestamps.push(session.time.updated); }
		}

		const messages = await this.openCode.getOpenCodeMessagesForSession(sessionFile);
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

	async getLastActivity(sessionFile: string): Promise<Date | null> {
		const session = await this.readOpenCodeSessionData(sessionFile);
		const ms = session?.time?.updated ?? session?.time?.created;
		return typeof ms === 'number' ? new Date(ms) : null;
	}

	private async readOpenCodeSessionData(sessionFile: string): Promise<any> {
		const sessionId = this.openCode.getOpenCodeSessionId(sessionFile);
		if (this.openCode.isOpenCodeDbSession(sessionFile) && sessionId) {
			return this.openCode.readOpenCodeDbSession(sessionId);
		}
		return withErrorRecovery(
			async () => {
				const content = await readTextFileWithSizeGuard(sessionFile, 'openCodeAdapter');
				return content === undefined ? null : JSON.parse(content);
			},
			null,
			`openCodeAdapter getMeta readFile(${sessionFile})`
		);
	}

	getEditorRoot(_sessionFile: string): string {
		return this.openCode.getOpenCodeDataDir();
	}

	async discover(log: (msg: string) => void): Promise<DiscoveryResult> {
		const candidatePaths = this.getCandidatePaths();
		const sessionFiles: string[] = [];
		const dataDir = this.openCode.getOpenCodeDataDir();
		const sessionDir = path.join(dataDir, 'storage', 'session');
		const dbPath = path.join(dataDir, 'opencode.db');

		// Scan JSON session files
		log(`📁 Checking OpenCode JSON path: ${sessionDir}`);
		log(`📁 Checking OpenCode DB path: ${dbPath}`);
		const sessionDirExists = await pathExists(sessionDir);
		if (sessionDirExists) {
			const scanDir = async (dir: string) => {
				let entries: fs.Dirent[] = [];
				try {
					entries = await fs.promises.readdir(dir, { withFileTypes: true });
				} catch (err) {
					console.error(`[openCodeAdapter] Failed to read dir ${dir}:`, err);
				}
				for (const entry of entries) {
					if (entry.isDirectory()) {
						await scanDir(path.join(dir, entry.name));
					} else if (entry.name.startsWith('ses_') && entry.name.endsWith('.json')) {
						const fullPath = path.join(dir, entry.name);
						try {
							const stats = await fs.promises.stat(fullPath);
							if (stats.size > 0) { sessionFiles.push(fullPath); }
						} catch (err) {
							console.error(`[openCodeAdapter] Failed to stat ${fullPath}:`, err);
						}
					}
				}
			};
			await scanDir(sessionDir);
			const jsonCount = sessionFiles.length;
			if (jsonCount > 0) {
				log(`📄 Found ${jsonCount} session files in OpenCode storage`);
			}
		}

		// Scan SQLite database for additional sessions (deduplicating against JSON)
		const dbExists = await pathExists(dbPath);
		if (dbExists) {
			try {
				const existingIds = new Set(
					sessionFiles
						.filter(f => this.openCode.isOpenCodeSessionFile(f))
						.map(f => this.openCode.getOpenCodeSessionId(f))
						.filter(Boolean)
				);
				const dbSessionIds = await this.openCode.discoverOpenCodeDbSessions();
				let dbNewCount = 0;
				for (const sessionId of dbSessionIds) {
					if (!existingIds.has(sessionId)) {
						sessionFiles.push(path.join(dataDir, `opencode.db#${sessionId}`));
						dbNewCount++;
					}
				}
				if (dbNewCount > 0) {
					log(`📄 Found ${dbNewCount} additional session(s) in OpenCode database`);
				}
			} catch (err) {
				log(`OpenCode DB exists but could not be read: ${err}`);
			}
		}

		return { sessionFiles, candidatePaths };
	}

	getCandidatePaths(): CandidatePath[] {
		const dataDir = this.openCode.getOpenCodeDataDir();
		return [
			{ path: path.join(dataDir, 'storage', 'session'), source: 'OpenCode (JSON)' },
			{ path: path.join(dataDir, 'opencode.db'), source: 'OpenCode (DB)' },
		];
	}

	async buildTurns(sessionFile: string): Promise<{ turns: ChatTurn[]; actualTokens?: number }> {
		const turns: ChatTurn[] = [];
		const messages = await this.openCode.getOpenCodeMessagesForSession(sessionFile);
		let prevCumulativeTotal = 0;
		let turnNumber = 0;
		for (let i = 0; i < messages.length; i++) {
			const msg = messages[i];
			if (msg.role !== 'user') { continue; }
			turnNumber++;
			const turnAssistantMsgs = messages.filter((m, idx) => idx > i && m.role === 'assistant' && m.parentID === msg.id);
			const userParts = await this.openCode.getOpenCodePartsForMessage(msg.id);
			const userText = userParts.filter(p => p.type === 'text').map(p => p.text || '').join('\n');
			const turnData = await this.processOpenCodeAssistantMessages(turnAssistantMsgs, prevCumulativeTotal);
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

	private async processOpenCodeAssistantMessages(turnAssistantMsgs: any[], prevCumulativeTotal: number): Promise<{
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
			const assistantParts = await this.openCode.getOpenCodePartsForMessage(assistantMsg.id);
			for (const part of assistantParts) {
				assistantText += this.processOpenCodePart(part, toolCalls);
			}
		}
		const turnOutputAndThinking = turnAssistantMsgs.reduce((sum, m) => sum + (m.tokens?.output || 0) + (m.tokens?.reasoning || 0), 0);
		return { assistantText, toolCalls, model, thinkingTokens, turnCumulativeTotal, turnOutputAndThinking };
	}

	private processOpenCodePart(
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
		return this.openCode.getOpenCodeSessionData(sessionFile);
	}

	async analyzeUsage(sessionFile: string, ctx: UsageAnalysisAdapterContext): Promise<import('../types').SessionUsageAnalysis> {
		const analysis = createEmptySessionUsageAnalysis();
		const messages = await this.openCode.getOpenCodeMessagesForSession(sessionFile);
		const models: string[] = [];
		for (const msg of messages) {
			if (msg.role === 'user') { analysis.modeUsage.cli++; }
			if (msg.role === 'assistant') {
				await this.processOpenCodeAssistantMessage(msg, analysis, models);
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

	private async processOpenCodeAssistantMessage(msg: any, analysis: import('../types').SessionUsageAnalysis, models: string[]): Promise<void> {
		models.push(msg.modelID || 'unknown');
		const parts = await this.openCode.getOpenCodePartsForMessage(msg.id);
		for (const part of parts) {
			if (part.type !== 'tool' || !part.tool) { continue; }
			analysis.toolCalls.total++;
			analysis.toolCalls.byTool[part.tool] = (analysis.toolCalls.byTool[part.tool] || 0) + 1;
		}
	}
}
