#!/usr/bin/env node
/**
 * Fetch Copilot cloud-agent session statistics for the current GitHub repository
 * and write aggregated results to ./usage-data/agent-sessions.json.
 *
 * Designed for use in GitHub Actions (copilot-setup-steps.yml).
 * Exits 0 even on error so the workflow step is non-fatal.
 *
 * Environment variables:
 *   GITHUB_TOKEN      — GitHub token with repo scope (set by Actions automatically)
 *   GITHUB_REPOSITORY — "owner/repo" string (set by Actions automatically)
 */

'use strict';

const https = require('https');
const fs = require('fs');
const path = require('path');

const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const GITHUB_REPOSITORY = process.env.GITHUB_REPOSITORY || '';
const OUTPUT_PATH = path.join(process.cwd(), 'usage-data', 'agent-sessions.json');
const MAX_TASKS_DETAIL = 50;
const CONCURRENCY = 5;

if (!GITHUB_TOKEN) {
	console.warn('⚠️  GITHUB_TOKEN not set — skipping agent session fetch');
	writeEmpty('GITHUB_TOKEN not set');
	process.exit(0);
}

if (!GITHUB_REPOSITORY) {
	console.warn('⚠️  GITHUB_REPOSITORY not set — skipping agent session fetch');
	writeEmpty('GITHUB_REPOSITORY not set');
	process.exit(0);
}

const [owner, repo] = GITHUB_REPOSITORY.split('/');
if (!owner || !repo) {
	console.warn('⚠️  Invalid GITHUB_REPOSITORY format — skipping');
	writeEmpty('Invalid GITHUB_REPOSITORY');
	process.exit(0);
}

/** @returns {Promise<{statusCode: number, body: string}>} */
function githubGet(apiPath) {
	return new Promise((resolve, reject) => {
		const req = https.request(
			{
				hostname: 'api.github.com',
				path: apiPath,
				headers: {
					Authorization: `Bearer ${GITHUB_TOKEN}`,
					'User-Agent': 'copilot-token-tracker/fetch-agent-sessions',
					Accept: 'application/vnd.github.v3+json',
					'X-GitHub-Api-Version': '2022-11-28',
				},
			},
			(res) => {
				let body = '';
				res.on('data', (chunk) => (body += chunk));
				res.on('end', () => resolve({ statusCode: res.statusCode || 0, body }));
			},
		);
		req.on('error', reject);
		req.setTimeout(20000, () => req.destroy(new Error('Timed out')));
		req.end();
	});
}

/** Detect whether a session came from the cloud agent or a CLI/remote session. */
function detectSessionSource(session) {
	if (session.model !== undefined && session.model !== '') { return 'cloud-agent'; }
	if (Object.prototype.hasOwnProperty.call(session, 'usage') &&
		session.usage !== null && session.usage !== undefined) { return 'cloud-agent'; }
	if (session.model !== undefined) { return 'cli-remote'; }
	return 'unknown';
}

async function fetchAllTasks(owner, repo, since) {
	const allTasks = [];
	const seen = new Set();

	for (const archived of [false, true]) {
		for (let page = 1; page <= 10; page++) {
			let qs = `per_page=100&page=${page}`;
			if (archived) { qs += '&archived=true'; }
			if (since) { qs += `&since=${encodeURIComponent(since)}`; }

			let res;
			try {
				res = await githubGet(`/agents/repos/${owner}/${repo}/tasks?${qs}`);
			} catch (e) {
				console.warn(`⚠️  Request error fetching tasks (page ${page}, archived=${archived}): ${e.message}`);
				break;
			}

			if (res.statusCode === 404) {
				if (!archived) {
					console.warn(`⚠️  Copilot cloud agent not enabled or not accessible for ${owner}/${repo} (HTTP 404)`);
				}
				return null; // signal: repo not accessible
			}
			if (res.statusCode === 403) {
				console.warn(`⚠️  Access denied for ${owner}/${repo} (HTTP 403)`);
				return null;
			}
			if (res.statusCode < 200 || res.statusCode >= 300) {
				console.warn(`⚠️  HTTP ${res.statusCode} fetching tasks (page ${page})`);
				break;
			}

			let tasks;
			try {
				const parsed = JSON.parse(res.body);
				tasks = Array.isArray(parsed?.tasks) ? parsed.tasks : (Array.isArray(parsed) ? parsed : []);
			} catch (e) {
				console.warn(`⚠️  Failed to parse tasks response: ${e.message}`);
				break;
			}

			if (tasks.length === 0) { break; }
			for (const t of tasks) {
				if (!seen.has(t.id)) { seen.add(t.id); allTasks.push(t); }
			}
			if (tasks.length < 100) { break; }
		}
	}

	return allTasks;
}

async function fetchTaskDetail(owner, repo, taskId) {
	try {
		const res = await githubGet(`/agents/repos/${owner}/${repo}/tasks/${encodeURIComponent(taskId)}`);
		if (res.statusCode < 200 || res.statusCode >= 300) { return null; }
		const parsed = JSON.parse(res.body);
		return Array.isArray(parsed?.sessions) ? parsed.sessions : [];
	} catch (e) {
		return null;
	}
}

function writeEmpty(reason) {
	const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
	const result = {
		repos: [],
		totalTasks: 0,
		totalSessions: 0,
		totalCredits: 0,
		authenticated: !!GITHUB_TOKEN,
		since,
		fetchedAt: new Date().toISOString(),
		skippedReason: reason,
	};
	fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
	fs.writeFileSync(OUTPUT_PATH, JSON.stringify(result, null, 2), 'utf8');
}

async function main() {
	const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
	const sinceStr = since.toISOString();

	console.log(`🤖 Fetching Copilot cloud-agent sessions for ${owner}/${repo} since ${sinceStr}...`);

	const allTasks = await fetchAllTasks(owner, repo, sinceStr);
	if (allTasks === null) {
		// API not accessible — write empty result (non-fatal)
		writeEmpty('API not accessible');
		console.log('✅ Written empty agent sessions result');
		return;
	}

	const tasksTotal = allTasks.length;
	const tasksToDetail = allTasks.slice(0, MAX_TASKS_DETAIL);
	const partial = tasksTotal > MAX_TASKS_DETAIL;

	console.log(`  Found ${tasksTotal} tasks, fetching details for ${tasksToDetail.length}${partial ? ' (capped)' : ''}...`);

	let totalTasks = 0;
	let totalSessions = 0;
	let totalCredits = 0;

	for (let i = 0; i < tasksToDetail.length; i += CONCURRENCY) {
		const batch = tasksToDetail.slice(i, i + CONCURRENCY);
		const results = await Promise.all(batch.map(t => fetchTaskDetail(owner, repo, t.id)));
		for (const sessions of results) {
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

	const repoSummary = {
		owner,
		repo,
		totalTasks,
		totalSessions,
		totalCredits,
		tasksScanned: tasksToDetail.length,
		tasksTotal,
		partial,
	};

	const result = {
		repos: [repoSummary],
		totalTasks,
		totalSessions,
		totalCredits,
		authenticated: true,
		since: sinceStr,
		fetchedAt: new Date().toISOString(),
	};

	fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
	fs.writeFileSync(OUTPUT_PATH, JSON.stringify(result, null, 2), 'utf8');

	console.log(`✅ Agent sessions: ${totalTasks} tasks, ${totalSessions} sessions, ${totalCredits.toFixed(1)} credits${partial ? ' (partial)' : ''}`);
	console.log(`   Written to ${OUTPUT_PATH}`);
}

main().catch((e) => {
	console.warn(`⚠️  Unexpected error in fetch-agent-sessions: ${e.message}`);
	writeEmpty(`Error: ${e.message}`);
	process.exit(0);
});
