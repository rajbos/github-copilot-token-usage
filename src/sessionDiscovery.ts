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
import * as path from 'path';
import type { IEcosystemAdapter } from './ecosystemAdapter';
import { isDiscoverable } from './ecosystemAdapter';
import { normalizePathForDedup } from './workspaceHelpers';
import type { WindsurfDataAccess } from './windsurf';

export interface SessionDiscoveryDeps {
	log: (message: string) => void;
	warn: (message: string) => void;
	error: (message: string, error?: any) => void;
	ecosystems: IEcosystemAdapter[];
	windsurf?: WindsurfDataAccess;
	sampleDataDirectoryOverride?: () => string | undefined;
}

/** What one discovery pass observed; published to the instance only if the pass is still current. */
interface DiscoveryPassStatus { hadError: boolean }

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

	/**
	 * The discovery pass currently running, if any. A pass takes 25–95 s on a machine with a large history, and
	 * the result cache below is only filled when a pass *finishes*, so without this every view opened during
	 * that time started its own full pass over all adapters — all competing for the same thread.
	 */
	private _inFlight: { promise: Promise<string[]>; batches: string[][]; subscribers: Set<(files: string[]) => void> } | undefined;
	/** Bumped by clearCache() so a pass that was running across it does not repopulate the cache it just cleared. */
	private _cacheGeneration = 0;

	clearCache(): void {
		this._sessionFilesCache = null;
		this._sessionFilesCacheTime = 0;
		this._cacheGeneration++;
		// Callers after an explicit clear want a fresh pass; the running one still completes for those already on it.
		this._inFlight = undefined;
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

	/** Checks whether a path exists and logs a debug message when it does not. */
	private pathExistsWithLogging(p: string, context: string): boolean {
		try {
			const exists = fs.existsSync(p);
			if (!exists) {
				this.deps.log(`🔍 Path not found [${context}]: ${p}`);
			}
			return exists;
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
					const exists = this.pathExistsWithLogging(cp.path, cp.source);
					candidates.push({ path: cp.path, exists, source: cp.source });
				}
			} catch { /* ignore individual adapter errors */ }
		}

		if (this.deps.windsurf) {
			const cascadeDir = this.deps.windsurf.getCascadeDir();
			// Devin (Cognition Labs' desktop IDE) is a fork/rebrand of Windsurf that writes
			// its Cascade trajectories into this exact same shared folder — there is no
			// separate Devin-specific session directory to scan. Label the row per the app
			// we're actually running in so the diagnostics panel reflects reality.
			const source = this.deps.windsurf.isRunningInDevin() ? 'Devin Cascade (shared with Windsurf)' : 'Windsurf Cascade';
			candidates.push({
				path: cascadeDir,
				exists: this.pathExistsWithLogging(cascadeDir, source),
				source,
			});
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
		return this.getCopilotSessionFilesStreaming();
	}

	private async tryGetSampleDataFiles(now: number, generation: number): Promise<string[] | undefined> {
		const sampleDir = this.deps.sampleDataDirectoryOverride?.()
			?? vscode.workspace.getConfiguration('aiEngineeringFluency').get<string>('sampleDataDirectory');
		if (!sampleDir || sampleDir.trim().length === 0) { return undefined; }
		const resolvedSampleDir = sampleDir.trim();
		try {
			if (!await this.pathExists(resolvedSampleDir)) {
				this.deps.warn(`Sample data directory not found: ${resolvedSampleDir}`);
				return undefined;
			}
			const sampleFiles = (await fs.promises.readdir(resolvedSampleDir))
				.filter(f => f.endsWith('.json') || f.endsWith('.jsonl'))
				.map(f => path.join(resolvedSampleDir, f));
			this.deps.log(`📸 Sample data mode: using ${sampleFiles.length} file(s) from ${resolvedSampleDir}`);
			// Like the adapter pass: a clearCache() that landed while this read was pending must not be undone by it.
			if (generation === this._cacheGeneration) {
				this._sessionFilesCache = sampleFiles;
				this._sessionFilesCacheTime = now;
				this._lastDiscoveryFilesCount = sampleFiles.length;
			}
			return sampleFiles;
		} catch (err) {
			this.deps.warn(`Error reading sample data directory: ${err}`);
			return undefined;
		}
	}

	/** Dedup a single adapter's files against `seen`, appending new ones to `allDeduped` and emitting `onBatch`. */
	private addDedupedBatch(
		files: string[],
		seen: Set<string>,
		allDeduped: string[],
		onBatch?: (files: string[]) => void,
	): void {
		const batch: string[] = [];
		for (const f of files) {
			const key = normalizePathForDedup(f);
			if (seen.has(key)) { continue; }
			seen.add(key); batch.push(f);
		}
		if (batch.length > 0) { allDeduped.push(...batch); if (onBatch) { onBatch(batch); } }
	}

	/** Collect deduplicated Windsurf session files and add them to allDeduped. */
	private async collectWindsurfFiles(seen: Set<string>, allDeduped: string[], status: DiscoveryPassStatus, onBatch?: (files: string[]) => void): Promise<void> {
		if (!this.deps.windsurf) { return; }
		try {
			const windsurfFiles = (await this.deps.windsurf.getWindsurfSessions()).map(session => session.file);
			const batch = windsurfFiles.filter(f => {
				const key = normalizePathForDedup(f);
				if (seen.has(key)) { return false; }
				seen.add(key);
				return true;
			});
			if (batch.length > 0) { allDeduped.push(...batch); if (onBatch) { onBatch(batch); } }
		} catch (error) {
			this.deps.warn(`Could not discover Windsurf sessions: ${error}`);
			status.hadError = true;
		}
	}

	/**
	 * Runs every discoverable adapter concurrently and pushes each adapter's
	 * files into `onBatch` the instant *that adapter* resolves — not after the
	 * slowest one finishes. This matters because some adapters do genuinely
	 * heavyweight first-run work (e.g. CursorAdapter lazily initializes a
	 * sql.js/WASM module and reads Cursor's entire global state.vscdb into
	 * memory). Waiting for `Promise.allSettled()` across *all* adapters before
	 * emitting any batch would starve the streaming worker pool in
	 * `_preloadSessionFiles` — it would sit idle until Cursor (or any other
	 * slow adapter) completes, even though every other adapter finished
	 * quickly. Awaiting each adapter's own promise independently lets fast
	 * adapters' files start parsing immediately while slow ones keep running.
	 */
	private async discoverFromAdapters(status: DiscoveryPassStatus, onBatch?: (files: string[]) => void): Promise<string[]> {
		const seen = new Set<string>();
		const allDeduped: string[] = [];
		const discoveryStartMs = Date.now();
		const discoverableAdapters = this.deps.ecosystems.filter(isDiscoverable);
		this.deps.log(`🔍 Searching for session files via ${discoverableAdapters.length} discoverable ecosystem adapter(s) (parallel)`);

		let totalRaw = 0;
		const adapterTasks = discoverableAdapters.map(eco =>
			eco.discover(this.deps.log).then(
				result => {
					totalRaw += result.sessionFiles.length;
					this.addDedupedBatch(result.sessionFiles, seen, allDeduped, onBatch);
				},
				error => {
					this.deps.warn(`Could not discover ${eco.displayName} sessions: ${error}`);
					status.hadError = true;
				}
			)
		);
		await Promise.all([...adapterTasks, this.collectWindsurfFiles(seen, allDeduped, status, onBatch)]);

		const dupCount = totalRaw - allDeduped.length;
		if (dupCount > 0) { this.deps.log(`🧹 Deduplicated ${dupCount} duplicate session path(s)`); }
		this.deps.log(`✨ Total: ${allDeduped.length} session file(s) discovered in ${((Date.now() - discoveryStartMs) / 1000).toFixed(1)}s`);
		if (allDeduped.length === 0) { this.deps.warn('⚠️ No session files found - Have you used GitHub Copilot Chat yet?'); }
		return allDeduped;
	}

	/**
	 * Discover session files with optional streaming: calls `onBatch` with
	 * deduplicated file paths as each adapter completes. Adapters run in
	 * parallel for maximum throughput. Returns the full deduplicated list.
	 */
	async getCopilotSessionFilesStreaming(onBatch?: (files: string[]) => void): Promise<string[]> {
		const now = Date.now();
		if (this._sessionFilesCache && (now - this._sessionFilesCacheTime) < SessionDiscovery.SESSION_FILES_CACHE_TTL) {
			this.deps.log(`💨 Using cached session files list (${this._sessionFilesCache.length} files, cached ${Math.round((now - this._sessionFilesCacheTime) / 1000)}s ago)`);
			if (onBatch) { onBatch(this._sessionFilesCache); }
			return this._sessionFilesCache;
		}
		// Join a pass that is already running instead of starting a second one. Registered before any await so
		// two callers in the same tick cannot both start one.
		const running = this._inFlight;
		if (running) {
			this.deps.log('🔗 Joining the session-file discovery that is already running');
			if (onBatch) {
				// What it has found so far, isolated like live batches: a throwing late subscriber must not break
				// the discovery result of the caller that joined (or stop later batches reaching it).
				for (const batch of running.batches) {
					try { onBatch(batch); } catch (error) { this.deps.warn(`A session-file discovery subscriber threw: ${error}`); }
				}
				running.subscribers.add(onBatch);
			}
			return running.promise;
		}
		const run: NonNullable<SessionDiscovery['_inFlight']> = { promise: undefined as unknown as Promise<string[]>, batches: [], subscribers: new Set() };
		if (onBatch) { run.subscribers.add(onBatch); }
		const emit = (files: string[]): void => {
			run.batches.push(files);
			for (const subscriber of run.subscribers) {
				try { subscriber(files); } catch (error) { this.deps.warn(`A session-file discovery subscriber threw: ${error}`); }
			}
		};
		const generation = this._cacheGeneration;
		this._inFlight = run;
		run.promise = this.runDiscovery(now, emit, generation).finally(() => {
			if (this._inFlight === run) { this._inFlight = undefined; }
		});
		return run.promise;
	}

	private async runDiscovery(now: number, emit: (files: string[]) => void, generation: number): Promise<string[]> {
		this._lastDiscoveryHadError = false;
		this._lastDiscoveryFilesCount = 0;
		const sampleFiles = await this.tryGetSampleDataFiles(now, generation);
		if (sampleFiles) { emit(sampleFiles); return sampleFiles; }
		const allDeduped: string[] = [];
		// Local to this pass and published only if it is still the current generation: a pass that clearCache()
		// detached must not leave its failures or its count on the status of the fresh pass that replaced it.
		const status: DiscoveryPassStatus = { hadError: false };
		const publish = (count: number): void => {
			if (generation !== this._cacheGeneration) { return; }
			this._lastDiscoveryHadError = status.hadError;
			this._lastDiscoveryFilesCount = count;
		};
		try {
			const files = await this.discoverFromAdapters(status, emit);
			allDeduped.push(...files);
			if (generation === this._cacheGeneration) {
				this._sessionFilesCache = allDeduped;
				this._sessionFilesCacheTime = Date.now();
			}
			publish(allDeduped.length);
			return allDeduped;
		} catch (error) {
			this.deps.error('Error getting session files:', error);
			status.hadError = true;
			publish(allDeduped.length);
			return allDeduped;
		}
	}
}
