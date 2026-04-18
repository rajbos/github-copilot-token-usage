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

	constructor(extensionUri: vscode.Uri) {
		this.extensionUri = extensionUri;
	}

	/**
	 * Check if the extension is running inside Windsurf.
	 */
	isRunningInWindsurf(): boolean {
		return vscode.env.appName.toLowerCase().includes('windsurf');
	}

	/**
	 * Check if a session file is a Windsurf session file.
	 * Windsurf uses virtual windsurf://trajectory/{id} paths.
	 */
	isWindsurfSessionFile(filePath: string): boolean {
		return filePath.startsWith('windsurf://trajectory/');
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
						changes: 0, outputPanel: 0, problemsPanel: 0,
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
		if (!this.isRunningInWindsurf()) {
			console.log('[Windsurf] Not running in Windsurf environment');
			return null;
		}

		// Return cached credentials if available
		if (this.credentials) {
			console.log('[Windsurf] Using cached credentials');
			// Validate credentials before returning
			if (await this.validateCredentials(this.credentials)) {
				return this.credentials;
			} else {
				console.log('[Windsurf] Cached credentials invalid, clearing...');
				// Clear invalid credentials
				this.credentials = null;
			}
		}

		// Try multiple credential capture methods
		console.log('[Windsurf] Attempting credential capture...');
		this.credentials = await this.captureCredentials();
		
		// Fallback: try alternative methods if primary fails
		if (!this.credentials) {
			console.log('[Windsurf] Primary capture failed, trying alternative methods...');
			this.credentials = await this.captureCredentialsAlternative();
		}
		
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
		let devClient: any = null;
		console.log('[Windsurf] Waiting for devClient to be ready...');
		for (let attempt = 0; attempt < 10; attempt++) {
			devClient = exports.devClient();
			console.log(`[Windsurf] DevClient attempt ${attempt + 1}: ${!!devClient}`);
			if (devClient) {break;}
			await new Promise(resolve => setTimeout(resolve, 2000));
		}
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
			for (const method of Object.keys(devClient)) {
				if (typeof devClient[method] !== 'function') {continue;}
				console.log(`[Windsurf] Trying method: ${method}`);
				try {
					await Promise.race([
						devClient[method]({}),
						new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 5000)),
					]);
				} catch (error) {
					console.log(`[Windsurf] Method ${method} failed (expected): ${error instanceof Error ? error.message : String(error)}`);
					// Expected - we only need the headers
				}
				if (csrf) {
					console.log('[Windsurf] Credentials captured successfully!');
					break;
				}
			}
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
				// Try to access internal configuration or state
				const exports = ext.exports;
				console.log('[Windsurf] Checking Windsurf extension exports for alternative access...');
				
				// Look for any configuration or state objects
				for (const key of Object.keys(exports)) {
					const value = exports[key];
					if (value && typeof value === 'object') {
						// Look for port or token in nested objects
						if (value.port || value.token || value.csrf) {
							console.log(`[Windsurf] Found potential credentials in exports.${key}`);
							const port = value.port || value.serverPort || value.languageServerPort;
							const csrf = value.token || value.csrf || value.authToken;
							if (port && csrf) {
								return { csrf: String(csrf), port: Number(port) };
							}
						}
					}
				}
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
			console.error('[Windsurf] Failed to get Cascade trajectories:', error);
			// Clear credentials on error
			this.credentials = null;
			return null;
		}
	}

	/**
	 * Get detailed steps for a specific Cascade trajectory.
	 */
	async getCascadeTrajectorySteps(cascadeId: string): Promise<GetCascadeTrajectoryStepsResponse | null> {
		const credentials = await this.getCredentials();
		if (!credentials) {return null;}

		try {
			const response = await this.makeApiCall('GetCascadeTrajectorySteps', { cascade_id: cascadeId }, credentials);
			
			if (response.statusCode !== 200) {
				throw new Error(`API call failed with status ${response.statusCode}`);
			}

			const data = await this.readResponseData(response);
			return JSON.parse(data) as GetCascadeTrajectoryStepsResponse;
		} catch (error) {
			console.error(`Failed to get Cascade trajectory steps for ${cascadeId}:`, error);
			// Clear credentials on error
			this.credentials = null;
			return null;
		}
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
	 * Extract token usage from Cascade trajectory steps.
	 */
	extractTokenUsage(steps: CascadeTrajectoryStep[]): { inputTokens: number; outputTokens: number; cachedTokens: number } {
		let inputTokens = 0;
		let outputTokens = 0;
		let cachedTokens = 0;

		for (const step of steps) {
			if (step.type !== 'CORTEX_STEP_TYPE_USER_INPUT') {continue;}
			
			for (const group of step.metadata?.responseDimensionGroups ?? []) {
				if (group.title !== 'Token Usage') {continue;}
				
				for (const dim of group.dimensions) {
					const value = dim.cumulativeMetric?.value ?? 0;
					if (dim.uid === 'input_tokens') {
						inputTokens += value;
					} else if (dim.uid === 'output_tokens') {
						outputTokens += value;
					} else if (dim.uid === 'cached_input_tokens') {
						cachedTokens += value;
					}
				}
			}
		}

		return { inputTokens, outputTokens, cachedTokens };
	}

	/**
	 * Get model display name from Windsurf model UID.
	 */
	getModelDisplayName(modelUid: string): string {
		// Map Windsurf model UIDs to display names
		const modelMap: { [key: string]: string } = {
			'claude-sonnet-4': 'Claude Sonnet 4',
			'gpt-4o': 'GPT-4o',
			'gpt-4o-mini': 'GPT-4o Mini',
			'claude-3-5-sonnet-20241022': 'Claude 3.5 Sonnet',
			'claude-3-haiku-20240307': 'Claude 3 Haiku',
		};
		
		return modelMap[modelUid] || modelUid;
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

		// Fall back to .pb file metadata
		const trajectoryId = sessionFile.replace('windsurf://trajectory/', '');
		const cascadeDir = this.getCascadeDir();
		const pbPath = path.join(cascadeDir, `${trajectoryId}.pb`);
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
					changes: 0, outputPanel: 0, problemsPanel: 0,
					byKind: {}, copilotInstructions: 0, agentsMd: 0, byPath: {},
				},
				firstInteraction: stat.birthtime.toISOString(),
				lastInteraction: stat.mtime.toISOString(),
				editorSource: 'windsurf',
				editorName: 'Windsurf',
				title: 'Windsurf Session',
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
	 * New method to test if there's a binding issue with getWindsurfSessions
	 */
	async getWindsurfSessionsV2(): Promise<SessionFileDetails[]> {
		// Add logging to confirm method is reached
		console.log('[Windsurf] getWindsurfSessionsV2() ENTRY POINT');
		
		try {
			console.log('[Windsurf] getWindsurfSessionsV2() called');
			console.log('[Windsurf] === STARTING SESSION DISCOVERY ===');
			const sessions: SessionFileDetails[] = [];
			
			// Check if Windsurf is enabled in configuration
			console.log('[Windsurf] About to get configuration...');
			const config = vscode.workspace.getConfiguration('copilotTokenTracker');
			console.log('[Windsurf] Got configuration object');
			const windsurfEnabled = config.get<boolean>('windsurf.enabled', true);
			console.log(`[Windsurf] Configuration check - enabled: ${windsurfEnabled}`);
			
			if (!windsurfEnabled) {
				console.log('[Windsurf] Windsurf integration disabled in configuration');
				return [];
			}
			
			console.log('[Windsurf] Fetching trajectories...');
			const trajectories = await this.getAllCascadeTrajectories();
			console.log(`[Windsurf] Got trajectories: ${trajectories ? 'YES' : 'NO'}`);
			
			if (!trajectories || !trajectories.trajectorySummaries) {
				console.log('[Windsurf] No trajectories available');
				return [];
			}
			
			const trajectoryIds = Object.keys(trajectories.trajectorySummaries);
			console.log(`[Windsurf] Found ${trajectoryIds.length} trajectory summaries`);
			
			// Process each trajectory
			for (const trajectoryId of trajectoryIds) {
				console.log(`[Windsurf] Processing trajectory: ${trajectoryId}`);
				const summary = trajectories.trajectorySummaries[trajectoryId];
				
				// For now, use stepCount as a proxy for activity (since we don't have token data in the summary)
				const activityScore = summary.stepCount || 0;
				console.log(`[Windsurf] Trajectory ${trajectoryId}: ${activityScore} steps`);
				
				if (activityScore === 0) {
					console.log(`[Windsurf] Skipping trajectory ${trajectoryId} - no steps`);
					continue;
				}
				
				// Create a session file details object for Windsurf sessions
				const sessionFile: SessionFileDetails = {
					file: `windsurf://trajectory/${trajectoryId}`,
					modified: summary.lastModifiedTime || new Date().toISOString(),
					size: activityScore, // Use stepCount as size proxy
					interactions: activityScore, // Use stepCount as interactions
					tokens: activityScore * 100, // Rough token estimate
					contextReferences: { file: 0, selection: 0, implicitSelection: 0, symbol: 0, codebase: 0, workspace: 0, terminal: 0, vscode: 0, terminalLastCommand: 0, terminalSelection: 0, clipboard: 0, changes: 0, outputPanel: 0, problemsPanel: 0, byKind: {}, copilotInstructions: 0, agentsMd: 0, byPath: {} }, // Default values
					firstInteraction: summary.createdTime,
					lastInteraction: summary.lastUserInputTime || summary.lastModifiedTime,
					editorSource: 'windsurf',
					editorName: 'Windsurf',
					title: summary.summary || `Windsurf Session ${trajectoryId}`
				};
				
				console.log(`[Windsurf] Added session: ${sessionFile.file} (${activityScore} steps)`);
				sessions.push(sessionFile);
			}
			
			console.log(`[Windsurf] === SESSION DISCOVERY COMPLETE ===`);
			console.log(`[Windsurf] Returning ${sessions.length} sessions`);
			return sessions;
			
		} catch (error) {
			console.error('[Windsurf] Exception in getWindsurfSessionsV2():', error);
			return [];
		}
	}

	/**
	 * Process all Windurf trajectories and return session details.
	 */
	async getWindsurfSessions(): Promise<SessionFileDetails[]> {
		// Minimal version to isolate the issue
		console.log('[Windsurf] MINIMAL VERSION - ENTRY POINT');
		
		try {
			console.log('[Windsurf] MINIMAL VERSION - IN TRY BLOCK');
			
			// Try the simplest possible operation
			const sessions: SessionFileDetails[] = [];
			console.log('[Windsurf] MINIMAL VERSION - CREATED EMPTY ARRAY');
			
			// Just return the empty array for now
			console.log('[Windsurf] MINIMAL VERSION - ABOUT TO RETURN');
			return sessions;
			
		} catch (error) {
			console.error('[Windsurf] MINIMAL VERSION - CATCH BLOCK:', error);
			return [];
		}
	}

	/**
	 * Original version (commented out for debugging)
	 */
	async getWindsurfSessionsOriginal(): Promise<SessionFileDetails[]> {
		// Add logging outside try-catch to see if method is even reached
		console.log('[Windsurf] getWindsurfSessions() ENTRY POINT');
		
		try {
			console.log('[Windsurf] getWindsurfSessions() called');
			console.log('[Windsurf] === STARTING SESSION DISCOVERY ===');
			const sessions: SessionFileDetails[] = [];
			
			// Check if Windsurf is enabled in configuration
			console.log('[Windsurf] About to get configuration...');
			const config = vscode.workspace.getConfiguration('copilotTokenTracker');
			console.log('[Windsurf] Got configuration object');
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
			console.log('[Windsurf] This could mean:');
			console.log('[Windsurf] 1. No chat sessions have been created yet');
			console.log('[Windsurf] 2. The Windsurf language server is not running');
			console.log('[Windsurf] 3. Credential capture failed');
			console.log('[Windsurf] 4. API endpoints have changed');
			return sessions;
		}

		console.log(`[Windsurf] Processing ${Object.keys(trajectories.trajectorySummaries).length} trajectories...`);
		for (const [cascadeId, summary] of Object.entries(trajectories.trajectorySummaries)) {
			console.log(`[Windsurf] Processing trajectory ${cascadeId}...`);
			try {
				// Validate summary data
				if (!summary || typeof summary !== 'object') {
					console.warn(`[Windsurf] Invalid trajectory summary for ${cascadeId}, skipping`);
					continue;
				}

				console.log(`[Windsurf] Getting steps for trajectory ${cascadeId}...`);
				const steps = await this.getCascadeTrajectorySteps(cascadeId);
				if (!steps || !steps.steps) {
					console.warn(`[Windsurf] No steps found for trajectory ${cascadeId}, skipping`);
					continue;
				}

				console.log(`[Windsurf] Found ${steps.steps.length} steps for trajectory ${cascadeId}`);
				const tokenUsage = this.extractTokenUsage(steps.steps);
				const totalTokens = tokenUsage.inputTokens + tokenUsage.outputTokens;
				console.log(`[Windsurf] Token usage for ${cascadeId}: input=${tokenUsage.inputTokens}, output=${tokenUsage.outputTokens}, total=${totalTokens}`);
				
				if (totalTokens === 0) {
					console.log(`[Windsurf] Skipping trajectory ${cascadeId} - no tokens found`);
					continue;
				} // Skip sessions with no tokens

				// Validate and parse dates
				let createdDate: Date;
				try {
					createdDate = new Date(summary.createdTime);
					if (isNaN(createdDate.getTime())) {
						console.warn(`Invalid createdTime for trajectory ${cascadeId}: ${summary.createdTime}`);
						continue;
					}
				} catch (error) {
					console.warn(`Failed to parse createdTime for trajectory ${cascadeId}: ${error}`);
					continue;
				}
				
				const dateStr = createdDate.toISOString().split('T')[0]; // YYYY-MM-DD

				// Extract workspace/repository info
				let workspaceName = 'Unknown';
				let repositoryName = 'Unknown';
				
				if (summary.workspaces && Array.isArray(summary.workspaces) && summary.workspaces.length > 0) {
					const workspace = summary.workspaces[0];
					if (workspace && typeof workspace === 'object') {
						if (workspace.workspaceFolderAbsoluteUri && typeof workspace.workspaceFolderAbsoluteUri === 'string') {
							const uriParts = workspace.workspaceFolderAbsoluteUri.split('/');
							workspaceName = uriParts[uriParts.length - 1] || workspaceName;
						}
						if (workspace.repository && typeof workspace.repository === 'object' && workspace.repository.computedName) {
							repositoryName = String(workspace.repository.computedName);
						}
					}
				}

				const session = {
					file: `windsurf://${cascadeId}`,
					size: 0, // API-based, no file size
					modified: summary.lastModifiedTime,
					interactions: summary.stepCount,
					tokens: totalTokens,
					contextReferences: {
						file: 0,
						selection: 0,
						implicitSelection: 0,
						symbol: 0,
						codebase: 0,
						workspace: 0,
						terminal: 0,
						vscode: 0,
						terminalLastCommand: 0,
						terminalSelection: 0,
						clipboard: 0,
						changes: 0,
						outputPanel: 0,
						problemsPanel: 0,
						byKind: {},
						copilotInstructions: 0,
						agentsMd: 0,
						byPath: {},
					},
					firstInteraction: summary.createdTime,
					lastInteraction: summary.lastUserInputTime || summary.lastModifiedTime,
					editorSource: 'windsurf',
					editorName: 'Windsurf',
					title: summary.summary || `Cascade ${cascadeId}`,
					repository: repositoryName,
				};
				console.log(`[Windsurf] Successfully processed session ${cascadeId}: ${session.title} (${totalTokens} tokens)`);
				sessions.push(session);
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

	/**
	 * Run diagnostics to help troubleshoot Windsurf session detection issues.
	 */
	async runDiagnostics(): Promise<{ [key: string]: any }> {
		console.log('[Windsurf] Running diagnostics...');
		const diagnostics: { [key: string]: any } = {};

		// Basic environment checks
		diagnostics.environment = {
			isRunningInWindsurf: this.isRunningInWindsurf(),
			appName: vscode.env.appName,
		};

		// Extension checks
		const ext = vscode.extensions.getExtension('codeium.windsurf');
		diagnostics.extension = {
			found: !!ext,
			active: ext?.isActive,
			packageJSON: ext?.packageJSON?.version || 'unknown',
		};

		// Credential checks
		const credentials = await this.getCredentials();
		diagnostics.credentials = {
			available: !!credentials,
			port: credentials?.port || null,
			csrfLength: credentials?.csrf?.length || 0,
		};

		// API connectivity test
		if (credentials) {
			try {
				const response = await this.makeApiCall('GetProcesses', {}, credentials);
				diagnostics.apiTest = {
					success: true,
					statusCode: response.statusCode,
				};
			} catch (error) {
				diagnostics.apiTest = {
					success: false,
					error: error instanceof Error ? error.message : String(error),
				};
			}
		} else {
			diagnostics.apiTest = {
				success: false,
				error: 'No credentials available',
			};
		}

		// Configuration checks
		const config = vscode.workspace.getConfiguration('copilotTokenTracker');
		diagnostics.configuration = {
			enabled: config.get<boolean>('windsurf.enabled', true),
		};

		// Try to get actual session count
		try {
			const trajectories = await this.getAllCascadeTrajectories();
			diagnostics.sessions = {
				available: !!trajectories,
				count: trajectories ? Object.keys(trajectories.trajectorySummaries).length : 0,
			};
		} catch (error) {
			diagnostics.sessions = {
				available: false,
				error: error instanceof Error ? error.message : String(error),
			};
		}

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
