/**
 * Windsurf data access layer.
 * Handles reading session data from Windsurf's local language server API.
 * Uses gRPC-over-HTTP/1.1 to query Cascade trajectories and extract token usage.
 * Falls back to file-based discovery (~/.codeium/windsurf/cascade/*.pb) when running in VS Code.
 */
import * as vscode from 'vscode';
import * as http from 'http';
import * as https from 'https';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { ModelUsage, SessionFileDetails, DailyTokenStats } from './types';

interface WindsurfCredentials {
	csrf: string;
	port: number;
}

interface CascadeTrajectorySummary {
	summary: string;
	stepCount: number;
	createdTime: string;
	lastModifiedTime: string;
	trajectoryId: string;
	status: string;
	lastGeneratorModelUid: string;
	trajectoryType: string;
	lastUserInputTime?: string;
	workspaces?: Array<{
		workspaceFolderAbsoluteUri?: string;
		branchName?: string;
		repository?: { computedName?: string };
	}>;
}

interface GetAllCascadeTrajectoriesResponse {
	trajectorySummaries: {
		[cascadeId: string]: CascadeTrajectorySummary;
	};
}

interface CascadeTrajectoryStep {
	type: string;
	metadata?: {
		requestedModelUid?: string;
		// Token usage lives on CORTEX_STEP_TYPE_PLANNER_RESPONSE steps (string-encoded ints).
		// cumulativeTokensAtStep is the running total for the trajectory, so the maximum
		// across planner responses is the session's total token count.
		cumulativeTokensAtStep?: string;
		inputTokens?: string;
		cacheReadTokens?: string;
		responseDimensionGroups?: Array<{
			title: string;
			dimensions: Array<{
				uid: string;
				cumulativeMetric?: {
					value: number;
				};
			}>;
		}>;
	};
}

interface GetCascadeTrajectoryStepsResponse {
	steps: CascadeTrajectoryStep[];
}

export class WindsurfDataAccess {
	private credentials: WindsurfCredentials | null = null;
	private readonly extensionUri: vscode.Uri;
	private log: (msg: string) => void = (msg) => console.log(msg);
	private sessionCache: { sessions: SessionFileDetails[]; expiresAt: number } | null = null;
	private _sessionFetchInFlight: Promise<SessionFileDetails[]> | null = null;
	// Long enough that resolveSession() calls made later in a large preload/stats pass (which can
	// easily take well over a minute across thousands of session files) still hit the cache
	// populated by the discovery pass's own getWindsurfSessions() call, instead of re-running the
	// full API+file-based discovery (several seconds of disk/API I/O) a second time for the same
	// batch. Was 15s, too short relative to that pipeline's real wall-clock time.
	private static readonly SESSION_CACHE_TTL_MS = 120_000;

	constructor(extensionUri: vscode.Uri, log?: (msg: string) => void) {
		this.extensionUri = extensionUri;
		if (log) { this.log = log; }
	}

	/**
	 * Check if the extension is running inside Windsurf.
	 */
	isRunningInWindsurf(): boolean {
		const appName = vscode.env.appName.toLowerCase();
		this.log(`[Windsurf] appName="${vscode.env.appName}" → isWindsurf=${appName.includes('windsurf')}`);
		return appName.includes('windsurf');
	}

	/**
	 * Check if the extension is running inside Devin (Cognition Labs' desktop IDE — a direct
	 * fork/rebrand of Windsurf after Cognition acquired the Windsurf/Codeium team). Devin's
	 * product.json reports appName "Devin"; it bundles the same `codeium.windsurf` extension
	 * and writes Cascade trajectories into the very same ~/.codeium/windsurf/cascade folder.
	 */
	isRunningInDevin(): boolean {
		const appName = vscode.env.appName.toLowerCase();
		this.log(`[Windsurf] appName="${vscode.env.appName}" → isDevin=${appName.includes('devin')}`);
		return appName.includes('devin');
	}

	/**
	 * True when running inside either Windsurf or Devin — both host the same bundled
	 * codeium.windsurf extension and gRPC language server, so live API session discovery
	 * works identically from within either app.
	 */
	isRunningInWindsurfFamily(): boolean {
		return this.isRunningInWindsurf() || this.isRunningInDevin();
	}

	/**
	 * Returns the editor label to attribute a *live API-discovered* session to, based on
	 * which app is actually hosting the extension right now. Only meaningful while running
	 * inside Windsurf or Devin — callers must not use this for file-based (.pb) fallback
	 * discovery, where the producing app cannot be determined (see getWindsurfCascadeSessionFiles).
	 */
	private getHostEditorLabel(): { source: 'windsurf' | 'devin'; name: string; scheme: string } {
		if (this.isRunningInDevin()) {
			return { source: 'devin', name: 'Devin', scheme: 'devin://trajectory/' };
		}
		return { source: 'windsurf', name: 'Windsurf', scheme: 'windsurf://trajectory/' };
	}

	/**
	 * Given a windsurf:// or devin:// virtual session path, returns the friendly editor
	 * name encoded by its scheme ('Windsurf' or 'Devin'). Cheaper than resolveSession()
	 * when only the label (not full session data) is needed.
	 */
	getFamilyEditorName(sessionFile: string): string {
		return sessionFile.startsWith('devin://') ? 'Devin' : 'Windsurf';
	}

	/**
	 * Extracts the Cascade trajectory id from a windsurf://trajectory/{id} or
	 * devin://trajectory/{id} virtual session path (both point at the same
	 * ~/.codeium/windsurf/cascade/{id}.pb file on disk).
	 */
	extractTrajectoryId(sessionFile: string): string {
		return sessionFile.replace('windsurf://trajectory/', '').replace('devin://trajectory/', '');
	}

	/**
	 * Check if a session file is a Windsurf or Devin session file.
	 * Windsurf uses virtual windsurf://trajectory/{id} paths; Devin (a fork/rebrand of
	 * Windsurf that shares the same Cascade storage) uses devin://trajectory/{id} paths.
	 */
	isWindsurfSessionFile(filePath: string): boolean {
		return filePath.startsWith('windsurf://trajectory/') || filePath.startsWith('devin://trajectory/');
	}

	/**
	 * Get the path to Windsurf's Cascade session directory.
	 * Returns ~/.codeium/windsurf/cascade on all platforms.
	 */
	getCascadeDir(): string {
		return path.join(os.homedir(), '.codeium', 'windsurf', 'cascade');
	}

	/**
	 * Check whether Windsurf is installed by looking for its Cascade directory.
	 * Works regardless of whether we are running inside Windsurf or VS Code.
	 */
	isWindsurfInstalled(): boolean {
		try {
			return fs.existsSync(this.getCascadeDir());
		} catch {
			return false;
		}
	}

	/**
	 * Discover Windsurf Cascade sessions from local .pb files.
	 * Used as a fallback when the extension is running in VS Code (not Windsurf).
	 * Returns basic metadata — token counts are not available without the API.
	 */
	async getWindsurfCascadeSessionFiles(): Promise<SessionFileDetails[]> {
		const cascadeDir = this.getCascadeDir();
		try {
			const entries = await fs.promises.readdir(cascadeDir);
			const pbFiles = entries.filter(f => f.endsWith('.pb'));

			const sessions: SessionFileDetails[] = [];
			for (const pbFile of pbFiles) {
				const trajectoryId = pbFile.slice(0, -3); // strip .pb
				const filePath = path.join(cascadeDir, pbFile);
				let stat: fs.Stats;
				try {
					stat = await fs.promises.stat(filePath);
				} catch {
					continue;
				}

				sessions.push({
					file: `windsurf://trajectory/${trajectoryId}`,
					modified: stat.mtime.toISOString(),
					size: stat.size,
					interactions: 1,
					tokens: 0,
					contextReferences: {
						file: 0, selection: 0, implicitSelection: 0, symbol: 0,
						codebase: 0, workspace: 0, terminal: 0, vscode: 0,
						terminalLastCommand: 0, terminalSelection: 0, clipboard: 0,
						changes: 0, outputPanel: 0, problemsPanel: 0, pullRequest: 0,
						byKind: {}, copilotInstructions: 0, agentsMd: 0, byPath: {},
					},
					firstInteraction: stat.birthtime.toISOString(),
					lastInteraction: stat.mtime.toISOString(),
					editorSource: 'windsurf',
					editorName: 'Windsurf',
					title: `Windsurf Session`,
				});
			}
			return sessions;
		} catch (error) {
			console.warn('[Windsurf] Could not read cascade directory:', error);
			return [];
		}
	}

	/**
	 * Get Windsurf credentials by intercepting HTTP requests from the Windsurf extension.
	 */
	async getCredentials(): Promise<WindsurfCredentials | null> {
		if (!this.isRunningInWindsurfFamily()) {
			this.log('[Windsurf] Not running in Windsurf/Devin environment — skipping credential capture');
			return null;
		}

		// Return cached credentials if available
		if (this.credentials) {
			if (await this.validateCredentials(this.credentials)) {
				return this.credentials;
			} else {
				this.log('[Windsurf] Cached credentials invalid, clearing...');
				this.credentials = null;
			}
		}

		this.log('[Windsurf] Attempting credential capture...');
		this.credentials = await this.captureCredentials();

		if (!this.credentials) {
			this.log('[Windsurf] Primary capture failed, trying alternative methods...');
			this.credentials = await this.captureCredentialsAlternative();
		}

		this.log(`[Windsurf] Credential capture result: ${this.credentials ? `port=${this.credentials.port}` : 'failed'}`);
		return this.credentials;
	}

	/**
	 * Validate credentials with a health check.
	 */
	private async validateCredentials(credentials: WindsurfCredentials): Promise<boolean> {
		try {
			const response = await this.makeApiCall('GetProcesses', {}, credentials);
			return response.statusCode === 200;
		} catch (error) {
			return false;
		}
	}

	/** Wait for the Windsurf devClient to become ready (up to 10 attempts, 2 s apart). */
	private async waitForDevClient(exports: any): Promise<any | null> {
		console.log('[Windsurf] Waiting for devClient to be ready...');
		for (let attempt = 0; attempt < 10; attempt++) {
			const devClient = exports.devClient();
			console.log(`[Windsurf] DevClient attempt ${attempt + 1}: ${!!devClient}`);
			if (devClient) { return devClient; }
			await new Promise(resolve => setTimeout(resolve, 2000));
		}
		return null;
	}

	/** Trigger devClient methods to cause HTTP requests so credentials can be intercepted. */
	private async triggerDevClientForCsrf(devClient: any, hasCsrf: () => boolean): Promise<void> {
		for (const method of Object.keys(devClient)) {
			if (typeof devClient[method] !== 'function') { continue; }
			console.log(`[Windsurf] Trying method: ${method}`);
			try {
				await Promise.race([
					devClient[method]({}),
					new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 5000)),
				]);
			} catch (error) {
				console.log(`[Windsurf] Method ${method} failed (expected): ${error instanceof Error ? error.message : String(error)}`);
			}
			if (hasCsrf()) { break; }
		}
	}

	/** Search Windsurf extension exports for a port + CSRF token pair. */
	private findCredentialsInExtensionExports(exports: any): WindsurfCredentials | null {
		for (const key of Object.keys(exports)) {
			const value = exports[key];
			if (!value || typeof value !== 'object') { continue; }
			if (!(value.port || value.token || value.csrf)) { continue; }
			console.log(`[Windsurf] Found potential credentials in exports.${key}`);
			const port = value.port || value.serverPort || value.languageServerPort;
			const csrf = value.token || value.csrf || value.authToken;
			if (port && csrf) { return { csrf: String(csrf), port: Number(port) }; }
		}
		return null;
	}

	/**
	 * Capture credentials by monkey-patching http.ClientRequest.
	 */
	private async captureCredentials(): Promise<WindsurfCredentials | null> {
		console.log('[Windsurf] Starting credentials capture...');
		
		// 1. Get reference to Windsurf extension
		const ext = vscode.extensions.getExtension('codeium.windsurf');
		console.log(`[Windsurf] Extension found: ${!!ext}, active: ${ext?.isActive}`);
		if (!ext?.isActive) {
			console.warn('Windsurf extension not found or not active');
			return null;
		}

		const exports = ext.exports;
		console.log(`[Windsurf] Extension exports available: ${!!exports}`);
		if (!exports || typeof exports.devClient !== 'function') {
			console.warn('Windsurf extension devClient not available');
			return null;
		}

		// 2. Wait for devClient to be ready
		const devClient = await this.waitForDevClient(exports);
		if (!devClient) {
			console.warn('Windsurf devClient not ready after timeout');
			return null;
		}
		console.log(`[Windsurf] DevClient ready, available methods: ${Object.keys(devClient).filter(k => typeof devClient[k] === 'function').join(', ')}`);

		// 3. Patch ClientRequest to intercept headers
		let csrf = '';
		let port = 0;
		const origEnd = http.ClientRequest.prototype.end;
		const origWrite = http.ClientRequest.prototype.write;

		const capture = function (this: http.ClientRequest) {
			const token = this.getHeader('x-codeium-csrf-token');
			const host = this.getHeader('host');
			console.log(`[Windsurf] HTTP Request intercepted - CSRF token: ${!!token}, Host: ${host}`);
			if (token && !csrf) {
				csrf = String(token);
				console.log(`[Windsurf] Captured CSRF token: ${csrf.substring(0, 10)}...`);
				if (host) {
					const m = String(host).match(/:(\d+)/);
					if (m) {
						port = Number(m[1]);
						console.log(`[Windsurf] Captured port: ${port}`);
					}
				}
			}
		};

		http.ClientRequest.prototype.end = function (this: any, ...a: any[]) {
			capture.call(this);
			return origEnd.apply(this, a as any);
		};
		http.ClientRequest.prototype.write = function (this: any, ...a: any[]) {
			capture.call(this);
			return origWrite.apply(this, a as any);
		};

		try {
			// 4. Trigger devClient method to cause HTTP request
			console.log('[Windsurf] Triggering devClient methods to capture credentials...');
			await this.triggerDevClientForCsrf(devClient, () => !!csrf);
			if (csrf) { console.log('[Windsurf] Credentials captured successfully!'); }
		} finally {
			// Always restore originals
			http.ClientRequest.prototype.end = origEnd;
			http.ClientRequest.prototype.write = origWrite;
		}

		const result = csrf && port ? { csrf, port } : null;
		console.log(`[Windsurf] Credential capture result: ${result ? `CSRF=${result.csrf.substring(0, 10)}..., Port=${result.port}` : 'null'}`);
		return result;
	}

	/**
	 * Alternative credential capture method - tries different approaches.
	 */
	private async captureCredentialsAlternative(): Promise<WindsurfCredentials | null> {
		console.log('[Windsurf] Trying alternative credential capture methods...');
		
		// Method 1: Try to get credentials from environment variables or configuration
		const envPort = process.env.WINDSURF_PORT || process.env.CODEIUM_PORT;
		const envToken = process.env.WINDSURF_TOKEN || process.env.CODEIUM_TOKEN;
		
		if (envPort && envToken) {
			console.log('[Windsurf] Found credentials in environment variables');
			return { csrf: envToken, port: parseInt(envPort) };
		}
		
		// Method 2: Try common ports for Windsurf language server
		const commonPorts = [6060, 6061, 6062, 6063, 8080, 8081, 9090, 9091];
		console.log('[Windsurf] Trying common ports for Windsurf language server...');
		
		for (const port of commonPorts) {
			try {
				// Try to make a simple health check to each port
				const response = await this.makeApiCall('GetProcesses', {}, { csrf: 'dummy', port });
				if (response.statusCode === 400 || response.statusCode === 401) {
					// Port is alive but needs proper CSRF - this is likely the right port
					console.log(`[Windsurf] Found active Windsurf server on port ${port}, but need proper CSRF`);
					// We can't proceed without CSRF, but at least we know the port
					// Return null to let the main method handle it
					return null;
				}
			} catch (error) {
				// Expected for most ports - continue trying
				continue;
			}
		}
		
		// Method 3: Try to access Windsurf's internal state directly
		try {
			const ext = vscode.extensions.getExtension('codeium.windsurf');
			if (ext?.isActive && ext.exports) {
				console.log('[Windsurf] Checking Windsurf extension exports for alternative access...');
				const found = this.findCredentialsInExtensionExports(ext.exports);
				if (found) { return found; }
			}
		} catch (error) {
			console.log('[Windsurf] Alternative access failed:', error);
		}
		
		console.log('[Windsurf] All alternative methods failed');
		return null;
	}

	/**
	 * Make an API call to the Windsurf language server.
	 */
	private async makeApiCall(
		methodName: string,
		body: any,
		credentials?: WindsurfCredentials
	): Promise<http.IncomingMessage> {
		const creds = credentials || this.credentials;
		if (!creds) {
			throw new Error('No Windsurf credentials available');
		}

		return new Promise((resolve, reject) => {
			const data = JSON.stringify(body);
			const options = {
				hostname: '127.0.0.1',
				port: creds.port,
				path: `/exa.language_server_pb.LanguageServerService/${methodName}`,
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'Connect-Protocol-Version': '1',
					'x-codeium-csrf-token': creds.csrf,
					'Content-Length': Buffer.byteLength(data),
				},
			};

			const req = http.request(options, (res) => {
				resolve(res);
			});

			req.on('error', (error) => {
				reject(error);
			});

			req.write(data);
			req.end();
		});
	}

	/**
	 * Get all Cascade trajectory summaries.
	 */
	async getAllCascadeTrajectories(): Promise<GetAllCascadeTrajectoriesResponse | null> {
		console.log('[Windsurf] Getting all Cascade trajectories...');
		const credentials = await this.getCredentials();
		if (!credentials) {
			console.warn('Windsurf: No credentials available for API call');
			return null;
		}

		console.log(`[Windsurf] Making API call to GetAllCascadeTrajectories with credentials: CSRF=${credentials.csrf.substring(0, 10)}..., Port=${credentials.port}`);
		try {
			const response = await this.makeApiCall('GetAllCascadeTrajectories', { include_user_inputs: false }, credentials);
			
			console.log(`[Windsurf] API response status: ${response.statusCode}`);
			if (response.statusCode !== 200) {
				throw new Error(`API call failed with status ${response.statusCode}`);
			}

			const data = await this.readResponseData(response);
			console.log(`[Windsurf] Raw API response data: ${data.substring(0, 200)}${data.length > 200 ? '...' : ''}`);
			const result = JSON.parse(data) as GetAllCascadeTrajectoriesResponse;
			
			// Validate response structure
			if (!result || typeof result !== 'object' || !('trajectorySummaries' in result)) {
				console.error('[Windsurf] Invalid response structure:', result);
				throw new Error('Invalid response structure from GetAllCascadeTrajectories');
			}
			
			const trajectoryCount = Object.keys(result.trajectorySummaries).length;
			console.log(`[Windsurf] Successfully retrieved ${trajectoryCount} trajectories`);
			// Log details of each trajectory for debugging
			for (const [cascadeId, summary] of Object.entries(result.trajectorySummaries)) {
				console.log(`[Windsurf] Trajectory ${cascadeId}: status=${summary.status}, type=${summary.trajectoryType}, steps=${summary.stepCount}`);
			}
			return result;
		} catch (error) {
			// Remove newlines from the (attacker-influenceable) error message before
			// logging, so it can't be used to forge extra log lines.
			console.error('[Windsurf] Failed to get Cascade trajectories:', String(error).replace(/\n|\r/g, ''));
			// Clear credentials on error
			this.credentials = null;
			return null;
		}
	}

	/**
	 * Get a single (size-capped) page of steps for a Cascade trajectory, starting at
	 * `stepOffset`. The server caps each response by payload size (not a fixed count),
	 * so callers must page through with `getAllTrajectorySteps` to get the full list.
	 */
	async getCascadeTrajectorySteps(cascadeId: string, stepOffset = 0): Promise<GetCascadeTrajectoryStepsResponse | null> {
		const credentials = await this.getCredentials();
		if (!credentials) {return null;}

		try {
			const response = await this.makeApiCall('GetCascadeTrajectorySteps', { cascade_id: cascadeId, step_offset: stepOffset }, credentials);
			
			if (response.statusCode !== 200) {
				throw new Error(`API call failed with status ${response.statusCode}`);
			}

			const data = await this.readResponseData(response);
			return JSON.parse(data) as GetCascadeTrajectoryStepsResponse;
		} catch (error) {
			// Remove newlines from the (attacker-influenceable) cascadeId/error
			// message before logging, so they can't be used to forge extra log lines.
			const safeCascadeId = String(cascadeId).replace(/\n|\r/g, '');
			const safeError = String(error).replace(/\n|\r/g, '');
			console.error(`Failed to get Cascade trajectory steps for ${safeCascadeId}:`, safeError);
			// Clear credentials on error
			this.credentials = null;
			return null;
		}
	}

	/**
	 * Fetch ALL steps for a trajectory by paging through `step_offset`.
	 *
	 * GetCascadeTrajectorySteps caps each response by payload size (e.g. 75 of 665 steps
	 * for a large session), which would otherwise undercount user turns and tokens. The
	 * request supports a `step_offset` field (see GetCascadeTrajectoryStepsRequest in the
	 * Windsurf language-server proto), so we accumulate pages until we have `expectedCount`
	 * steps or a page comes back empty.
	 */
	async getAllTrajectorySteps(cascadeId: string, expectedCount: number): Promise<CascadeTrajectoryStep[]> {
		const all: CascadeTrajectoryStep[] = [];
		const maxPages = 100; // safety valve against an unexpected non-advancing server
		let prevFirstSignature: string | undefined;
		for (let page = 0; page < maxPages; page++) {
			const response = await this.getCascadeTrajectorySteps(cascadeId, all.length);
			const batch = response?.steps;
			if (!batch || batch.length === 0) { break; }
			// Guard: if step_offset were ignored, every page would repeat the same first step.
			// Detect that and stop rather than accumulating duplicates (which would inflate
			// the user-turn / token counts).
			const firstSignature = JSON.stringify(batch[0]).slice(0, 200);
			if (page > 0 && firstSignature === prevFirstSignature) { break; }
			prevFirstSignature = firstSignature;
			all.push(...batch);
			if (expectedCount > 0 && all.length >= expectedCount) { break; }
		}
		return all;
	}

	/**
	 * Read response data from HTTP response.
	 */
	private async readResponseData(response: http.IncomingMessage): Promise<string> {
		return new Promise((resolve, reject) => {
			let data = '';
			response.on('data', (chunk) => {
				data += chunk;
			});
			response.on('end', () => {
				resolve(data);
			});
			response.on('error', (error) => {
				reject(error);
			});
		});
	}

	/**
	 * Count the number of real user turns in a trajectory. Windsurf's `stepCount`
	 * counts every internal agent step (model calls, tool runs, etc.); the actual
	 * number of user messages is the count of CORTEX_STEP_TYPE_USER_INPUT steps.
	 */
	countUserTurns(steps: CascadeTrajectoryStep[]): number {
		return steps.reduce((n, s) => n + (s.type === 'CORTEX_STEP_TYPE_USER_INPUT' ? 1 : 0), 0);
	}

	/**
	 * Extract token usage from Cascade trajectory steps.
	 *
	 * Token usage is reported on CORTEX_STEP_TYPE_PLANNER_RESPONSE steps via
	 * string-encoded `metadata.cumulativeTokensAtStep` / `inputTokens` /
	 * `cacheReadTokens` fields (NOT on USER_INPUT steps, and NOT in the
	 * 'Token Usage' dimension group, which Windsurf no longer emits).
	 *
	 * `cumulativeTokensAtStep` is the running total for the whole trajectory, so the
	 * maximum across planner responses is the session's total token count. `inputTokens`
	 * and `cacheReadTokens` are per-step, so they are summed for an input breakdown.
	 */
	extractTokenUsage(steps: CascadeTrajectoryStep[]): { totalTokens: number; inputTokens: number; cachedTokens: number } {
		let totalTokens = 0;
		let inputTokens = 0;
		let cachedTokens = 0;

		const parse = (value: string | undefined): number => {
			if (!value || !/^\d+$/.test(value)) { return 0; }
			const n = Number(value);
			return Number.isSafeInteger(n) ? n : 0;
		};

		for (const step of steps) {
			if (step.type !== 'CORTEX_STEP_TYPE_PLANNER_RESPONSE') { continue; }
			const meta = step.metadata;
			if (!meta) { continue; }

			const cumulative = parse(meta.cumulativeTokensAtStep);
			if (cumulative > totalTokens) { totalTokens = cumulative; }
			inputTokens += parse(meta.inputTokens);
			cachedTokens += parse(meta.cacheReadTokens);
		}

		return { totalTokens, inputTokens, cachedTokens };
	}

	/**
	 * Get model display name from Windsurf model UID.
	 */
	getModelDisplayName(modelUid: string): string {
		// Map Windsurf model UIDs to display names
		const modelMap: { [key: string]: string } = {
			'claude-sonnet-4': 'Claude Sonnet 4',
			'claude-sonnet-4-5': 'Claude Sonnet 4.5',
			'gpt-4o': 'GPT-4o',
			'gpt-4o-mini': 'GPT-4o Mini',
			'claude-3-5-sonnet-20241022': 'Claude 3.5 Sonnet',
			'claude-3-haiku-20240307': 'Claude 3 Haiku',
		};
		
		return modelMap[modelUid] || modelUid;
	}

	/**
	 * Build a standard ModelUsage map for a Windsurf trajectory so the rest of the
	 * extension (Today's Sessions breakdown, cost, model column) can treat it like
	 * any other editor.
	 *
	 * Windsurf reports `inputTokens` (uncached input) and `cacheReadTokens` separately,
	 * whereas the extension's ModelUsage.inputTokens means TOTAL input INCLUDING cache
	 * reads — so the two are combined here and cachedReadTokens carries the cache portion.
	 *
	 * Output tokens are not reported directly. `cumulativeTokensAtStep` (the session
	 * total) excludes cache reads (it is orders of magnitude smaller than the summed
	 * cacheReadTokens), so it represents cumulative (uncached input + output). Output is
	 * therefore derived as totalTokens - inputTokens, clamped at 0 to stay safe if that
	 * assumption ever breaks.
	 */
	buildModelUsage(usage: { totalTokens: number; inputTokens: number; cachedTokens: number }, modelUid: string | undefined): ModelUsage {
		const model = (modelUid ? this.getModelDisplayName(modelUid) : '') || 'Windsurf';
		const outputTokens = Math.max(0, usage.totalTokens - usage.inputTokens);
		return {
			[model]: {
				inputTokens: usage.inputTokens + usage.cachedTokens,
				outputTokens,
				cachedReadTokens: usage.cachedTokens,
				sessions: 0,
			},
		};
	}

	/**
	 * Map a Cascade step type to a friendly tool label, or undefined if the step is
	 * not a tool invocation (planner responses, user inputs, checkpoints, etc.).
	 */
	private static readonly TOOL_STEP_LABELS: { [type: string]: string } = {
		CORTEX_STEP_TYPE_CODE_ACTION: 'Edit file',
		CORTEX_STEP_TYPE_RUN_COMMAND: 'Run command',
		CORTEX_STEP_TYPE_VIEW_FILE: 'View file',
		CORTEX_STEP_TYPE_GREP_SEARCH: 'Grep search',
		CORTEX_STEP_TYPE_FIND: 'Find',
		CORTEX_STEP_TYPE_LIST_DIRECTORY: 'List directory',
		CORTEX_STEP_TYPE_TODO_LIST: 'Todo list',
		CORTEX_STEP_TYPE_RETRIEVE_MEMORY: 'Retrieve memory',
	};

	/**
	 * Count tool invocations in a trajectory, grouped by friendly tool name. Only
	 * action steps (edits, commands, searches, etc.) are counted — planner responses,
	 * user inputs, checkpoints and errors are not tools.
	 */
	countToolCalls(steps: CascadeTrajectoryStep[]): { total: number; byTool: { [tool: string]: number } } {
		const byTool: { [tool: string]: number } = {};
		let total = 0;
		for (const step of steps) {
			const label = WindsurfDataAccess.TOOL_STEP_LABELS[step.type];
			if (!label) { continue; }
			byTool[label] = (byTool[label] || 0) + 1;
			total++;
		}
		return { total, byTool };
	}

	/**
	 * Resolve a windsurf://trajectory/{id} session file to its SessionFileDetails.
	 * Tries the API first (only works inside Windsurf), then falls back to .pb file metadata.
	 * Returns null if the session cannot be found by either method.
	 */
	async resolveSession(sessionFile: string): Promise<SessionFileDetails | null> {
		// Try API-based sessions first (available when running inside Windsurf)
		try {
			const apiSessions = await this.getWindsurfSessions();
			const found = apiSessions.find(s => s.file === sessionFile);
			if (found) { return found; }
		} catch {
			// API unavailable - fall through to file-based
		}

		// Fall back to .pb file metadata. The origin app cannot be reliably determined
		// from the file alone (Windsurf and Devin share the same Cascade directory), so
		// the label is taken from the sessionFile's own virtual-path scheme, which was
		// decided at discovery time (see getWindsurfCascadeSessionFiles / getHostEditorLabel).
		const trajectoryId = this.extractTrajectoryId(sessionFile);
		const cascadeDir = this.getCascadeDir();
		const pbPath = path.join(cascadeDir, `${trajectoryId}.pb`);
		const fallbackName = this.getFamilyEditorName(sessionFile);
		const fallbackSource = fallbackName === 'Devin' ? 'devin' : 'windsurf';
		try {
			const stat = await fs.promises.stat(pbPath);
			return {
				file: sessionFile,
				modified: stat.mtime.toISOString(),
				size: stat.size,
				interactions: 1,
				tokens: 0,
				contextReferences: {
					file: 0, selection: 0, implicitSelection: 0, symbol: 0,
					codebase: 0, workspace: 0, terminal: 0, vscode: 0,
					terminalLastCommand: 0, terminalSelection: 0, clipboard: 0,
					changes: 0, outputPanel: 0, problemsPanel: 0, pullRequest: 0,
					byKind: {}, copilotInstructions: 0, agentsMd: 0, byPath: {},
				},
				firstInteraction: stat.birthtime.toISOString(),
				lastInteraction: stat.mtime.toISOString(),
				editorSource: fallbackSource,
				editorName: fallbackName,
				title: `${fallbackName} Session`,
			};
		} catch {
			return null;
		}
	}

	/**
	 * Simple test method to verify basic functionality
	 */
	async testMethod(): Promise<string> {
		console.log('[Windsurf] testMethod() called');
		return 'test-method-works';
	}

	/**
	 * Returns the later of two ISO timestamps, ignoring missing/unparseable values.
	 * Used so an actively-running session is bucketed by its most recent activity
	 * (lastModifiedTime advances as the agent works, even when lastUserInputTime is stale).
	 */
	private pickLatestTimestamp(...candidates: Array<string | undefined>): string | undefined {
		let best: string | undefined;
		let bestMs = -Infinity;
		for (const c of candidates) {
			if (!c) { continue; }
			const ms = Date.parse(c);
			if (Number.isNaN(ms)) { continue; }
			if (ms > bestMs) { bestMs = ms; best = c; }
		}
		return best;
	}

	/**
	 * API-based session discovery (requires running inside Windsurf with credentials).
	 */
	async getWindsurfSessionsV2(): Promise<SessionFileDetails[]> {
		this.log('[Windsurf] getWindsurfSessionsV2() ENTRY POINT');

		try {
			this.log('[Windsurf] === STARTING API SESSION DISCOVERY ===');
			const sessions: SessionFileDetails[] = [];

			const config = vscode.workspace.getConfiguration('aiEngineeringFluency');
			const windsurfEnabled = config.get<boolean>('windsurf.enabled', true);
			this.log(`[Windsurf] enabled=${windsurfEnabled}, isRunningInWindsurf=${this.isRunningInWindsurf()}`);

			if (!windsurfEnabled) {
				this.log('[Windsurf] Windsurf integration disabled in configuration');
				return [];
			}

			this.log('[Windsurf] Fetching trajectories via API...');
			const trajectories = await this.getAllCascadeTrajectories();
			this.log(`[Windsurf] Got trajectories: ${trajectories ? 'YES' : 'NO'}`);

			if (!trajectories || !trajectories.trajectorySummaries) {
				this.log('[Windsurf] No trajectories available from API');
				return [];
			}

			const trajectoryIds = Object.keys(trajectories.trajectorySummaries);
			this.log(`[Windsurf] Found ${trajectoryIds.length} trajectory summaries`);

			for (const trajectoryId of trajectoryIds) {
				const summary = trajectories.trajectorySummaries[trajectoryId];
				const session = await this.buildSessionFromTrajectory(trajectoryId, summary);
				if (session) { sessions.push(session); }
			}

			this.log(`[Windsurf] === API DISCOVERY COMPLETE — ${sessions.length} sessions ===`);
			return sessions;
		} catch (error) {
			this.log(`[Windsurf] Exception in getWindsurfSessionsV2(): ${error}`);
			return [];
		}
	}

	/** Fetch step data for a trajectory and return token/interaction counts. */
	private async fetchTrajectoryStepData(
		trajectoryId: string,
		summary: CascadeTrajectorySummary,
		activityScore: number,
		lastInteraction: string | null | undefined,
		utcDayKey: string,
	): Promise<{ interactions: number; tokens: number; cachedTokens: number; usedRealData: boolean; modelUsage?: ModelUsage; toolCalls?: { total: number; byTool: { [tool: string]: number } } }> {
		try {
			const steps = await this.getAllTrajectorySteps(trajectoryId, activityScore);
			if (steps.length === 0) { return { interactions: 1, tokens: 0, cachedTokens: 0, usedRealData: false }; }
			const usage = this.extractTokenUsage(steps);
			const stepTurns = this.countUserTurns(steps);
			const interactions = Math.max(1, stepTurns);
			const tokens = usage.totalTokens;
			const cachedTokens = usage.cachedTokens;
			const modelUsage = this.buildModelUsage(usage, summary.lastGeneratorModelUid);
			const toolCalls = this.countToolCalls(steps);
			const partial = steps.length < activityScore;
			if (usage.inputTokens > usage.totalTokens) {
				this.log(`[Windsurf] trajectory ${trajectoryId}: inputTokens(${usage.inputTokens}) > totalTokens(${usage.totalTokens}) — output clamped to 0`);
			}
			this.log(`[Windsurf] trajectory ${trajectoryId}: stepCount=${activityScore} stepsFetched=${steps.length}${partial ? ' (PARTIAL steps)' : ''} userTurns=${stepTurns} tokens(total=${usage.totalTokens}, input=${usage.inputTokens}, cached=${usage.cachedTokens}) tools=${toolCalls.total} → interactions=${interactions} tokens=${tokens} lastInteraction=${lastInteraction ?? '(none)'} (UTC day ${utcDayKey})`);
			return { interactions, tokens, cachedTokens, usedRealData: true, modelUsage, toolCalls };
		} catch (stepError) {
			this.log(`[Windsurf] trajectory ${trajectoryId}: failed to fetch steps (${stepError}); no token data`);
			return { interactions: 1, tokens: 0, cachedTokens: 0, usedRealData: false };
		}
	}

	/**
	 * Build a SessionFileDetails for a single Cascade trajectory: fetch its steps,
	 * derive real token/turn/tool/model breakdowns, and shape it like any other editor's
	 * session. Returns null for empty (stepCount=0) trajectories.
	 */
	private async buildSessionFromTrajectory(trajectoryId: string, summary: CascadeTrajectorySummary): Promise<SessionFileDetails | null> {
		const activityScore = summary.stepCount || 0;
		const lastInteraction = this.pickLatestTimestamp(summary.lastUserInputTime, summary.lastModifiedTime);
		const utcDayKey = lastInteraction ? lastInteraction.slice(0, 10) : '(none)';
		if (activityScore === 0) {
			this.log(`[Windsurf] trajectory ${trajectoryId}: stepCount=0 → SKIPPED`);
			return null;
		}

		// Derive REAL token counts and user-turn counts. `stepCount` counts every
		// internal agent step (model calls, tool runs), and tokens were previously a
		// rough `stepCount * 100` estimate — both massively overstate reality.
		//
		// Turn counting uses CORTEX_STEP_TYPE_USER_INPUT steps. We page through the full
		// step list via step_offset so large sessions are not undercounted by the
		const stepData = await this.fetchTrajectoryStepData(trajectoryId, summary, activityScore, lastInteraction, utcDayKey);
		if (!stepData.usedRealData) {
			this.log(`[Windsurf] trajectory ${trajectoryId}: stepCount=${activityScore} (no steps returned) → interactions=${stepData.interactions} tokens=${stepData.tokens} lastInteraction=${lastInteraction ?? '(none)'} (UTC day ${utcDayKey})`);
		}

		// Attribute the session to whichever app is actually hosting the extension right
		// now (Windsurf or Devin) — both write to the same Cascade folder, so the virtual
		// path scheme and editor label are decided here at live-API discovery time.
		const host = this.getHostEditorLabel();
		return {
			file: `${host.scheme}${trajectoryId}`,
			modified: summary.lastModifiedTime || new Date().toISOString(),
			size: activityScore,
			interactions: stepData.interactions,
			tokens: stepData.tokens,
			...(stepData.modelUsage ? { modelUsage: stepData.modelUsage } : {}),
			...(stepData.cachedTokens ? { cachedTokens: stepData.cachedTokens } : {}),
			...(stepData.toolCalls ? { toolCalls: stepData.toolCalls } : {}),
			contextReferences: { file: 0, selection: 0, implicitSelection: 0, symbol: 0, codebase: 0, workspace: 0, terminal: 0, vscode: 0, terminalLastCommand: 0, terminalSelection: 0, clipboard: 0, changes: 0, outputPanel: 0, problemsPanel: 0, pullRequest: 0, byKind: {}, copilotInstructions: 0, agentsMd: 0, byPath: {} },
			firstInteraction: summary.createdTime,
			lastInteraction: lastInteraction || summary.lastModifiedTime,
			editorSource: host.source,
			editorName: host.name,
			title: summary.summary || `${host.name} Session ${trajectoryId}`
		};
	}

	/**
	 * Process all Windsurf trajectories and return session details.
	 * Tries the API first (full token data), falls back to .pb file metadata when API is unavailable.
	 */
	async getWindsurfSessions(): Promise<SessionFileDetails[]> {
		const now = Date.now();
		if (this.sessionCache && this.sessionCache.expiresAt > now) {
			return this.sessionCache.sessions;
		}
		// Coalesce concurrent cache-miss calls into a single fetch.
		if (!this._sessionFetchInFlight) {
			this.log('[Windsurf] getWindsurfSessions() fetching sessions (cache miss)');
			this._sessionFetchInFlight = this.discoverWindsurfSessions()
				.then(sessions => {
					this.sessionCache = { sessions, expiresAt: Date.now() + WindsurfDataAccess.SESSION_CACHE_TTL_MS };
					this.log(`[Windsurf] getWindsurfSessions() cached ${sessions.length} session(s)`);
					return sessions;
				})
				.finally(() => { this._sessionFetchInFlight = null; });
		}
		return this._sessionFetchInFlight;
	}

	private async discoverWindsurfSessions(): Promise<SessionFileDetails[]> {
		const apiSessions = await this.getWindsurfSessionsV2();
		if (apiSessions.length > 0) {
			this.log(`[Windsurf] API returned ${apiSessions.length} session(s)`);
			return apiSessions;
		}
		this.log('[Windsurf] API returned no sessions — falling back to .pb file discovery');
		const fileSessions = await this.getWindsurfCascadeSessionFiles();
		this.log(`[Windsurf] File-based discovery found ${fileSessions.length} session(s)`);
		return fileSessions;
	}

	/** Extract workspace and repository names from a trajectory summary. */
	private extractWorkspaceInfoOriginal(summary: CascadeTrajectorySummary): { workspaceName: string; repositoryName: string } {
		let workspaceName = 'Unknown';
		let repositoryName = 'Unknown';
		if (summary.workspaces && Array.isArray(summary.workspaces) && summary.workspaces.length > 0) {
			const workspace = summary.workspaces[0];
			if (workspace && typeof workspace === 'object') {
				if (workspace.workspaceFolderAbsoluteUri && typeof workspace.workspaceFolderAbsoluteUri === 'string') {
					const uriParts = workspace.workspaceFolderAbsoluteUri.split('/');
					workspaceName = uriParts[uriParts.length - 1] || workspaceName;
				}
				if (workspace.repository?.computedName) {
					repositoryName = String(workspace.repository.computedName);
				}
			}
		}
		return { workspaceName, repositoryName };
	}

	/** Process a single trajectory for the original debug method. Returns null if the trajectory should be skipped. */
	private async processOriginalTrajectory(cascadeId: string, summary: CascadeTrajectorySummary): Promise<SessionFileDetails | null> {
		if (!summary || typeof summary !== 'object') {
			console.warn(`[Windsurf] Invalid trajectory summary for ${cascadeId}, skipping`);
			return null;
		}
		console.log(`[Windsurf] Getting steps for trajectory ${cascadeId}...`);
		const steps = await this.getCascadeTrajectorySteps(cascadeId);
		if (!steps || !steps.steps) {
			console.warn(`[Windsurf] No steps found for trajectory ${cascadeId}, skipping`);
			return null;
		}
		console.log(`[Windsurf] Found ${steps.steps.length} steps for trajectory ${cascadeId}`);
		const tokenUsage = this.extractTokenUsage(steps.steps);
		const totalTokens = tokenUsage.totalTokens;
		console.log(`[Windsurf] Token usage for ${cascadeId}: total=${totalTokens}, input=${tokenUsage.inputTokens}, cached=${tokenUsage.cachedTokens}`);
		if (totalTokens === 0) {
			console.log(`[Windsurf] Skipping trajectory ${cascadeId} - no tokens found`);
			return null;
		}
		let createdDate: Date;
		try {
			createdDate = new Date(summary.createdTime);
			if (isNaN(createdDate.getTime())) {
				console.warn(`Invalid createdTime for trajectory ${cascadeId}: ${summary.createdTime}`);
				return null;
			}
		} catch (error) {
			console.warn(`Failed to parse createdTime for trajectory ${cascadeId}: ${error}`);
			return null;
		}
		const { repositoryName } = this.extractWorkspaceInfoOriginal(summary);
		return {
			file: `windsurf://${cascadeId}`,
			size: 0,
			modified: summary.lastModifiedTime,
			interactions: summary.stepCount,
			tokens: totalTokens,
			contextReferences: { file: 0, selection: 0, implicitSelection: 0, symbol: 0, codebase: 0, workspace: 0, terminal: 0, vscode: 0, terminalLastCommand: 0, terminalSelection: 0, clipboard: 0, changes: 0, outputPanel: 0, problemsPanel: 0, pullRequest: 0, byKind: {}, copilotInstructions: 0, agentsMd: 0, byPath: {} },
			firstInteraction: summary.createdTime,
			lastInteraction: summary.lastUserInputTime || summary.lastModifiedTime,
			editorSource: 'windsurf',
			editorName: 'Windsurf',
			title: summary.summary || `Cascade ${cascadeId}`,
			repository: repositoryName,
		};
	}

	/**
	 * Original version (commented out for debugging)
	 */
	async getWindsurfSessionsOriginal(): Promise<SessionFileDetails[]> {
		console.log('[Windsurf] getWindsurfSessions() ENTRY POINT');
		try {
			console.log('[Windsurf] === STARTING SESSION DISCOVERY ===');
			const sessions: SessionFileDetails[] = [];
			const config = vscode.workspace.getConfiguration('aiEngineeringFluency');
			const windsurfEnabled = config.get<boolean>('windsurf.enabled', true);
			console.log(`[Windsurf] Configuration check - enabled: ${windsurfEnabled}`);
			if (!windsurfEnabled) {
				console.log('[Windsurf] Integration is disabled in configuration');
				return sessions;
			}
			console.log('[Windsurf] Fetching trajectories...');
			const trajectories = await this.getAllCascadeTrajectories();
			if (!trajectories || !trajectories.trajectorySummaries) {
				console.log('[Windsurf] No Cascade trajectories found or invalid response');
				return sessions;
			}
			console.log(`[Windsurf] Processing ${Object.keys(trajectories.trajectorySummaries).length} trajectories...`);
			for (const [cascadeId, summary] of Object.entries(trajectories.trajectorySummaries)) {
				console.log(`[Windsurf] Processing trajectory ${cascadeId}...`);
				try {
					const session = await this.processOriginalTrajectory(cascadeId, summary);
					if (session) {
						console.log(`[Windsurf] Successfully processed session ${cascadeId}: ${session.title} (${session.tokens} tokens)`);
						sessions.push(session);
					}
				} catch (error) {
					console.error(`Failed to process Windsurf trajectory ${cascadeId}:`, error);
				}
			}
			console.log(`[Windsurf] Session processing complete. Returning ${sessions.length} sessions.`);
			return sessions;
		} catch (error) {
			console.error('[Windsurf] Error in getWindsurfSessions:', error);
			return [];
		}
	}

	/**
	 * Clear cached credentials (useful for testing or when Windsurf restarts).
	 */
	clearCredentialsCache(): void {
		this.credentials = null;
	}

	/** Test API connectivity using GetProcesses. */
	private async runApiConnectivityTest(credentials: WindsurfCredentials | null): Promise<{ success: boolean; statusCode?: number; error?: string }> {
		if (!credentials) { return { success: false, error: 'No credentials available' }; }
		try {
			const response = await this.makeApiCall('GetProcesses', {}, credentials);
			return { success: true, statusCode: response.statusCode };
		} catch (error) {
			return { success: false, error: error instanceof Error ? error.message : String(error) };
		}
	}

	/** Return trajectory session count from the API. */
	private async getSessionStats(): Promise<{ available: boolean; count?: number; error?: string }> {
		try {
			const trajectories = await this.getAllCascadeTrajectories();
			return { available: !!trajectories, count: trajectories ? Object.keys(trajectories.trajectorySummaries).length : 0 };
		} catch (error) {
			return { available: false, error: error instanceof Error ? error.message : String(error) };
		}
	}

	/**
	 * Run diagnostics to help troubleshoot Windsurf session detection issues.
	 */
	async runDiagnostics(): Promise<{ [key: string]: any }> {
		console.log('[Windsurf] Running diagnostics...');
		const diagnostics: { [key: string]: any } = {};

		diagnostics.environment = {
			isRunningInWindsurf: this.isRunningInWindsurf(),
			isRunningInDevin: this.isRunningInDevin(),
			appName: vscode.env.appName,
		};

		const ext = vscode.extensions.getExtension('codeium.windsurf');
		diagnostics.extension = {
			found: !!ext,
			active: ext?.isActive,
			packageJSON: ext?.packageJSON?.version || 'unknown',
		};

		const credentials = await this.getCredentials();
		diagnostics.credentials = {
			available: !!credentials,
			port: credentials?.port || null,
			csrfLength: credentials?.csrf?.length || 0,
		};

		diagnostics.apiTest = await this.runApiConnectivityTest(credentials);

		const config = vscode.workspace.getConfiguration('aiEngineeringFluency');
		diagnostics.configuration = {
			enabled: config.get<boolean>('windsurf.enabled', true),
		};

		diagnostics.sessions = await this.getSessionStats();

		console.log('[Windsurf] Diagnostics complete:', diagnostics);
		return diagnostics;
	}
}

// Extend SessionFileDetails interface to include Windsurf-specific data
declare module './types' {
	interface SessionFileDetails {
		windsurfData?: {
			cascadeId: string;
			trajectoryType: string;
			status: string;
			inputTokens: number;
			outputTokens: number;
			cachedTokens: number;
		};
	}
}
