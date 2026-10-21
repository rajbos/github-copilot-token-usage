import * as fs from 'fs';
import * as path from 'path';
import type { ModelUsage, ChatTurn } from '../types';
import type { IEcosystemAdapter, IDiscoverableEcosystem, IAnalyzableEcosystem, DiscoveryResult, CandidatePath, UsageAnalysisAdapterContext } from '../ecosystemAdapter';
import { HermesDataAccess, type HermesMessage, type HermesSession } from '../hermes';
import { createEmptyContextRefs } from '../tokenEstimation';
import { createEmptySessionUsageAnalysis, applyModelTierClassification } from '../usageAnalysis';

/**
 * Adapter for Hermes Agent (open-source multi-platform AI assistant CLI/desktop app).
 * See src/hermes.ts for the schema, virtual path scheme, and known data-availability notes.
 */
export class HermesAdapter implements IEcosystemAdapter, IDiscoverableEcosystem, IAnalyzableEcosystem {
	readonly id = 'hermes';
	readonly reportsCacheReads = true;
	readonly displayName = 'Hermes';

	constructor(private readonly hermes: HermesDataAccess) {}

	handles(sessionFile: string): boolean {
		return this.hermes.isHermesSessionFile(sessionFile);
	}

	getBackingPath(sessionFile: string): string {
		return this.hermes.getDbPathFromVirtual(sessionFile);
	}

	async stat(sessionFile: string): Promise<fs.Stats> {
		return this.hermes.statSessionFile(sessionFile);
	}

	async getTokens(sessionFile: string): Promise<{ tokens: number; thinkingTokens: number; actualTokens: number }> {
		const result = await this.hermes.getTokens(sessionFile);
		return { ...result, actualTokens: result.tokens };
	}

	async countInteractions(sessionFile: string): Promise<number> {
		return this.hermes.countInteractions(sessionFile);
	}

	async getModelUsage(sessionFile: string): Promise<ModelUsage> {
		return this.hermes.getModelUsage(sessionFile);
	}

	async getMeta(sessionFile: string): Promise<{ title: string | undefined; firstInteraction: string | null; lastInteraction: string | null; workspacePath?: string }> {
		const session = await this.hermes.readSession(sessionFile);
		const messages = await this.hermes.getMessages(sessionFile);
		const title = await this.hermes.resolveTitle(sessionFile, session);
		const timestamps: number[] = [];
		if (session?.started_at) { timestamps.push(session.started_at * 1000); }
		if (session?.ended_at) { timestamps.push(session.ended_at * 1000); }
		for (const msg of messages) {
			if (msg.timestamp) { timestamps.push(msg.timestamp * 1000); }
		}
		timestamps.sort((a, b) => a - b);
		return {
			title,
			firstInteraction: timestamps.length > 0 ? new Date(timestamps[0]).toISOString() : null,
			lastInteraction: timestamps.length > 0 ? new Date(timestamps[timestamps.length - 1]).toISOString() : null,
			workspacePath: session?.cwd || undefined,
		};
	}

	getEditorRoot(sessionFile: string): string {
		return path.dirname(this.hermes.getDbPathFromVirtual(sessionFile));
	}

	async discover(log: (msg: string) => void): Promise<DiscoveryResult> {
		const candidatePaths = this.getCandidatePaths();
		const sessionFiles: string[] = [];
		const dbPath = this.hermes.getDbPath();
		log(`📁 Checking Hermes DB path: ${dbPath}`);
		try {
			await fs.promises.access(dbPath);
			const sessionIds = await this.hermes.discoverSessionIds();
			if (sessionIds.length > 0) {
				log(`📄 Found ${sessionIds.length} session(s) in Hermes database`);
			}
			sessionFiles.push(...sessionIds.map(id => this.hermes.virtualPath(id)));
		} catch (e) {
			log(`Could not read Hermes database: ${e}`);
		}
		return { sessionFiles, candidatePaths };
	}

	getCandidatePaths(): CandidatePath[] {
		return [{ path: this.hermes.getDbPath(), source: 'Hermes (state.db)' }];
	}

	async getDailyFractions(sessionFile: string): Promise<Record<string, number>> {
		return this.hermes.getDailyFractions(sessionFile);
	}

	async buildTurns(sessionFile: string): Promise<{ turns: ChatTurn[]; actualTokens?: number }> {
		const turns: ChatTurn[] = [];
		const messages = await this.hermes.getMessages(sessionFile);
		const session = await this.hermes.readSession(sessionFile);
		let turnNumber = 0;
		for (let i = 0; i < messages.length; i++) {
			const msg = messages[i];
			if (msg.role !== 'user') { continue; }
			turnNumber++;
			const turnMsgs: HermesMessage[] = [];
			for (let j = i + 1; j < messages.length; j++) {
				if (messages[j].role === 'user') { break; }
				turnMsgs.push(messages[j]);
			}
			turns.push(this.buildHermesTurn(msg, turnMsgs, session, turnNumber));
		}
		return { turns };
	}

	private buildHermesTurn(userMsg: HermesMessage, turnMsgs: HermesMessage[], session: HermesSession | null, turnNumber: number): ChatTurn {
		const { assistantText, toolCalls, outputTokens } = this.processTurnMessages(turnMsgs);
		return {
			turnNumber,
			timestamp: userMsg.timestamp ? new Date(userMsg.timestamp * 1000).toISOString() : null,
			mode: 'cli',
			userMessage: userMsg.content || '',
			assistantResponse: assistantText,
			model: session?.model || null,
			toolCalls,
			contextReferences: createEmptyContextRefs(),
			mcpTools: [],
			inputTokensEstimate: userMsg.token_count || Math.ceil((userMsg.content || '').length / 4),
			outputTokensEstimate: outputTokens,
			thinkingTokensEstimate: turnMsgs.reduce((sum, m) => sum + (m.reasoning || m.reasoning_content ? Math.ceil(((m.reasoning || '') + (m.reasoning_content || '')).length / 4) : 0), 0)
		};
	}

	/**
	 * Walk the assistant/tool messages belonging to a single turn, collecting the
	 * assistant's text response, the tool calls it issued (matched against the 'tool'
	 * role result messages by tool_call_id), and a rough output-token estimate.
	 */
	private processTurnMessages(turnMsgs: HermesMessage[]): {
		assistantText: string;
		toolCalls: { toolName: string; arguments?: string; result?: string }[];
		outputTokens: number;
	} {
		let assistantText = '';
		let outputTokens = 0;
		const callsById = new Map<string, { toolName: string; arguments?: string; result?: string }>();
		const orderedCalls: { toolName: string; arguments?: string; result?: string }[] = [];

		for (const msg of turnMsgs) {
			if (msg.role === 'assistant') {
				assistantText = this.appendAssistantText(assistantText, msg);
				outputTokens += msg.token_count || 0;
				this.collectToolCallsFromAssistantMessage(msg, callsById, orderedCalls);
			} else if (msg.role === 'tool') {
				this.attachToolResult(msg, callsById, orderedCalls);
			}
		}
		return { assistantText, toolCalls: orderedCalls, outputTokens };
	}

	private appendAssistantText(assistantText: string, msg: HermesMessage): string {
		if (!msg.content || !msg.content.trim()) { return assistantText; }
		return assistantText + (assistantText ? '\n' : '') + msg.content;
	}

	private collectToolCallsFromAssistantMessage(
		msg: HermesMessage,
		callsById: Map<string, { toolName: string; arguments?: string; result?: string }>,
		orderedCalls: { toolName: string; arguments?: string; result?: string }[]
	): void {
		for (const call of this.hermes.parseToolCalls(msg.tool_calls)) {
			const entry = { toolName: call.name, arguments: call.arguments };
			orderedCalls.push(entry);
			if (call.id) { callsById.set(call.id, entry); }
		}
	}

	private attachToolResult(
		msg: HermesMessage,
		callsById: Map<string, { toolName: string; arguments?: string; result?: string }>,
		orderedCalls: { toolName: string; arguments?: string; result?: string }[]
	): void {
		const result = this.hermes.parseToolResultText(msg.content);
		const matched = msg.tool_call_id ? callsById.get(msg.tool_call_id) : undefined;
		if (matched) {
			matched.result = result;
			return;
		}
		// No matching assistant-side tool_calls entry found (e.g. truncated/compacted history) —
		// still surface the tool result using tool_name so it isn't silently dropped.
		if (msg.tool_name) {
			orderedCalls.push({ toolName: msg.tool_name, result });
		}
	}

	async analyzeUsage(sessionFile: string, ctx: UsageAnalysisAdapterContext): Promise<import('../types').SessionUsageAnalysis> {
		const analysis = createEmptySessionUsageAnalysis();
		const session = await this.hermes.readSession(sessionFile);
		const messages = await this.hermes.getMessages(sessionFile);
		const model = session?.model || 'unknown';
		const models: string[] = [];

		for (const msg of messages) {
			if (msg.role === 'user') {
				analysis.modeUsage.cli++;
				models.push(model);
			}
			if (msg.role === 'tool' && msg.tool_name) {
				analysis.toolCalls.total++;
				analysis.toolCalls.byTool[msg.tool_name] = (analysis.toolCalls.byTool[msg.tool_name] || 0) + 1;
			}
		}

		const uniqueModels = [...new Set(models)];
		analysis.modelSwitching.uniqueModels = uniqueModels;
		analysis.modelSwitching.modelCount = uniqueModels.length;
		analysis.modelSwitching.totalRequests = models.length;
		applyModelTierClassification(ctx.modelPricing, uniqueModels, models, analysis);
		return analysis;
	}
}
