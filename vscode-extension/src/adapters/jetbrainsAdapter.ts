/**
 * JetBrainsAdapter — discovers GitHub Copilot JetBrains IDE session files
 * stored under `~/.copilot/jb/`.
 *
 * JetBrains IDE stores Copilot Chat sessions as JSONL files in conversation-
 * specific subdirectories. Each conversation is a UUID-named directory
 * containing one or more partition files:
 *   ~/.copilot/jb/{conversationId}/partition-{n}.jsonl
 *
 * The JSONL format is compatible with the Copilot CLI session format:
 *   - partition.created:      session header (replaces session.start from CLI format)
 *   - user.message:           user input  (data.content)
 *   - user.message_rendered:  user message + injected file context (data.renderedMessage)
 *   - assistant.turn_start:   turn boundary
 *   - assistant.message:      AI response (data.content)
 *   - tool.execution_start:   tool call started
 *   - tool.execution_complete: tool call result
 *   - assistant.turn_end:     turn boundary
 *
 * Like CopilotCliAdapter, handles() returns false so the existing fallback
 * parsing code in extension.ts continues to own per-session parsing semantics
 * unchanged. Discovery is the primary value delivered by this adapter.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { ModelUsage } from '../types';
import type {
	IEcosystemAdapter,
	IDiscoverableEcosystem,
	DiscoveryResult,
	CandidatePath,
} from '../ecosystemAdapter';
import { parseJetBrainsPartition, type JetBrainsParsedSession } from '../jetbrains';

/** Returns the canonical JetBrains Copilot session directory (~/.copilot/jb). */
export function getJetBrainsSessionDir(): string {
	return path.join(os.homedir(), '.copilot', 'jb');
}

/**
 * Path predicate matching JetBrains partition files under ~/.copilot/jb/.
 * Matches paths containing /.copilot/jb/ that end with /partition-{n}.jsonl.
 */
export function isJetBrainsSessionPath(filePath: string): boolean {
	const norm = filePath.replace(/\\/g, '/');
	return norm.includes('/.copilot/jb/') && /\/partition-\d+\.jsonl$/.test(norm);
}

async function pathExists(p: string): Promise<boolean> {
	try { await fs.promises.access(p); return true; } catch { return false; }
}

export class JetBrainsAdapter implements IEcosystemAdapter, IDiscoverableEcosystem {
	readonly id = 'jetbrains';
	readonly displayName = 'JetBrains IDE';

	/**
	 * Currently a no-op match. The adapter participates in discovery via
	 * IDiscoverableEcosystem but lets the existing fallback parsing code in
	 * extension.ts continue to own per-session parsing for JetBrains files.
	 */
	handles(_sessionFile: string): boolean {
		return false;
	}

	getBackingPath(sessionFile: string): string {
		return sessionFile;
	}

	async stat(sessionFile: string): Promise<fs.Stats> {
		return fs.promises.stat(sessionFile);
	}

	/**
	 * Read and parse the partition file once; safe-default to zeros if the
	 * file can't be read. Callers that need multiple fields off the same
	 * file can use {@link parsePartition} directly to avoid re-reading.
	 */
	private async parsePartition(sessionFile: string): Promise<JetBrainsParsedSession | null> {
		try {
			const content = await fs.promises.readFile(sessionFile, 'utf8');
			return parseJetBrainsPartition(content);
		} catch {
			return null;
		}
	}

	async getTokens(sessionFile: string): Promise<{ tokens: number; thinkingTokens: number; actualTokens: number }> {
		const parsed = await this.parsePartition(sessionFile);
		if (!parsed) { return { tokens: 0, thinkingTokens: 0, actualTokens: 0 }; }
		return {
			tokens: parsed.tokens,
			thinkingTokens: parsed.thinkingTokens,
			actualTokens: parsed.actualTokens,
		};
	}

	async countInteractions(sessionFile: string): Promise<number> {
		const parsed = await this.parsePartition(sessionFile);
		return parsed?.interactions ?? 0;
	}

	async getModelUsage(sessionFile: string): Promise<ModelUsage> {
		const parsed = await this.parsePartition(sessionFile);
		return parsed?.modelUsage ?? {};
	}

	async getMeta(sessionFile: string): Promise<{ title: string | undefined; firstInteraction: string | null; lastInteraction: string | null; workspacePath?: string }> {
		const parsed = await this.parsePartition(sessionFile);
		return {
			title: undefined,
			firstInteraction: parsed?.firstInteraction ?? null,
			lastInteraction: parsed?.lastInteraction ?? null,
		};
	}

	getEditorRoot(_sessionFile: string): string {
		return getJetBrainsSessionDir();
	}

	getCandidatePaths(): CandidatePath[] {
		return [{ path: getJetBrainsSessionDir(), source: 'JetBrains IDE' }];
	}

	/**
	 * Walk ~/.copilot/jb/ collecting non-empty partition-{n}.jsonl files from
	 * UUID subdirectories (one subdirectory = one conversation).
	 *
	 * Empty files are excluded — they indicate conversations with no content yet.
	 */
	async discover(log: (msg: string) => void): Promise<DiscoveryResult> {
		const candidatePaths = this.getCandidatePaths();
		const sessionFiles: string[] = [];
		const root = getJetBrainsSessionDir();

		try {
			if (!(await pathExists(root))) {
				return { sessionFiles, candidatePaths };
			}

			let entries: fs.Dirent[];
			try {
				entries = await fs.promises.readdir(root, { withFileTypes: true });
			} catch (e) {
				log(`Could not read JetBrains session path in ${root}: ${e}`);
				return { sessionFiles, candidatePaths };
			}

			const subDirs = entries.filter(e => e.isDirectory());

			const allPartitionFiles = (await Promise.all(
				subDirs.map(async (subDir) => {
					const convDir = path.join(root, subDir.name);
					let partitionEntries: fs.Dirent[];
					try {
						partitionEntries = await fs.promises.readdir(convDir, { withFileTypes: true });
					} catch {
						return [];
					}

					const partitionFiles: string[] = [];
					for (const entry of partitionEntries) {
						if (!entry.isFile() || !/^partition-\d+\.jsonl$/.test(entry.name)) {
							continue;
						}
						const fullPath = path.join(convDir, entry.name);
						try {
							const stats = await fs.promises.stat(fullPath);
							if (stats.size > 0) {
								partitionFiles.push(fullPath);
							}
						} catch {
							// ignore inaccessible files
						}
					}
					return partitionFiles;
				}),
			)).flat();

			if (allPartitionFiles.length > 0) {
				log(`📄 Found ${allPartitionFiles.length} session file(s) in JetBrains IDE Copilot`);
				sessionFiles.push(...allPartitionFiles);
			}
		} catch (e) {
			log(`Could not check JetBrains session path ${root}: ${e}`);
		}

		return { sessionFiles, candidatePaths };
	}
}
