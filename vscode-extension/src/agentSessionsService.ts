import * as https from 'https';

export type AgentSessionSource = 'cloud-agent' | 'cli-remote' | 'unknown';

export interface AgentRepoSummary {
	owner: string;
	repo: string;
	/** Number of cloud-agent tasks found (tasks with at least one cloud-agent session). */
	totalTasks: number;
	/** Total cloud-agent sessions across all tasks. */
	totalSessions: number;
	/** Sum of usage.credits for all cloud-agent sessions (0 when unavailable). */
	totalCredits: number;
	/** How many tasks we fetched full details for (may be less than tasksTotal when capped). */
	tasksScanned: number;
	/** Total tasks found in the list API before detail fetch cap. */
	tasksTotal: number;
	/** True when the detail fetch was capped — totals are a lower bound. */
	partial: boolean;
	error?: string;
}

export interface AgentSessionsResult {
	repos: AgentRepoSummary[];
	totalTasks: number;
	totalSessions: number;
	totalCredits: number;
	authenticated: boolean;
	since: string;
	fetchedAt: string;
}

/** Maximum number of task detail fetches per repo to avoid API rate-limit spikes. */
const MAX_TASKS_DETAIL_PER_REPO = 50;

/**
 * Detect whether an agent session came from the GitHub Copilot cloud agent or a CLI/remote session.
 *
 * Heuristic from the undocumented agent API (may change):
 *   cloud-agent: model field is non-empty (e.g. "sweagent-capi:claude-sonnet-4") OR usage field present
 *   cli-remote:  model field present but empty string
 *   unknown:     model field absent entirely
 */
export function detectSessionSource(session: { model?: string; usage?: unknown }): AgentSessionSource {
	if (session.model !== undefined && session.model !== '') { return 'cloud-agent'; }
	if (Object.prototype.hasOwnProperty.call(session, 'usage') && session.usage !== null && session.usage !== undefined) { return 'cloud-agent'; }
	if (session.model !== undefined) { return 'cli-remote'; }
	return 'unknown';
}

// ---------------------------------------------------------------------------
// Low-level HTTP helpers (injectable for testing)
// ---------------------------------------------------------------------------

export interface TaskPageResult {
	tasks: any[];
	statusCode?: number;
	error?: string;
}

export interface TaskDetailResult {
	sessions?: any[];
	statusCode?: number;
	error?: string;
}

export type FetchTaskPageFn = (
	owner: string, repo: string, token: string,
	page: number, archived: boolean, since?: string,
) => Promise<TaskPageResult>;

export type FetchTaskDetailFn = (
	owner: string, repo: string, taskId: string, token: string,
) => Promise<TaskDetailResult>;

/** Fetch one page of agent tasks from the GitHub API. */
export function fetchAgentTasksPage(
	owner: string,
	repo: string,
	token: string,
	page: number,
	archived: boolean,
	since?: string,
): Promise<TaskPageResult> {
	return new Promise((resolve) => {
		let queryParams = `per_page=100&page=${page}`;
		if (archived) { queryParams += '&archived=true'; }
		if (since) { queryParams += `&since=${encodeURIComponent(since)}`; }

		const req = https.request(
			{
				hostname: 'api.github.com',
				path: `/agents/repos/${owner}/${repo}/tasks?${queryParams}`,
				headers: {
					Authorization: `Bearer ${token}`,
					'User-Agent': 'copilot-token-tracker',
					Accept: 'application/vnd.github.v3+json',
					'X-GitHub-Api-Version': '2022-11-28',
				},
			},
			(res) => {
				let data = '';
				res.on('data', (chunk) => (data += chunk));
				res.on('end', () => {
					const statusCode = res.statusCode ?? 0;
					if (statusCode < 200 || statusCode >= 300) {
						resolve({ tasks: [], statusCode, error: `HTTP ${statusCode}` });
						return;
					}
					try {
						const parsed = JSON.parse(data);
						const tasks = Array.isArray(parsed?.tasks)
							? parsed.tasks
							: (Array.isArray(parsed) ? parsed : []);
						resolve({ tasks, statusCode });
					} catch (e) {
						resolve({ tasks: [], statusCode, error: String(e) });
					}
				});
			},
		);
		req.on('error', (e) => resolve({ tasks: [], error: e.message }));
		req.setTimeout(15000, () => { req.destroy(new Error('Request timed out')); });
		req.end();
	});
}

/** Fetch session details for a single agent task. */
export function fetchAgentTaskDetail(
	owner: string,
	repo: string,
	taskId: string,
	token: string,
): Promise<TaskDetailResult> {
	return new Promise((resolve) => {
		const req = https.request(
			{
				hostname: 'api.github.com',
				path: `/agents/repos/${owner}/${repo}/tasks/${encodeURIComponent(taskId)}`,
				headers: {
					Authorization: `Bearer ${token}`,
					'User-Agent': 'copilot-token-tracker',
					Accept: 'application/vnd.github.v3+json',
					'X-GitHub-Api-Version': '2022-11-28',
				},
			},
			(res) => {
				let data = '';
				res.on('data', (chunk) => (data += chunk));
				res.on('end', () => {
					const statusCode = res.statusCode ?? 0;
					if (statusCode < 200 || statusCode >= 300) {
						resolve({ statusCode, error: `HTTP ${statusCode}` });
						return;
					}
					try {
						const parsed = JSON.parse(data);
						const sessions = Array.isArray(parsed?.sessions) ? parsed.sessions : [];
						resolve({ sessions, statusCode });
					} catch (e) {
						resolve({ error: String(e) });
					}
				});
			},
		);
		req.on('error', (e) => resolve({ error: e.message }));
		req.setTimeout(15000, () => { req.destroy(new Error('Request timed out')); });
		req.end();
	});
}

// ---------------------------------------------------------------------------
// High-level aggregation
// ---------------------------------------------------------------------------

/**
 * Fetch and aggregate cloud-agent session stats for a single GitHub repository.
 *
 * Only cloud-agent sessions (model != '' or usage present) are counted.
 * CLI-remote sessions that appear in the same tasks are excluded so they are
 * not double-counted with the chat-session data already tracked by this extension.
 *
 * Fetches are capped at MAX_TASKS_DETAIL_PER_REPO task-detail calls to limit
 * API usage. When the cap is hit, `partial` is set to true and totals are
 * conservative lower bounds.
 */
export async function fetchAgentSessionsForRepo(
	owner: string,
	repo: string,
	token: string,
	since: Date,
	fetchTaskPage: FetchTaskPageFn = fetchAgentTasksPage,
	fetchTaskDetail: FetchTaskDetailFn = fetchAgentTaskDetail,
): Promise<AgentRepoSummary> {
	const sinceStr = since.toISOString();
	const allTasks: any[] = [];
	const seen = new Set<string>();

	// Fetch active and archived task lists
	for (const archived of [false, true]) {
		for (let page = 1; page <= 5; page++) {
			const { tasks, statusCode, error } = await fetchTaskPage(owner, repo, token, page, archived, sinceStr);
			if (tasks.length === 0 || error) {
				if (page === 1 && !archived && error) {
					const msg = statusCode === 404
						? 'Copilot cloud agent not enabled or not accessible for this repo'
						: statusCode === 403
						? 'Access denied — check that your GitHub token has repo scope'
						: `API error (HTTP ${statusCode ?? 'unknown'})`;
					return { owner, repo, totalTasks: 0, totalSessions: 0, totalCredits: 0, tasksScanned: 0, tasksTotal: 0, partial: false, error: msg };
				}
				break;
			}
			for (const t of tasks) {
				if (!seen.has(t.id)) { seen.add(t.id); allTasks.push(t); }
			}
			if (tasks.length < 100) { break; }
		}
	}

	const tasksTotal = allTasks.length;
	const tasksToDetail = allTasks.slice(0, MAX_TASKS_DETAIL_PER_REPO);
	const partial = tasksTotal > MAX_TASKS_DETAIL_PER_REPO;

	let totalTasks = 0;
	let totalSessions = 0;
	let totalCredits = 0;

	// Fetch task details in small concurrent batches
	const CONCURRENCY = 5;
	for (let i = 0; i < tasksToDetail.length; i += CONCURRENCY) {
		const batch = tasksToDetail.slice(i, i + CONCURRENCY);
		const results = await Promise.all(
			batch.map(task => fetchTaskDetail(owner, repo, task.id, token))
		);
		for (const { sessions } of results) {
			if (!sessions || sessions.length === 0) { continue; }
			const cloudSessions = sessions.filter(s => detectSessionSource(s) === 'cloud-agent');
			if (cloudSessions.length > 0) {
				totalTasks++;
				totalSessions += cloudSessions.length;
				for (const s of cloudSessions) {
					if (s.usage && typeof s.usage.credits === 'number') {
						totalCredits += s.usage.credits;
					}
				}
			}
		}
	}

	return {
		owner, repo,
		totalTasks, totalSessions, totalCredits,
		tasksScanned: tasksToDetail.length, tasksTotal, partial,
	};
}
