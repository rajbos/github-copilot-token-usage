/**
 * Session file discovery — generic adapter-loop scanner that delegates all
 * editor-specific path knowledge to ecosystem adapters implementing
 * IDiscoverableEcosystem (see src/ecosystemAdapter.ts and src/adapters/).
 *
 * This file used to hardcode VS Code / Copilot Chat and Copilot CLI paths
 * directly. Those have moved to dedicated adapters:
 *   - src/adapters/copilotChatAdapter.ts
 *   - src/adapters/copilotCliAdapter.ts
 *
 * What remains here:
 *   - The sample-data override for screenshot/demo mode.
 *   - The adapter loop that calls each adapter's discover() and merges
 *     candidate paths for the diagnostics panel.
 *   - A short-term TTL cache so rapid successive scans don't re-walk the FS.
 *   - Path-based deduplication so adapters that overlap (or future bug-fix
 *     additions) cannot double-count the same physical session file.
 *   - checkCopilotExtension() which uses the VS Code extension API and
 *     therefore stays attached to this discovery class.
 */
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { IEcosystemAdapter } from './ecosystemAdapter';
import { isDiscoverable } from './ecosystemAdapter';

export interface SessionDiscoveryDeps {
	log: (message: string) => void;
	warn: (message: string) => void;
	error: (message: string, error?: any) => void;
	ecosystems: IEcosystemAdapter[];
	sampleDataDirectoryOverride?: () => string | undefined;
}

/**
 * Normalize a filesystem path for deduplication.
 *
 * On Windows and macOS the filesystem is typically case-insensitive, so two
 * adapters that report the same file under different casings must collapse
 * to one entry. On Linux the FS is case-sensitive so we preserve case.
 *
 * Backslashes are normalized to forward slashes so comparisons are
 * platform-agnostic regardless of which adapter formatted the path.
 */
function normalizePathForDedup(p: string): string {
	const fwd = p.replace(/\\/g, '/');
	return os.platform() === 'linux' ? fwd : fwd.toLowerCase();
}

export class SessionDiscovery {
	private deps: SessionDiscoveryDeps;
	private _sessionFilesCache: string[] | null = null;
	private _sessionFilesCacheTime: number = 0;
	private static readonly SESSION_FILES_CACHE_TTL = 60000;

	/** Whether any adapter threw during the last discovery run. */
	private _lastDiscoveryHadError = false;
	/** Number of files returned by the last discovery run (reflects actual result, not just cache). */
	private _lastDiscoveryFilesCount = 0;

	constructor(deps: SessionDiscoveryDeps) {
		this.deps = deps;
	}

	/** Whether any adapter threw an error during the most recent discovery scan. */
	get lastDiscoveryHadError(): boolean { return this._lastDiscoveryHadError; }

	/** Number of session files found in the most recent discovery scan. */
	get lastDiscoveryFilesCount(): number { return this._lastDiscoveryFilesCount; }

	clearCache(): void {
		this._sessionFilesCache = null;
		this._sessionFilesCacheTime = 0;
	}

	/** Async replacement for fs.existsSync — does not block the event loop. */
	private async pathExists(p: string): Promise<boolean> {
		try {
			await fs.promises.access(p);
			return true;
		} catch {
			return false;
		}
	}

	/**
	 * Returns the candidate filesystem paths the extension considers when
	 * scanning for session files, along with whether each path exists on
	 * disk. All editor-specific paths come from adapters implementing
	 * IDiscoverableEcosystem (see CopilotChatAdapter, CopilotCliAdapter,
	 * OpenCodeAdapter, etc.).
	 */
	getDiagnosticCandidatePaths(): { path: string; exists: boolean; source: string }[] {
		const candidates: { path: string; exists: boolean; source: string }[] = [];

		for (const eco of this.deps.ecosystems) {
			if (!isDiscoverable(eco)) { continue; }
			try {
				const ecoPaths = eco.getCandidatePaths();
				for (const cp of ecoPaths) {
					let exists = false;
					try { exists = fs.existsSync(cp.path); } catch { /* ignore */ }
					candidates.push({ path: cp.path, exists, source: cp.source });
				}
			} catch { /* ignore individual adapter errors */ }
		}

		return candidates;
	}

	checkCopilotExtension(): void {
		const copilotExtension = vscode.extensions.getExtension('GitHub.copilot');
		const copilotChatExtension = vscode.extensions.getExtension('GitHub.copilot-chat');

		if (!copilotExtension && !copilotChatExtension) {
			this.deps.log('⚠️ GitHub Copilot extensions not found');
		} else {
			const copilotStatus = copilotExtension ? (copilotExtension.isActive ? '✅ Active' : '⏳ Loading') : '❌ Not found';
			const chatStatus = copilotChatExtension ? (copilotChatExtension.isActive ? '✅ Active' : '⏳ Loading') : '❌ Not found';
			this.deps.log(`GitHub Copilot: ${copilotStatus}, Chat: ${chatStatus}`);
		}

		const isCodespaces = process.env.CODESPACES === 'true';
		if (isCodespaces && (!copilotExtension?.isActive || !copilotChatExtension?.isActive)) {
			this.deps.warn('⚠️ Running in Codespaces with inactive Copilot extensions');
		}
	}

	/**
	 * Discover all session files across every registered ecosystem adapter,
	 * merging the results into a single deduplicated list.
	 *
	 * Special-cases sample-data mode: when the user has configured a
	 * sampleDataDirectory the adapters are skipped entirely and only the
	 * sample directory is read. This is used for screenshots and regression
	 * fixtures.
	 */
	async getCopilotSessionFiles(): Promise<string[]> {
		const now = Date.now();
		if (this._sessionFilesCache && (now - this._sessionFilesCacheTime) < SessionDiscovery.SESSION_FILES_CACHE_TTL) {
			this.deps.log(`💨 Using cached session files list (${this._sessionFilesCache.length} files, cached ${Math.round((now - this._sessionFilesCacheTime) / 1000)}s ago)`);
			return this._sessionFilesCache;
		}

		// Reset discovery state for this run.
		this._lastDiscoveryHadError = false;
		this._lastDiscoveryFilesCount = 0;

		// Screenshot/demo mode: sample data directory bypasses adapter discovery.
		const sampleDir = this.deps.sampleDataDirectoryOverride?.()
			?? vscode.workspace.getConfiguration('aiEngineeringFluency').get<string>('sampleDataDirectory');
		if (sampleDir && sampleDir.trim().length > 0) {
			const resolvedSampleDir = sampleDir.trim();
			try {
				if (await this.pathExists(resolvedSampleDir)) {
					const sampleFiles = (await fs.promises.readdir(resolvedSampleDir))
						.filter(f => f.endsWith('.json') || f.endsWith('.jsonl'))
						.map(f => path.join(resolvedSampleDir, f));
					this.deps.log(`📸 Sample data mode: using ${sampleFiles.length} file(s) from ${resolvedSampleDir}`);
					this._sessionFilesCache = sampleFiles;
					this._sessionFilesCacheTime = now;
					this._lastDiscoveryFilesCount = sampleFiles.length;
					return sampleFiles;
				} else {
					this.deps.warn(`Sample data directory not found: ${resolvedSampleDir}`);
				}
			} catch (err) {
				this.deps.warn(`Error reading sample data directory: ${err}`);
			}
		}

		const sessionFiles: string[] = [];
		try {
			this.deps.log(`🔍 Searching for session files via ${this.deps.ecosystems.filter(isDiscoverable).length} discoverable ecosystem adapter(s)`);
			for (const eco of this.deps.ecosystems) {
				if (!isDiscoverable(eco)) { continue; }
				try {
					const result = await eco.discover(this.deps.log);
					sessionFiles.push(...result.sessionFiles);
				} catch (ecoError) {
					this.deps.warn(`Could not discover ${eco.displayName} sessions: ${ecoError}`);
					this._lastDiscoveryHadError = true;
				}
			}

			// Deduplicate by normalized path (case-insensitive on Windows/macOS).
			// Adapters may report overlapping paths (e.g. workspaceStorage scanned
			// from both stable and Insiders user dirs that resolve to the same
			// underlying file via symlinks); without dedup we'd double-count.
			const seen = new Set<string>();
			const deduped: string[] = [];
			for (const f of sessionFiles) {
				const key = normalizePathForDedup(f);
				if (seen.has(key)) { continue; }
				seen.add(key);
				deduped.push(f);
			}
			const dupCount = sessionFiles.length - deduped.length;
			if (dupCount > 0) {
				this.deps.log(`🧹 Deduplicated ${dupCount} duplicate session path(s)`);
			}

			this.deps.log(`✨ Total: ${deduped.length} session file(s) discovered`);
			if (deduped.length === 0) {
				this.deps.warn('⚠️ No session files found - Have you used GitHub Copilot Chat yet?');
			}

			this._sessionFilesCache = deduped;
			this._sessionFilesCacheTime = Date.now();
			this._lastDiscoveryFilesCount = deduped.length;
			return deduped;
		} catch (error) {
			this.deps.error('Error getting session files:', error);
			this._lastDiscoveryHadError = true;
			this._lastDiscoveryFilesCount = sessionFiles.length;
			return sessionFiles;
		}
	}
}
