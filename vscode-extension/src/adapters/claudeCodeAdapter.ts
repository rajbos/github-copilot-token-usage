import * as fs from 'fs';
import type { ModelUsage } from '../types';
import type { IEcosystemAdapter, IDiscoverableEcosystem, IAnalyzableEcosystem, DiscoveryResult, CandidatePath, UsageAnalysisAdapterContext } from '../ecosystemAdapter';
import { ClaudeCodeDataAccess, normalizeClaudeModelId } from '../claudecode';
import { readClaudeCodeEventsForAnalysis, createEmptySessionUsageAnalysis, applyModelTierClassification } from '../usageAnalysis';
import { isMcpTool, extractMcpServerName } from '../workspaceHelpers';

/**
 * Claude Code slash commands that map to Prompt Engineering fluency.
 * These are stored in toolCalls.byTool with a __slash__ prefix so they
 * are tracked without inflating tool call counts or agentic metrics.
 */
const CLAUDE_SLASH_ALLOWLIST = new Set(['review', 'bug', 'think', 'compact', 'pr_comments']);

/**
 * Extract a Claude slash command from the first non-empty text line of a user message.
 * Returns the command name (without leading '/') if found and in the allowlist, else null.
 * Only matches at the very start of the message to avoid false-positives from pasted code.
 * Exported for reuse by other Claude-family adapters.
 */
export function extractClaudeSlashCommand(content: unknown): string | null {
	let text = '';
	if (typeof content === 'string') {
		text = content;
	} else if (Array.isArray(content)) {
		for (const block of content) {
			if (block?.type === 'text' && typeof block.text === 'string') {
				text = block.text;
				break;
			}
		}
	}
	const firstLine = text.trimStart().split('\n')[0].trim();
	const m = firstLine.match(/^\/([a-z_]+)(?:\s|$)/i);
	if (!m) { return null; }
	const cmd = m[1].toLowerCase();
	return CLAUDE_SLASH_ALLOWLIST.has(cmd) ? cmd : null;
}

export class ClaudeCodeAdapter implements IEcosystemAdapter, IDiscoverableEcosystem, IAnalyzableEcosystem {
	readonly id = 'claudecode';
	readonly displayName = 'Claude Code';

	constructor(private readonly claudeCode: ClaudeCodeDataAccess) {}

	handles(sessionFile: string): boolean {
		return this.claudeCode.isClaudeCodeSessionFile(sessionFile);
	}

	getBackingPath(sessionFile: string): string {
		return sessionFile;
	}

	async stat(sessionFile: string): Promise<fs.Stats> {
		return fs.promises.stat(sessionFile);
	}

	async getTokens(sessionFile: string): Promise<{ tokens: number; thinkingTokens: number; actualTokens: number }> {
		const result = this.claudeCode.getTokensFromClaudeCodeSession(sessionFile);
		return { ...result, actualTokens: result.tokens };
	}

	async countInteractions(sessionFile: string): Promise<number> {
		return Promise.resolve(this.claudeCode.countClaudeCodeInteractions(sessionFile));
	}

	async getModelUsage(sessionFile: string): Promise<ModelUsage> {
		return Promise.resolve(this.claudeCode.getClaudeCodeModelUsage(sessionFile));
	}

	async getMeta(sessionFile: string): Promise<{ title: string | undefined; firstInteraction: string | null; lastInteraction: string | null; workspacePath?: string }> {
		const meta = this.claudeCode.getClaudeCodeSessionMeta(sessionFile);
		return {
			title: meta?.title,
			firstInteraction: meta?.firstInteraction || null,
			lastInteraction: meta?.lastInteraction || null,
			workspacePath: meta?.cwd,
		};
	}

	getEditorRoot(_sessionFile: string): string {
		return this.claudeCode.getClaudeCodeProjectsDir();
	}

	async discover(log: (msg: string) => void): Promise<DiscoveryResult> {
		const candidatePaths = this.getCandidatePaths();
		const sessionFiles: string[] = [];
		try {
			const files = this.claudeCode.getClaudeCodeSessionFiles();
			if (files.length > 0) {
				log(`📄 Found ${files.length} session file(s) in Claude Code (~/.claude/projects)`);
				sessionFiles.push(...files);
			}
		} catch (e) {
			log(`Could not read Claude Code session files: ${e}`);
		}
		return { sessionFiles, candidatePaths };
	}

	getCandidatePaths(): CandidatePath[] {
		return [{ path: this.claudeCode.getClaudeCodeProjectsDir(), source: 'Claude Code' }];
	}

	async analyzeUsage(sessionFile: string, ctx: UsageAnalysisAdapterContext): Promise<import('../types').SessionUsageAnalysis> {
		const analysis = createEmptySessionUsageAnalysis();
		const events = await readClaudeCodeEventsForAnalysis(sessionFile);
		const models: string[] = [];
		for (const event of events) {
			if (event.type === 'user' && event.message?.role === 'user' && !event.isSidechain) {
				analysis.modeUsage.cli++;
				// Detect Claude Code slash commands from the first line of user messages
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
						const toolName = String(c.name || 'tool');
						if (isMcpTool(toolName)) {
							// Route MCP tools to mcpTools tracking
							const server = extractMcpServerName(toolName, ctx.toolNameMap);
							analysis.mcpTools.total++;
							analysis.mcpTools.byServer[server] = (analysis.mcpTools.byServer[server] || 0) + 1;
							analysis.mcpTools.byTool[toolName] = (analysis.mcpTools.byTool[toolName] || 0) + 1;
						} else {
							analysis.toolCalls.total++;
							analysis.toolCalls.byTool[toolName] = (analysis.toolCalls.byTool[toolName] || 0) + 1;
						}
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
