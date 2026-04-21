import * as fs from 'fs';
import * as path from 'path';
import type { ModelUsage } from '../types';
import type { IEcosystemAdapter } from '../ecosystemAdapter';
import { CrushDataAccess } from '../crush';

export class CrushAdapter implements IEcosystemAdapter {
	readonly id = 'crush';
	readonly displayName = 'Crush';

	constructor(private readonly crush: CrushDataAccess) {}

	handles(sessionFile: string): boolean {
		return this.crush.isCrushSessionFile(sessionFile);
	}

	getBackingPath(sessionFile: string): string {
		return this.crush.getCrushDbPath(sessionFile);
	}

	async stat(sessionFile: string): Promise<fs.Stats> {
		return this.crush.statSessionFile(sessionFile);
	}

	async getTokens(sessionFile: string): Promise<{ tokens: number; thinkingTokens: number; actualTokens: number }> {
		const result = await this.crush.getTokensFromCrushSession(sessionFile);
		return { ...result, actualTokens: result.tokens };
	}

	async countInteractions(sessionFile: string): Promise<number> {
		return this.crush.countCrushInteractions(sessionFile);
	}

	async getModelUsage(sessionFile: string): Promise<ModelUsage> {
		return this.crush.getCrushModelUsage(sessionFile);
	}

	async getMeta(sessionFile: string): Promise<{ title: string | undefined; firstInteraction: string | null; lastInteraction: string | null; workspacePath?: string }> {
		const timestamps: number[] = [];
		const session = await this.crush.readCrushSession(sessionFile);
		let title: string | undefined;
		if (session) {
			title = session.title || undefined;
			if (session.created_at) { timestamps.push(session.created_at * 1000); } // epoch seconds → ms
			if (session.updated_at) { timestamps.push(session.updated_at * 1000); }
		}
		const messages = await this.crush.getCrushMessages(sessionFile);
		for (const msg of messages) {
			if (msg.created_at) { timestamps.push(msg.created_at * 1000); }
			if (msg.finished_at) { timestamps.push(msg.finished_at * 1000); }
		}
		timestamps.sort((a, b) => a - b);
		return {
			title,
			firstInteraction: timestamps.length > 0 ? new Date(timestamps[0]).toISOString() : null,
			lastInteraction: timestamps.length > 0 ? new Date(timestamps[timestamps.length - 1]).toISOString() : null,
		};
	}

	getEditorRoot(sessionFile: string): string {
		return path.dirname(this.crush.getCrushDbPath(sessionFile));
	}
}
