import * as fs from 'fs';
import * as path from 'path';
import type { ModelUsage, ChatTurn } from '../types';
import type { IEcosystemAdapter } from '../ecosystemAdapter';
import type { IDiscoverableEcosystem, DiscoveryResult, CandidatePath } from '../ecosystemAdapter';
import { VisualStudioDataAccess } from '../visualstudio';
import { createEmptyContextRefs } from '../tokenEstimation';

export class VisualStudioAdapter implements IEcosystemAdapter, IDiscoverableEcosystem {
	readonly id = 'visualstudio';
	readonly displayName = 'Visual Studio';

	constructor(
		private readonly visualStudio: VisualStudioDataAccess,
		private readonly estimateTokens: (text: string, model?: string) => number
	) {}

	handles(sessionFile: string): boolean {
		return this.visualStudio.isVSSessionFile(sessionFile);
	}

	getBackingPath(sessionFile: string): string {
		return sessionFile;
	}

	async stat(sessionFile: string): Promise<fs.Stats> {
		return this.visualStudio.statSessionFile(sessionFile);
	}

	async getTokens(sessionFile: string): Promise<{ tokens: number; thinkingTokens: number; actualTokens: number }> {
		const result = this.visualStudio.getTokenEstimates(sessionFile, this.estimateTokens);
		return { ...result, actualTokens: result.tokens };
	}

	async countInteractions(sessionFile: string): Promise<number> {
		const objects = this.visualStudio.decodeSessionFile(sessionFile);
		return Promise.resolve(this.visualStudio.countInteractions(objects));
	}

	async getModelUsage(sessionFile: string): Promise<ModelUsage> {
		return Promise.resolve(this.visualStudio.getModelUsage(sessionFile, this.estimateTokens));
	}

	async getMeta(sessionFile: string): Promise<{ title: string | undefined; firstInteraction: string | null; lastInteraction: string | null; workspacePath?: string }> {
		const objects = this.visualStudio.decodeSessionFile(sessionFile);
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
			const sessions = this.visualStudio.discoverSessions();
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
		return [{ path: this.visualStudio.getLogDir(), source: 'Visual Studio (log dir)' }];
	}

	getRawFileContent(sessionFile: string): string {
		const objects = this.visualStudio.decodeSessionFile(sessionFile);
		const readable = objects.map((obj: any, i: number) => i === 0 ? obj : obj?.[1] ?? obj);
		return JSON.stringify(readable, null, 2);
	}

	async buildTurns(sessionFile: string): Promise<{ turns: ChatTurn[]; actualTokens?: number }> {
		const turns: ChatTurn[] = [];
		const objects = this.visualStudio.decodeSessionFile(sessionFile);
		let turnNumber = 0;
		for (let i = 1; i < objects.length; i += 2) {
			const req = objects[i];
			const res = objects[i + 1];
			if (!req) { continue; }
			const reqData = req[1];
			const resData = res?.[1];
			turnNumber++;
			const userText = this.visualStudio.extractTextFromContent(reqData?.Content || []);
			const assistantText = res ? this.visualStudio.extractTextFromContent(resData?.Content || []) : '';
			const model = this.visualStudio.getModelId(resData ?? reqData, !resData);
			const contextText = this.visualStudio.extractContextText(reqData?.Context);
			const inputTokens = this.estimateTokens(userText + contextText, model ?? 'gpt-4');
			const outputTokens = res ? this.estimateTokens(assistantText, model ?? 'gpt-4') : 0;
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
			turns.push({
				turnNumber,
				timestamp: reqData?.Timestamp ? new Date(reqData.Timestamp).toISOString() : null,
				mode: 'ask' as const,
				userMessage: userText,
				assistantResponse: assistantText,
				model,
				toolCalls,
				contextReferences: createEmptyContextRefs(),
				mcpTools: [],
				inputTokensEstimate: inputTokens,
				outputTokensEstimate: outputTokens,
				thinkingTokensEstimate: 0
			});
		}
		return { turns };
	}
}
