import * as fs from 'fs';
import type { ModelUsage } from '../types';
import type { IEcosystemAdapter } from '../ecosystemAdapter';
import type { IDiscoverableEcosystem, DiscoveryResult, CandidatePath } from '../ecosystemAdapter';
import { ClaudeCodeDataAccess } from '../claudecode';

export class ClaudeCodeAdapter implements IEcosystemAdapter, IDiscoverableEcosystem {
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
}
