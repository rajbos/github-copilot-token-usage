import * as fs from 'fs';
import type { ModelUsage, ChatTurn, ActualUsage } from '../types';
import type { IEcosystemAdapter, IDiscoverableEcosystem, IAnalyzableEcosystem, DiscoveryResult, CandidatePath, UsageAnalysisAdapterContext } from '../ecosystemAdapter';
import { ClaudeDesktopCoworkDataAccess } from '../claudedesktop';
import { createEmptyContextRefs } from '../tokenEstimation';
import { readClaudeCodeEventsForAnalysis, createEmptySessionUsageAnalysis, applyModelTierClassification } from '../usageAnalysis';
import { normalizeClaudeModelId } from '../claudecode';
import { extractClaudeSlashCommand } from './claudeCodeAdapter';

export class ClaudeDesktopAdapter implements IEcosystemAdapter, IDiscoverableEcosystem, IAnalyzableEcosystem {
	readonly id = 'claudedesktop';
	readonly displayName = 'Claude Desktop Cowork';

	constructor(
		private readonly claudeDesktopCowork: ClaudeDesktopCoworkDataAccess,
		private readonly isMcpToolFn: (toolName: string) => boolean,
		private readonly extractMcpServerNameFn: (toolName: string) => string,
		private readonly estimateTokensFn: (text: string, model?: string) => number
	) {}

	handles(sessionFile: string): boolean {
		return this.claudeDesktopCowork.isCoworkSessionFile(sessionFile);
	}

	getBackingPath(sessionFile: string): string {
		return sessionFile;
	}

	async stat(sessionFile: string): Promise<fs.Stats> {
		return fs.promises.stat(sessionFile);
	}

	async getTokens(sessionFile: string): Promise<{ tokens: number; thinkingTokens: number; actualTokens: number }> {
		const result = this.claudeDesktopCowork.getTokensFromCoworkSession(sessionFile);
		return { ...result, actualTokens: result.tokens };
	}

	async countInteractions(sessionFile: string): Promise<number> {
		return Promise.resolve(this.claudeDesktopCowork.countCoworkInteractions(sessionFile));
	}

	async getModelUsage(sessionFile: string): Promise<ModelUsage> {
		return Promise.resolve(this.claudeDesktopCowork.getCoworkModelUsage(sessionFile));
	}

	async getMeta(sessionFile: string): Promise<{ title: string | undefined; firstInteraction: string | null; lastInteraction: string | null; workspacePath?: string }> {
		const meta = this.claudeDesktopCowork.getCoworkSessionMeta(sessionFile);
		return {
			title: meta?.title,
			firstInteraction: meta?.firstInteraction || null,
			lastInteraction: meta?.lastInteraction || null,
			workspacePath: meta?.cwd,
		};
	}

	getEditorRoot(_sessionFile: string): string {
		return this.claudeDesktopCowork.getCoworkBaseDir();
	}

	async discover(log: (msg: string) => void): Promise<DiscoveryResult> {
		const candidatePaths = this.getCandidatePaths();
		const sessionFiles: string[] = [];
		try {
			const files = this.claudeDesktopCowork.getCoworkSessionFiles();
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
		const baseDir = this.claudeDesktopCowork.getCoworkBaseDir();
		return baseDir ? [{ path: baseDir, source: 'Claude Desktop (Cowork)' }] : [];
	}

	async buildTurns(sessionFile: string): Promise<{ turns: ChatTurn[]; actualTokens?: number }> {
		const turns: ChatTurn[] = [];
		const events = this.claudeDesktopCowork.readCoworkEvents(sessionFile);
		let currentUserEvent: any = null;
		const pendingAssistantEvents: any[] = [];

		const emitTurn = () => {
			if (!currentUserEvent) { return; }
			const content = currentUserEvent.message?.content;
			const userMessage = typeof content === 'string' ? content
				: Array.isArray(content) ? content.filter((c: any) => c.type === 'text').map((c: any) => c.text || '').join('\n')
				: '';
			let assistantText = '';
			let actualInputTokens = 0;
			let actualOutputTokens = 0;
			let model: string | null = null;
			const toolCalls: { toolName: string; arguments?: string }[] = [];
			const mcpTools: { server: string; tool: string }[] = [];

			for (const ae of pendingAssistantEvents) {
				const msg = ae.message;
				if (!model && msg?.model) { model = msg.model; }
				const usage = msg?.usage;
				if (usage) {
					actualInputTokens += (usage.input_tokens || 0) + (usage.cache_creation_input_tokens || 0) + (usage.cache_read_input_tokens || 0);
					actualOutputTokens += usage.output_tokens || 0;
				}
				const contentArr: any[] = Array.isArray(msg?.content) ? msg.content : [];
				for (const block of contentArr) {
					if (block.type === 'text') { assistantText += block.text || ''; }
					else if (block.type === 'tool_use') {
						const toolName: string = block.name || 'unknown';
						if (this.isMcpToolFn(toolName)) {
							mcpTools.push({ server: this.extractMcpServerNameFn(toolName), tool: toolName });
						} else {
							toolCalls.push({ toolName, arguments: block.input ? JSON.stringify(block.input) : undefined });
						}
					}
				}
			}

			const usedModel = model || 'claude-sonnet-4-6';
			const actualUsage: ActualUsage | undefined = (actualInputTokens > 0 || actualOutputTokens > 0) ? {
				promptTokens: actualInputTokens,
				completionTokens: actualOutputTokens
			} : undefined;

			turns.push({
				turnNumber: turns.length + 1,
				timestamp: currentUserEvent.timestamp ? new Date(currentUserEvent.timestamp).toISOString() : null,
				mode: 'agent',
				userMessage,
				assistantResponse: assistantText,
				model: usedModel,
				toolCalls,
				contextReferences: createEmptyContextRefs(),
				mcpTools,
				inputTokensEstimate: actualInputTokens || this.estimateTokensFn(userMessage, usedModel),
				outputTokensEstimate: actualOutputTokens || this.estimateTokensFn(assistantText, usedModel),
				thinkingTokensEstimate: 0,
				actualUsage
			});
		};

		const isRealUserMessage = (event: any): boolean => {
			const content = event.message?.content;
			if (typeof content === 'string') { return !!content.trim(); }
			if (!Array.isArray(content)) { return false; }
			const hasText = content.some((c: any) => c.type === 'text');
			const hasToolResult = content.some((c: any) => c.type === 'tool_result');
			return hasText && !hasToolResult;
		};

		for (const event of events) {
			if (event.type === 'user' && !event.isSidechain && event.message?.role === 'user' && isRealUserMessage(event)) {
				emitTurn();
				currentUserEvent = event;
				pendingAssistantEvents.length = 0;
			} else if (event.type === 'assistant' && event.message?.stop_reason && event.message?.role === 'assistant') {
				pendingAssistantEvents.push(event);
			}
		}
		emitTurn();

		return { turns };
	}

	async analyzeUsage(sessionFile: string, ctx: UsageAnalysisAdapterContext): Promise<import('../types').SessionUsageAnalysis> {
		const analysis = createEmptySessionUsageAnalysis();
		const events = await readClaudeCodeEventsForAnalysis(sessionFile);
		const models: string[] = [];
		for (const event of events) {
			if (event.type === 'user' && event.message?.role === 'user' && !event.isSidechain) {
				analysis.modeUsage.ask++;
				// Detect Claude slash commands from the first line of user messages
				const cmd = extractClaudeSlashCommand(event.message?.content);
				if (cmd) {
					const key = `__slash__${cmd}`;
					analysis.toolCalls.byTool[key] = (analysis.toolCalls.byTool[key] || 0) + 1;
					// Note: do NOT increment analysis.toolCalls.total — slash commands are not tool calls
				}
			} else if (event.type === 'assistant') {
				const model = normalizeClaudeModelId(event.message?.model || 'unknown');
				models.push(model);
				const content: any[] = Array.isArray(event.message?.content) ? event.message.content : [];
				for (const c of content) {
					if (c?.type === 'tool_use') {
						analysis.toolCalls.total++;
						const toolName = String(c.name || 'tool');
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
		applyModelTierClassification(ctx.modelPricing, uniqueModels, models, analysis);
		return analysis;
	}
}
