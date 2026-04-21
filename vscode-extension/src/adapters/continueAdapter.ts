import * as fs from 'fs';
import type { ModelUsage } from '../types';
import type { IEcosystemAdapter } from '../ecosystemAdapter';
import { ContinueDataAccess } from '../continue';

export class ContinueAdapter implements IEcosystemAdapter {
	readonly id = 'continue';
	readonly displayName = 'Continue';

	constructor(private readonly continue_: ContinueDataAccess) {}

	handles(sessionFile: string): boolean {
		return this.continue_.isContinueSessionFile(sessionFile);
	}

	getBackingPath(sessionFile: string): string {
		return sessionFile;
	}

	async stat(sessionFile: string): Promise<fs.Stats> {
		return fs.promises.stat(sessionFile);
	}

	async getTokens(sessionFile: string): Promise<{ tokens: number; thinkingTokens: number; actualTokens: number }> {
		const result = this.continue_.getTokensFromContinueSession(sessionFile);
		return { ...result, actualTokens: result.tokens };
	}

	async countInteractions(sessionFile: string): Promise<number> {
		return Promise.resolve(this.continue_.countContinueInteractions(sessionFile));
	}

	async getModelUsage(sessionFile: string): Promise<ModelUsage> {
		return Promise.resolve(this.continue_.getContinueModelUsage(sessionFile));
	}

	async getMeta(sessionFile: string): Promise<{ title: string | undefined; firstInteraction: string | null; lastInteraction: string | null; workspacePath?: string }> {
		const meta = this.continue_.getContinueSessionMeta(sessionFile);
		const sessionId = this.continue_.getContinueSessionId(sessionFile);
		const indexEntry = this.continue_.readSessionsIndex().get(sessionId);
		let firstInteraction: string | null = null;
		let lastInteraction: string | null = null;
		if (indexEntry?.dateCreated) {
			firstInteraction = new Date(indexEntry.dateCreated).toISOString();
			try {
				const fileStat = await fs.promises.stat(sessionFile);
				lastInteraction = fileStat.mtime.toISOString();
			} catch { /* ignore */ }
		}
		let workspacePath: string | undefined;
		if (meta?.workspaceDirectory) {
			try {
				workspacePath = decodeURIComponent(meta.workspaceDirectory.replace(/^file:\/\/\//, '').replace(/^file:\/\//, ''));
			} catch { /* ignore */ }
		}
		return {
			title: meta?.title,
			firstInteraction,
			lastInteraction,
			workspacePath,
		};
	}

	getEditorRoot(_sessionFile: string): string {
		return this.continue_.getContinueDataDir();
	}
}
