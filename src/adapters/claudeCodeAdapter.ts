import * as fs from 'fs';
import type { ModelUsage, ChatTurn } from '../types';
import type { IEcosystemAdapter, IDiscoverableEcosystem, IAnalyzableEcosystem, DiscoveryResult, CandidatePath, UsageAnalysisAdapterContext } from '../ecosystemAdapter';
import { ClaudeCodeDataAccess, normalizeClaudeModelId } from '../claudecode';
import { recordAutonomy } from '../autonomy';
import { isHumanUserTurn } from '../utils/claudeUserTurns';
import { readClaudeCodeEventsForAnalysis, createEmptySessionUsageAnalysis, applyModelTierClassification, addSkillCall, recordToolOutcome, extractToolResultText } from '../usageAnalysis';
import { estimateTokensFromText } from '../tokenEstimation';
import { isMcpTool, extractMcpServerName, detectClaudeCodeEditorVariant } from '../workspaceHelpers';
import { detectCacheBreakage, type CacheTurn } from '../cacheBreakage';
import { buildClaudeChatTurns, type ClaudeAssistantTurnData } from './claudeTurns';

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

/**
 * Resolve the actual skill name from a Claude Code `Skill` tool_use block.
 * Claude Code wraps every skill invocation (e.g. `/graphify`) behind one generic
 * `Skill` tool with the real name in `input.skill` — so per-skill usage would
 * otherwise be invisible, collapsed into a single "Skill" tool-call bucket.
 * Returns null for any other tool, or a malformed/missing `input.skill`.
 * Exported for reuse by other Claude-family adapters (e.g. Claude Desktop).
 */
export function extractSkillName(toolName: string, input: unknown): string | null {
	if (toolName !== 'Skill') { return null; }
	const skill = (input as { skill?: unknown } | null | undefined)?.skill;
	return typeof skill === 'string' && skill.trim() ? skill.trim() : null;
}

/**
 * Resolve the skill/command name from a user-typed slash invocation, e.g. `/graphify`.
 * When a user directly types a registered command or skill, Claude Code expands it into
 * a plain user message whose content carries `<command-message>...</command-message>`
 * followed by `<command-name>/name</command-name>` — a completely different, non-tool-call
 * representation from the `Skill` tool_use path in {@link extractSkillName} (that path only
 * fires when Claude itself decides to invoke a skill, not when the user types it directly).
 * Deliberately agnostic (no allowlist) — this captures any command/skill name, unlike the
 * legacy {@link CLAUDE_SLASH_ALLOWLIST} mechanism which only recognizes 5 hardcoded ones.
 */
export function extractInvokedSkillName(content: unknown): string | null {
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
	const m = text.match(/<command-name>\/([a-zA-Z0-9_-]+)<\/command-name>/);
	return m ? m[1] : null;
}

/**
 * Record a skill invocation into `analysis.skillCalls`, if `toolName`/`input` resolve to one.
 * No-op for any other tool call. Shared by every Claude-family adapter (Code, Desktop).
 */
export function recordSkillCall(analysis: import('../types').SessionUsageAnalysis, toolName: string, input: unknown): void {
	const skillName = extractSkillName(toolName, input);
	if (skillName) { addSkillCall(analysis, skillName); }
}

/**
 * Record a user-typed slash invocation (`/graphify`, etc.) into `analysis.skillCalls`.
 * No-op when the message content carries no `<command-name>` tag. Shared by every
 * Claude-family adapter (Code, Desktop).
 */
export function recordInvokedSkillCall(analysis: import('../types').SessionUsageAnalysis, content: unknown): void {
	const skillName = extractInvokedSkillName(content);
	if (skillName) { addSkillCall(analysis, skillName); }
}

/**
 * Pairs Claude-family `tool_use` blocks (assistant events) with their `tool_result`
 * blocks — harness-replayed `user` events, matched by `tool_use_id` — to record the
 * per-tool outcome: `is_error` as failure, the message-timestamp delta as observed
 * latency, and the result text size as `outputTokensByTool`. Shared by the Claude
 * Code and Claude Desktop adapters (docs/adr/TOOL-EXECUTION-STATS.md).
 *
 * The first sighting of a `tool_use` id wins: Claude Code re-logs streaming fragments
 * of the same assistant message, and the earliest timestamp is the real start.
 */
export class ClaudeToolOutcomeTracker {
	private readonly pending = new Map<string, { toolName: string; mcpServer?: string; startedAt?: number }>();

	constructor(private readonly resolveMcpServer: (toolName: string) => string | undefined) {}

	noteToolUse(event: any, block: any): void {
		const id = typeof block?.id === 'string' ? block.id : '';
		if (!id || this.pending.has(id)) { return; }
		const toolName = String(block.name || 'tool');
		this.pending.set(id, { toolName, mcpServer: this.resolveMcpServer(toolName), startedAt: eventEpochMs(event) });
	}

	noteToolResults(event: any, analysis: import('../types').SessionUsageAnalysis): void {
		const content: any[] = Array.isArray(event?.message?.content) ? event.message.content : [];
		for (const block of content) {
			if (block?.type !== 'tool_result') { continue; }
			const started = typeof block.tool_use_id === 'string' ? this.pending.get(block.tool_use_id) : undefined;
			if (!started) { continue; }
			this.pending.delete(block.tool_use_id);
			recordToolOutcome(analysis, started.toolName, started.mcpServer, block.is_error !== true, durationSince(started.startedAt, eventEpochMs(event)));
			if (!started.mcpServer) { addToolOutputTokens(analysis, started.toolName, block.content); }
		}
	}
}

/** Size a non-MCP tool result's text into `outputTokensByTool`; empty results add nothing. */
function addToolOutputTokens(analysis: import('../types').SessionUsageAnalysis, toolName: string, resultContent: unknown): void {
	const tokens = estimateTokensFromText(extractToolResultText(resultContent));
	if (tokens <= 0) { return; }
	analysis.toolCalls.outputTokensByTool ??= {};
	analysis.toolCalls.outputTokensByTool[toolName] = (analysis.toolCalls.outputTokensByTool[toolName] || 0) + tokens;
}

/** Observed duration between two epoch timestamps, or undefined when either is missing or the order is inverted. */
function durationSince(startedAt: number | undefined, completedAt: number | undefined): number | undefined {
	if (startedAt === undefined || completedAt === undefined || completedAt < startedAt) { return undefined; }
	return completedAt - startedAt;
}

/** Parse a Claude event's ISO `timestamp` to epoch ms, or undefined when absent/invalid. */
function eventEpochMs(event: any): number | undefined {
	const ts = typeof event?.timestamp === 'string' ? Date.parse(event.timestamp) : NaN;
	return Number.isNaN(ts) ? undefined : ts;
}

export class ClaudeCodeAdapter implements IEcosystemAdapter, IDiscoverableEcosystem, IAnalyzableEcosystem {
	readonly id = 'claudecode';
	readonly displayName = 'Claude Code';

	constructor(
		private readonly claudeCode: ClaudeCodeDataAccess,
		private readonly isMcpToolFn: (toolName: string) => boolean = isMcpTool,
		private readonly extractMcpServerNameFn: (toolName: string, toolNameMap?: Record<string, string>) => string = extractMcpServerName,
		private readonly estimateTokensFn: (text: string, model?: string) => number = () => 0
	) {}

	handles(sessionFile: string): boolean {
		return this.claudeCode.isClaudeCodeSessionFile(sessionFile);
	}

	/**
	 * Claude Code (CLI/VS Code extension) and the standalone Claude Desktop app both write
	 * to ~/.claude/projects/ and are indistinguishable by path alone — only the `entrypoint`
	 * field inside the session file tells them apart.
	 */
	getDisplayName(sessionFile: string): string {
		return detectClaudeCodeEditorVariant(sessionFile);
	}

	getBackingPath(sessionFile: string): string {
		return sessionFile;
	}

	async stat(sessionFile: string): Promise<fs.Stats> {
		return fs.promises.stat(sessionFile);
	}

	async getTokens(sessionFile: string): Promise<{ tokens: number; thinkingTokens: number; actualTokens: number }> {
		const result = await this.claudeCode.getTokensFromClaudeCodeSession(sessionFile);
		return { ...result, actualTokens: result.tokens };
	}

	async countInteractions(sessionFile: string): Promise<number> {
		return await this.claudeCode.countClaudeCodeInteractions(sessionFile);
	}

	async getModelUsage(sessionFile: string): Promise<ModelUsage> {
		return await this.claudeCode.getClaudeCodeModelUsage(sessionFile);
	}

	async getMeta(sessionFile: string): Promise<{ title: string | undefined; firstInteraction: string | null; lastInteraction: string | null; workspacePath?: string }> {
		const meta = await this.claudeCode.getClaudeCodeSessionMeta(sessionFile);
		return {
			title: meta?.title,
			firstInteraction: meta?.firstInteraction || null,
			lastInteraction: meta?.lastInteraction || null,
			workspacePath: meta?.cwd,
		};
	}

	async getDailyFractions(sessionFile: string): Promise<Record<string, number>> {
		return await this.claudeCode.getClaudeCodeDailyFractions(sessionFile);
	}

	getEditorRoot(_sessionFile: string): string {
		return this.claudeCode.getClaudeCodeProjectsDir();
	}

	async discover(log: (msg: string) => void): Promise<DiscoveryResult> {
		const candidatePaths = this.getCandidatePaths();
		const sessionFiles: string[] = [];
		try {
			const files = await this.claudeCode.getClaudeCodeSessionFiles();
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

	async buildTurns(sessionFile: string): Promise<{ turns: ChatTurn[]; actualTokens?: number }> {
		const events = await readClaudeCodeEventsForAnalysis(sessionFile);
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
		// Claude Code writes multiple JSONL entries per API request (streaming fragments + final).
		// Deduplicate by message.id (last-wins) — same logic as ClaudeCodeDataAccess.deduplicateAssistantEvents.
		const seenMessageIds = new Set<string>();
		for (const ae of pendingAssistantEvents) {
			const msg = ae.message;
			if (!model && msg?.model) { model = normalizeClaudeModelId(msg.model); }
			const msgId = msg?.id as string | undefined;
			const isFirstOccurrence = !msgId || !seenMessageIds.has(msgId);
			if (msgId) { seenMessageIds.add(msgId); }
			if (msg?.usage && isFirstOccurrence) {
				actualInputTokens += this.extractInputTokens(msg.usage);
				actualOutputTokens += msg.usage.output_tokens || 0;
			}
			for (const block of (Array.isArray(msg?.content) ? msg.content : [])) {
				assistantText += this.processContentBlock(block, toolCalls, mcpTools);
			}
		}
		return { assistantText, model, actualInputTokens, actualOutputTokens, toolCalls, mcpTools };
	}

	private extractInputTokens(usage: any): number {
		return (usage.input_tokens || 0)
			+ (usage.cache_creation_input_tokens || 0)
			+ (usage.cache_read_input_tokens || 0);
	}

	private processContentBlock(
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
		// Claude Code (terminal CLI), the standalone Claude Desktop app, and the Claude Code VS
		// Code extension all write to the same ~/.claude/projects/ format, so user-turn interactions
		// are bucketed into the matching modeUsage field instead of always landing in `cli`.
		const modeBucket = this.resolveModeBucket(sessionFile);
		// Cache turns are keyed by message.id so a re-logged API response is counted
		// once — detectCacheBreakage reads a duplicate as a full prefix wipe.
		const cacheTurns = new Map<string, CacheTurn>();
		// Tool results arrive as user events (sidechain ones included — their tool_use was
		// counted from the sidechain assistant event), so they are matched before the
		// real-turn filter below.
		const outcomes = new ClaudeToolOutcomeTracker(name => isMcpTool(name) ? extractMcpServerName(name, ctx.toolNameMap) : undefined);
		for (const event of events) {
			if (event.type === 'user') { outcomes.noteToolResults(event, analysis); }
			if (event.type === 'user' && event.message?.role === 'user' && !event.isSidechain) {
				this.processUserEvent(event, analysis, modeBucket);
			} else if (event.type === 'assistant') {
				this.processAssistantEvent(event, analysis, ctx, models, outcomes);
				this.collectCacheTurn(event, cacheTurns);
			} else if (event.type === 'system' && event.subtype === 'compact_boundary') {
				this.processCompactBoundaryEvent(event, analysis);
			}
		}
		if (cacheTurns.size > 0) {
			// Map iteration is insertion order, which is only approximately chronological —
			// a late-arriving streaming fragment of an earlier message can land after a
			// newer one. detectCacheBreakage compares each turn to its predecessor, so the
			// turns must be in true timestamp order first.
			const orderedTurns = [...cacheTurns.values()].sort((a, b) => a.timestamp - b.timestamp);
			analysis.cacheBreakage = detectCacheBreakage(orderedTurns);
		}
		this.applyModelSwitchingStats(models, analysis);
		applyModelTierClassification(ctx.modelPricing, analysis.modelSwitching.uniqueModels, models, analysis);
		return analysis;
	}

	/**
	 * Map one assistant event onto a {@link CacheTurn}, keyed by `message.id` so
	 * later fragments of the same response overwrite earlier ones (last-wins,
	 * matching ClaudeCodeDataAccess.deduplicateAssistantEvents).
	 *
	 * Sidechain (subagent) turns are skipped: they run against their own prompt
	 * prefix, so interleaving them with the main thread would look like constant
	 * cache invalidation. Turns with no usage, and Claude Code's `<synthetic>`
	 * placeholder responses, carry no billing information and are skipped too.
	 */
	private collectCacheTurn(event: any, into: Map<string, CacheTurn>): void {
		if (event.isSidechain) { return; }
		const msg = event.message;
		const usage = msg?.usage;
		const msgId = msg?.id as string | undefined;
		if (!usage || !msgId || msg?.model === '<synthetic>') { return; }
		const timestamp = Date.parse(event.timestamp);
		if (Number.isNaN(timestamp)) { return; }
		into.set(msgId, {
			timestamp,
			model: normalizeClaudeModelId(msg.model || 'unknown'),
			inputTokens: usage.input_tokens || 0,
			cacheReadTokens: usage.cache_read_input_tokens || 0,
			cacheCreationTokens: usage.cache_creation_input_tokens || 0,
			cacheCreation1hTokens: usage.cache_creation?.ephemeral_1h_input_tokens || 0,
			compacted: Boolean(msg.context_management),
		});
	}

	private processCompactBoundaryEvent(event: any, analysis: import('../types').SessionUsageAnalysis): void {
		if (event.compactMetadata?.trigger === 'auto') {
			// Auto-compaction means the context window was exhausted without user action — negative signal.
			// Stored with a double-underscore prefix so it doesn't inflate toolCalls.total.
			analysis.toolCalls.byTool['__auto_compact__'] = (analysis.toolCalls.byTool['__auto_compact__'] || 0) + 1;
		}
	}

	/**
	 * Resolve which `modeUsage` field a session's user-turn interactions should be counted
	 * under, based on the `entrypoint` variant `detectClaudeCodeEditorVariant` detects:
	 * terminal CLI usage stays in the generic `cli` bucket, while the standalone Claude
	 * Desktop app and IDE-embedded usage (e.g. the VS Code extension) get their own buckets
	 * so terminal CLI counts aren't inflated by non-terminal Claude Code surfaces.
	 */
	private resolveModeBucket(sessionFile: string): 'cli' | 'claudeDesktop' | 'claudeVsCode' {
		const variant = detectClaudeCodeEditorVariant(sessionFile);
		if (variant === 'Claude Code CLI') { return 'cli'; }
		if (variant === 'Claude Desktop') { return 'claudeDesktop'; }
		return 'claudeVsCode';
	}

	private processUserEvent(event: any, analysis: import('../types').SessionUsageAnalysis, modeBucket: 'cli' | 'claudeDesktop' | 'claudeVsCode'): void {
		if (modeBucket === 'cli') {
			analysis.modeUsage.cli++;
		} else {
			analysis.modeUsage[modeBucket] = (analysis.modeUsage[modeBucket] ?? 0) + 1;
		}
		// Only real human prompts count; tool results and synthetic wrapper events also carry permissionMode.
		if (isHumanUserTurn(event)) { recordAutonomy(analysis, event.permissionMode); }
		const cmd = extractClaudeSlashCommand(event.message?.content);
		if (cmd) {
			const key = `__slash__${cmd}`;
			// Note: do NOT increment analysis.toolCalls.total — slash commands are not tool calls
			analysis.toolCalls.byTool[key] = (analysis.toolCalls.byTool[key] || 0) + 1;
		}
		recordInvokedSkillCall(analysis, event.message?.content);
	}

	private processAssistantEvent(event: any, analysis: import('../types').SessionUsageAnalysis, ctx: UsageAnalysisAdapterContext, models: string[], outcomes: ClaudeToolOutcomeTracker): void {
		const model = normalizeClaudeModelId(event.message?.model || 'unknown');
		models.push(model);
		const content: any[] = Array.isArray(event.message?.content) ? event.message.content : [];
		for (const c of content) {
			if (c?.type !== 'tool_use') { continue; }
			outcomes.noteToolUse(event, c);
			const toolName = String(c.name || 'tool');
			if (isMcpTool(toolName)) {
				const server = extractMcpServerName(toolName, ctx.toolNameMap);
				analysis.mcpTools.total++;
				analysis.mcpTools.byServer[server] = (analysis.mcpTools.byServer[server] || 0) + 1;
				analysis.mcpTools.byTool[toolName] = (analysis.mcpTools.byTool[toolName] || 0) + 1;
			} else {
				analysis.toolCalls.total++;
				analysis.toolCalls.byTool[toolName] = (analysis.toolCalls.byTool[toolName] || 0) + 1;
				recordSkillCall(analysis, toolName, c.input);
			}
		}
	}

	private applyModelSwitchingStats(models: string[], analysis: import('../types').SessionUsageAnalysis): void {
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
