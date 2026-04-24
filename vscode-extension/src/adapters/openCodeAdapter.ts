import * as fs from 'fs';
import * as path from 'path';
import type { ModelUsage, ChatTurn } from '../types';
import type { IEcosystemAdapter, IDiscoverableEcosystem, IAnalyzableEcosystem, DiscoveryResult, CandidatePath, UsageAnalysisAdapterContext } from '../ecosystemAdapter';
import { OpenCodeDataAccess } from '../opencode';
import { createEmptyContextRefs } from '../tokenEstimation';
import { createEmptySessionUsageAnalysis, applyModelTierClassification } from '../usageAnalysis';

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

		const sessionId = this.openCode.getOpenCodeSessionId(sessionFile);
		let session: any = null;
		if (this.openCode.isOpenCodeDbSession(sessionFile) && sessionId) {
			session = await this.openCode.readOpenCodeDbSession(sessionId);
		} else {
			try {
				const content = await fs.promises.readFile(sessionFile, 'utf8');
				session = JSON.parse(content);
			} catch { /* ignore */ }
		}
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
		try {
			await fs.promises.access(sessionDir);
			const scanDir = async (dir: string) => {
				try {
					const entries = await fs.promises.readdir(dir, { withFileTypes: true });
					for (const entry of entries) {
						if (entry.isDirectory()) {
							await scanDir(path.join(dir, entry.name));
						} else if (entry.name.startsWith('ses_') && entry.name.endsWith('.json')) {
							const fullPath = path.join(dir, entry.name);
							try {
								const stats = await fs.promises.stat(fullPath);
								if (stats.size > 0) { sessionFiles.push(fullPath); }
							} catch { /* ignore */ }
						}
					}
				} catch { /* ignore */ }
			};
			await scanDir(sessionDir);
			const jsonCount = sessionFiles.length;
			if (jsonCount > 0) {
				log(`📄 Found ${jsonCount} session files in OpenCode storage`);
			}
		} catch { /* sessionDir doesn't exist — skip */ }

		// Scan SQLite database for additional sessions (deduplicating against JSON)
		try {
			await fs.promises.access(dbPath);
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
		} catch { /* DB doesn't exist — skip */ }

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
		if (messages.length > 0) {
			let turnNumber = 0;
			let prevCumulativeTotal = 0;
			for (let i = 0; i < messages.length; i++) {
				const msg = messages[i];
				if (msg.role !== 'user') { continue; }
				turnNumber++;
				const turnAssistantMsgs = messages.filter((m, idx) => idx > i && m.role === 'assistant' && m.parentID === msg.id);
				const userParts = await this.openCode.getOpenCodePartsForMessage(msg.id);
				const userText = userParts.filter(p => p.type === 'text').map(p => p.text || '').join('\n');
				let assistantText = '';
				const toolCalls: { toolName: string; arguments?: string; result?: string }[] = [];
				let model: string | null = null;
				let thinkingTokens = 0;

				let turnCumulativeTotal = prevCumulativeTotal;
				for (const assistantMsg of turnAssistantMsgs) {
					if (!model) { model = assistantMsg.modelID || null; }
					thinkingTokens += assistantMsg.tokens?.reasoning || 0;
					if (typeof assistantMsg.tokens?.total === 'number') {
						turnCumulativeTotal = Math.max(turnCumulativeTotal, assistantMsg.tokens.total);
					}
					const assistantParts = await this.openCode.getOpenCodePartsForMessage(assistantMsg.id);
					for (const part of assistantParts) {
						if (part.type === 'text' && part.text) {
							assistantText += part.text;
						} else if (part.type === 'tool' && part.tool) {
							toolCalls.push({
								toolName: part.tool,
								arguments: part.state?.input ? JSON.stringify(part.state.input) : undefined,
								result: part.state?.output || undefined
							});
						}
					}
				}

				const turnTokens = turnCumulativeTotal - prevCumulativeTotal;
				const turnOutputAndThinking = turnAssistantMsgs.reduce((sum, m) => sum + (m.tokens?.output || 0) + (m.tokens?.reasoning || 0), 0);
				const turnInputTokens = Math.max(0, turnTokens - turnOutputAndThinking);

				turns.push({
					turnNumber,
					timestamp: msg.time?.created ? new Date(msg.time.created).toISOString() : null,
					mode: 'cli',
					userMessage: userText,
					assistantResponse: assistantText,
					model,
					toolCalls,
					contextReferences: createEmptyContextRefs(),
					mcpTools: [],
					inputTokensEstimate: turnInputTokens,
					outputTokensEstimate: turnOutputAndThinking - thinkingTokens,
					thinkingTokensEstimate: thinkingTokens
				});

				prevCumulativeTotal = turnCumulativeTotal;
			}
		}
		return { turns };
	}

	async getSyncData(sessionFile: string): Promise<{ tokens: number; interactions: number; modelUsage: ModelUsage; timestamp: number }> {
		return this.openCode.getOpenCodeSessionData(sessionFile);
	}

	async analyzeUsage(sessionFile: string, ctx: UsageAnalysisAdapterContext): Promise<import('../types').SessionUsageAnalysis> {
		const analysis = createEmptySessionUsageAnalysis();
		const messages = await this.openCode.getOpenCodeMessagesForSession(sessionFile);
		if (messages.length > 0) {
			const models: string[] = [];
			for (const msg of messages) {
				if (msg.role === 'user') {
					analysis.modeUsage.cli++;
				}
				if (msg.role === 'assistant') {
					const model = msg.modelID || 'unknown';
					models.push(model);
					const parts = await this.openCode.getOpenCodePartsForMessage(msg.id);
					for (const part of parts) {
						if (part.type === 'tool' && part.tool) {
							analysis.toolCalls.total++;
							const toolName = part.tool;
							analysis.toolCalls.byTool[toolName] = (analysis.toolCalls.byTool[toolName] || 0) + 1;
						}
					}
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
		}
		return analysis;
	}
}
