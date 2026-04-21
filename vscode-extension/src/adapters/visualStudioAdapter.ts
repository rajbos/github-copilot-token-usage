import * as fs from 'fs';
import * as path from 'path';
import type { ModelUsage } from '../types';
import type { IEcosystemAdapter } from '../ecosystemAdapter';
import { VisualStudioDataAccess } from '../visualstudio';

export class VisualStudioAdapter implements IEcosystemAdapter {
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
}
