import * as fs from 'fs';
import type { ModelUsage, ChatTurn } from '../types';
import type { IEcosystemAdapter, IDiscoverableEcosystem, IAnalyzableEcosystem, DiscoveryResult, CandidatePath, UsageAnalysisAdapterContext } from '../ecosystemAdapter';
import { ClaudeDesktopDataAccess } from '../claudedesktop';
import { buildClaudeChatTurns, type ClaudeAssistantTurnData } from './claudeTurns';
import { readClaudeCodeEventsForAnalysis, createEmptySessionUsageAnalysis, applyModelTierClassification } from '../usageAnalysis';
import { normalizeClaudeModelId } from '../claudecode';
import { extractClaudeSlashCommand, recordSkillCall, recordInvokedSkillCall, ClaudeToolOutcomeTracker } from './claudeCodeAdapter';

export class ClaudeDesktopAdapter implements IEcosystemAdapter, IDiscoverableEcosystem, IAnalyzableEcosystem {
	readonly id = 'claudedesktop';
	readonly displayName = 'Claude Desktop Cowork';

	constructor(
		private readonly claudeDesktop: ClaudeDesktopDataAccess,
		private readonly isMcpToolFn: (toolName: string) => boolean,
		private readonly extractMcpServerNameFn: (toolName: string) => string,
		private readonly estimateTokensFn: (text: string, model?: string) => number
	) {}

	handles(sessionFile: string): boolean {
		return this.claudeDesktop.isDesktopSessionFile(sessionFile);
	}

	getBackingPath(sessionFile: string): string {
		return sessionFile;
	}

	async stat(sessionFile: string): Promise<fs.Stats> {
		return fs.promises.stat(sessionFile);
	}

	async getTokens(sessionFile: string): Promise<{ tokens: number; thinkingTokens: number; actualTokens: number }> {
		const result = await this.claudeDesktop.getTokensFromDesktopSession(sessionFile);
		return { ...result, actualTokens: result.tokens };
	}

	async countInteractions(sessionFile: string): Promise<number> {
		return await this.claudeDesktop.countDesktopSessionInteractions(sessionFile);
	}

	async getModelUsage(sessionFile: string): Promise<ModelUsage> {
		return await this.claudeDesktop.getDesktopSessionModelUsage(sessionFile);
	}

	async getMeta(sessionFile: string): Promise<{ title: string | undefined; firstInteraction: string | null; lastInteraction: string | null; workspacePath?: string }> {
		const meta = await this.claudeDesktop.getDesktopSessionMeta(sessionFile);
		return {
			title: meta?.title,
			firstInteraction: meta?.firstInteraction || null,
			lastInteraction: meta?.lastInteraction || null,
			workspacePath: meta?.cwd,
		};
	}

	getEditorRoot(sessionFile: string): string {
		return this.claudeDesktop.getSessionDirForFile(sessionFile);
	}

	async discover(log: (msg: string) => void): Promise<DiscoveryResult> {
		const candidatePaths = this.getCandidatePaths();
		const sessionFiles: string[] = [];
		try {
			const files = await this.claudeDesktop.getDesktopSessionFiles();
			if (files.length > 0) {
				log(`📄 Found ${files.length} session file(s) in Claude Desktop Cowork`);
				sessionFiles.push(...files);
			}
		} catch (e) {
			log(`Could not read Claude Desktop Cowork session files: ${e}`);
		}
		return { sessionFiles, candidatePaths };
	}

	getCandidatePaths(): CandidatePath[] {
		return this.claudeDesktop.getDesktopSessionDirs()
			.map(dir => ({ path: dir, source: 'Claude Desktop (Cowork)' }));
	}

	async buildTurns(sessionFile: string): Promise<{ turns: ChatTurn[]; actualTokens?: number }> {
		const events = await this.claudeDesktop.readDesktopSessionEvents(sessionFile);
		const turns = buildClaudeChatTurns(events, pending => this.processAssistantEventsForTurn(pending), this.estimateTokensFn);
		return { turns };
	}

	private processAssistantEventsForTurn(pendingAssistantEvents: any[]): ClaudeAssistantTurnData {
		let assistantText = '';
		let actualInputTokens = 0;
		let actualOutputTokens = 0;
		let model: string | null = null;
		const toolCalls: { toolName: string; arguments?: string }[] = [];
		const mcpTools: { server: string; tool: string }[] = [];
		// The Cowork JSONL writes one event per content block for each API call,
		// so multiple events may share the same requestId with identical usage counts.
		// Deduplicate by requestId to avoid counting tokens multiple times per API call.
		const seenRequestIds = new Set<string>();
		for (const ae of pendingAssistantEvents) {
			const msg = ae.message;
			if (!model && msg?.model) { model = msg.model; }
			const reqId = ae.requestId as string | undefined;
			const isFirstOccurrence = !reqId || !seenRequestIds.has(reqId);
			if (reqId) { seenRequestIds.add(reqId); }
			const usage = msg?.usage;
			if (usage && isFirstOccurrence) {
				const tokens = this.extractUsageTokens(usage);
				actualInputTokens += tokens.input;
				actualOutputTokens += tokens.output;
			}
			for (const block of (Array.isArray(msg?.content) ? msg.content : [])) {
				assistantText += this.processEventContentBlock(block, toolCalls, mcpTools);
			}
		}
		return { assistantText, model, actualInputTokens, actualOutputTokens, toolCalls, mcpTools };
	}

	private extractUsageTokens(usage: any): { input: number; output: number } {
		return {
			input: (usage.input_tokens || 0) + (usage.cache_creation_input_tokens || 0) + (usage.cache_read_input_tokens || 0),
			output: usage.output_tokens || 0
		};
	}

	private processEventContentBlock(
		block: any,
		toolCalls: { toolName: string; arguments?: string }[],
		mcpTools: { server: string; tool: string }[]
	): string {
		if (block.type === 'text') { return block.text || ''; }
		if (block.type === 'tool_use') {
			const toolName: string = block.name || 'unknown';
			if (this.isMcpToolFn(toolName)) {
				mcpTools.push({ server: this.extractMcpServerNameFn(toolName), tool: toolName });
			} else {
				toolCalls.push({ toolName, arguments: block.input ? JSON.stringify(block.input) : undefined });
			}
		}
		return '';
	}

	async analyzeUsage(sessionFile: string, ctx: UsageAnalysisAdapterContext): Promise<import('../types').SessionUsageAnalysis> {
		const analysis = createEmptySessionUsageAnalysis();
		const events = await readClaudeCodeEventsForAnalysis(sessionFile);
		const models: string[] = [];
		const outcomes = new ClaudeToolOutcomeTracker(name => this.isMcpToolFn(name) ? this.extractMcpServerNameFn(name) : undefined);
		for (const event of events) {
			if (event.type === 'user') { outcomes.noteToolResults(event, analysis); }
			if (event.type === 'user' && event.message?.role === 'user' && !event.isSidechain) {
				this.processDesktopUserEvent(event, analysis);
			} else if (event.type === 'assistant') {
				this.processDesktopAssistantEvent(event, analysis, models, outcomes);
			}
		}
		this.applyDesktopModelSwitchingStats(models, analysis);
		applyModelTierClassification(ctx.modelPricing, analysis.modelSwitching.uniqueModels, models, analysis);
		return analysis;
	}

	private processDesktopUserEvent(event: any, analysis: import('../types').SessionUsageAnalysis): void {
		analysis.modeUsage.ask++;
		const cmd = extractClaudeSlashCommand(event.message?.content);
		if (cmd) {
			const key = `__slash__${cmd}`;
			// Note: do NOT increment analysis.toolCalls.total — slash commands are not tool calls
			analysis.toolCalls.byTool[key] = (analysis.toolCalls.byTool[key] || 0) + 1;
		}
		recordInvokedSkillCall(analysis, event.message?.content);
	}

	private processDesktopAssistantEvent(event: any, analysis: import('../types').SessionUsageAnalysis, models: string[], outcomes: ClaudeToolOutcomeTracker): void {
		const model = normalizeClaudeModelId(event.message?.model || 'unknown');
		models.push(model);
		const content: any[] = Array.isArray(event.message?.content) ? event.message.content : [];
		for (const c of content) {
			if (c?.type !== 'tool_use') { continue; }
			outcomes.noteToolUse(event, c);
			const toolName = String(c.name || 'tool');
			// Same split as ClaudeCodeAdapter.processAssistantEvent, so an `mcp__server__tool`
			// start lands under the server its completion/latency is recorded against.
			if (this.isMcpToolFn(toolName)) {
				const server = this.extractMcpServerNameFn(toolName);
				analysis.mcpTools.total++;
				analysis.mcpTools.byServer[server] = (analysis.mcpTools.byServer[server] || 0) + 1;
				analysis.mcpTools.byTool[toolName] = (analysis.mcpTools.byTool[toolName] || 0) + 1;
				continue;
			}
			analysis.toolCalls.total++;
			analysis.toolCalls.byTool[toolName] = (analysis.toolCalls.byTool[toolName] || 0) + 1;
			recordSkillCall(analysis, toolName, c.input);
		}
	}

	private applyDesktopModelSwitchingStats(models: string[], analysis: import('../types').SessionUsageAnalysis): void {
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
