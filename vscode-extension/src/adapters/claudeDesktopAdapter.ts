import * as fs from 'fs';
import type { ModelUsage } from '../types';
import type { IEcosystemAdapter } from '../ecosystemAdapter';
import { ClaudeDesktopCoworkDataAccess } from '../claudedesktop';

export class ClaudeDesktopAdapter implements IEcosystemAdapter {
	readonly id = 'claudedesktop';
	readonly displayName = 'Claude Desktop Cowork';

	constructor(private readonly claudeDesktopCowork: ClaudeDesktopCoworkDataAccess) {}

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
}
