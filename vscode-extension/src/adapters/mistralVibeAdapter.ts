import * as fs from 'fs';
import type { ModelUsage } from '../types';
import type { IEcosystemAdapter } from '../ecosystemAdapter';
import { MistralVibeDataAccess } from '../mistralvibe';

export class MistralVibeAdapter implements IEcosystemAdapter {
	readonly id = 'mistralvibe';
	readonly displayName = 'Mistral Vibe';

	constructor(private readonly mistralVibe: MistralVibeDataAccess) {}

	handles(sessionFile: string): boolean {
		return this.mistralVibe.isVibeSessionFile(sessionFile);
	}

	getBackingPath(sessionFile: string): string {
		return sessionFile;
	}

	async stat(sessionFile: string): Promise<fs.Stats> {
		return fs.promises.stat(sessionFile);
	}

	async getTokens(sessionFile: string): Promise<{ tokens: number; thinkingTokens: number; actualTokens: number }> {
		const result = this.mistralVibe.getTokensFromSession(sessionFile);
		return { ...result, actualTokens: result.tokens };
	}

	async countInteractions(sessionFile: string): Promise<number> {
		return Promise.resolve(this.mistralVibe.countInteractions(sessionFile));
	}

	async getModelUsage(sessionFile: string): Promise<ModelUsage> {
		return Promise.resolve(this.mistralVibe.getModelUsage(sessionFile));
	}

	async getMeta(sessionFile: string): Promise<{ title: string | undefined; firstInteraction: string | null; lastInteraction: string | null; workspacePath?: string }> {
		const meta = this.mistralVibe.getSessionMeta(sessionFile);
		return {
			title: meta.title,
			firstInteraction: meta.firstInteraction,
			lastInteraction: meta.lastInteraction,
		};
	}

	getEditorRoot(_sessionFile: string): string {
		return this.mistralVibe.getSessionLogDir();
	}
}
