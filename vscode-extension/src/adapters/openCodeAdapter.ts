import * as fs from 'fs';
import * as path from 'path';
import type { ModelUsage } from '../types';
import type { IEcosystemAdapter } from '../ecosystemAdapter';
import { OpenCodeDataAccess } from '../opencode';

export class OpenCodeAdapter implements IEcosystemAdapter {
	readonly id = 'opencode';
	readonly displayName = 'OpenCode';

	constructor(private readonly openCode: OpenCodeDataAccess) {}

	handles(sessionFile: string): boolean {
		return this.openCode.isOpenCodeSessionFile(sessionFile);
	}

	getBackingPath(sessionFile: string): string {
		if (this.openCode.isOpenCodeDbSession(sessionFile)) {
			return path.join(this.openCode.getOpenCodeDataDir(), 'opencode.db');
		}
		return sessionFile;
	}

	async stat(sessionFile: string): Promise<fs.Stats> {
		return this.openCode.statSessionFile(sessionFile);
	}

	async getTokens(sessionFile: string): Promise<{ tokens: number; thinkingTokens: number; actualTokens: number }> {
		const result = await this.openCode.getTokensFromOpenCodeSession(sessionFile);
		return { ...result, actualTokens: result.tokens };
	}

	async countInteractions(sessionFile: string): Promise<number> {
		return this.openCode.countOpenCodeInteractions(sessionFile);
	}

	async getModelUsage(sessionFile: string): Promise<ModelUsage> {
		return this.openCode.getOpenCodeModelUsage(sessionFile);
	}

	async getMeta(sessionFile: string): Promise<{ title: string | undefined; firstInteraction: string | null; lastInteraction: string | null; workspacePath?: string }> {
		const timestamps: number[] = [];
		let title: string | undefined;
		let workspacePath: string | undefined;

		const sessionId = this.openCode.getOpenCodeSessionId(sessionFile);
		let session: any = null;
		if (this.openCode.isOpenCodeDbSession(sessionFile) && sessionId) {
			session = await this.openCode.readOpenCodeDbSession(sessionId);
		} else {
			try {
				const content = await fs.promises.readFile(sessionFile, 'utf8');
				session = JSON.parse(content);
			} catch { /* ignore */ }
		}
		if (session) {
			title = session.title || session.slug;
			workspacePath = session.directory || undefined;
			if (session.time?.created) { timestamps.push(session.time.created); }
			if (session.time?.updated) { timestamps.push(session.time.updated); }
		}

		const messages = await this.openCode.getOpenCodeMessagesForSession(sessionFile);
		for (const msg of messages) {
			if (msg.time?.created) { timestamps.push(msg.time.created); }
			if (msg.time?.completed) { timestamps.push(msg.time.completed); }
		}

		timestamps.sort((a, b) => a - b);
		return {
			title,
			firstInteraction: timestamps.length > 0 ? new Date(timestamps[0]).toISOString() : null,
			lastInteraction: timestamps.length > 0 ? new Date(timestamps[timestamps.length - 1]).toISOString() : null,
			workspacePath,
		};
	}

	getEditorRoot(_sessionFile: string): string {
		return this.openCode.getOpenCodeDataDir();
	}
}
