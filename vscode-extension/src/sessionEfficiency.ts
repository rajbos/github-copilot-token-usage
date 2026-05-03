/**
 * Session Efficiency analyzer.
 *
 * Scans GitHub Copilot CLI session-state directories (events.jsonl) and
 * extracts per-session "what-was-produced" metrics so the user can compare
 * cost (tool calls) against output (PRs, commits, file edits).
 *
 * NOTE: This intentionally does NOT touch the existing token-tracking pipeline.
 * It reads the same on-disk files that the CopilotCliAdapter discovers, but
 * mines them for VCS/PR signals rather than tokens.
 */

import * as fs from 'fs';
import * as path from 'path';
import { getCopilotCliSessionStateDir } from './adapters/copilotCliAdapter';

const PR_URL_RE = /github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/g;
const CREATED_PR_RE = /Created pull request #(\d+) in ([\w.-]+\/[\w.-]+)/g;
const ISSUE_URL_RE = /github\.com\/([\w.-]+)\/([\w.-]+)\/issues\/(\d+)/g;
const EDIT_TOOLS = new Set(['edit', 'create', 'apply_patch', 'write', 'str_replace_editor']);

export type EfficiencyCategory =
	| 'shipped'      // Created at least one PR
	| 'committed'    // Made at least one git commit but no PR
	| 'issue'        // Created/opened an issue (no PR/commit)
	| 'edited'       // Edited files but never committed
	| 'exploratory'  // Few tool calls, no edits — research/Q&A
	| 'no-pr';       // ≥50 tool calls but no PR/commit/issue/edit on disk

export interface PrRef {
	repo: string;
	number: number;
	source: string;
	confidence: 1 | 2 | 3;
}

export interface SessionEfficiency {
	id: string;
	repository: string | null;
	branch: string | null;
	summary: string | null;
	createdAt: string;
	updatedAt: string;
	model: string | null;

	userTurns: number;
	assistantTurns: number;
	toolCalls: number;
	editCount: number;
	commitCount: number;
	filesEdited: number;
	subagentCount: number;

	prRefs: PrRef[];
	issueRefs: PrRef[];
	prsCreated: number;
	issuesCreated: number;

	output: number;       // composite output score
	efficiency: number;   // output / cost
	category: EfficiencyCategory;
	firstUserMsg: string | null;
}

interface HarvestResult {
	refs: PrRef[];
	issueRefs: PrRef[];
	stats: {
		userTurns: number;
		assistantTurns: number;
		toolCalls: number;
		editCount: number;
		commitCount: number;
		filesEdited: number;
		subagentCount: number;
		firstUserMsg: string | null;
		firstTs: string | null;
		lastTs: string | null;
		model: string | null;
	};
}

function safeJson(line: string): any {
	try { return JSON.parse(line); } catch { return null; }
}

function loadWorkspace(dir: string): Record<string, string> | null {
	// workspace.yaml is a flat key/value file (id, repository, branch, summary,
	// created_at, updated_at, …). We only need top-level scalars, so a minimal
	// parser avoids pulling in a YAML dependency.
	const wp = path.join(dir, 'workspace.yaml');
	if (!fs.existsSync(wp)) {return null;}
	let txt: string;
	try { txt = fs.readFileSync(wp, 'utf8'); } catch { return null; }
	const out: Record<string, string> = {};
	for (const rawLine of txt.split(/\r?\n/)) {
		// Skip nested keys, list entries, and comments.
		if (!rawLine || /^\s/.test(rawLine) || rawLine.startsWith('#') || rawLine.startsWith('-')) {continue;}
		const m = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(rawLine);
		if (!m) {continue;}
		let v = m[2].trim();
		// Strip optional surrounding quotes.
		if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
			v = v.slice(1, -1);
		}
		out[m[1]] = v;
	}
	return out;
}

function* iterLines(file: string): IterableIterator<string> {
	// Stream-style line read without pulling whole file into JS array.
	const data = fs.readFileSync(file, 'utf8');
	let start = 0;
	for (let i = 0; i < data.length; i++) {
		if (data.charCodeAt(i) === 10) {
			const line = data.slice(start, i);
			start = i + 1;
			if (line.length > 0) {yield line;}
		}
	}
	if (start < data.length) {
		const line = data.slice(start);
		if (line.length > 0) {yield line;}
	}
}

function harvestFromEventsFile(file: string): HarvestResult {
	const refs = new Map<string, PrRef>();
	const issueRefs = new Map<string, PrRef>();
	const toolCallNames = new Map<string, { name: string; args: any }>();
	const editedFiles = new Set<string>();
	let toolCalls = 0;
	let userTurns = 0;
	let assistantTurns = 0;
	let editCount = 0;
	let commitCount = 0;
	let subagentCount = 0;
	let firstUserMsg: string | null = null;
	let firstTs: string | null = null;
	let lastTs: string | null = null;
	let model: string | null = null;

	const upsert = (
		map: Map<string, PrRef>,
		repo: string,
		num: number,
		source: string,
		confidence: 1 | 2 | 3,
	) => {
		const key = `${repo}#${num}`;
		const cur = map.get(key);
		if (!cur || confidence > cur.confidence) {
			map.set(key, { repo, number: num, source, confidence });
		}
	};

	for (const line of iterLines(file)) {
		const ev = safeJson(line);
		if (!ev) {continue;}
		if (!firstTs) {firstTs = ev.timestamp;}
		lastTs = ev.timestamp;

		const t = ev.type;
		const d = ev.data || {};

		if (t === 'session.start') {model = d.selectedModel || model;}
		if (t === 'user.message') {
			userTurns++;
			if (!firstUserMsg && d.content) {firstUserMsg = String(d.content).slice(0, 240);}
		}
		if (t === 'assistant.turn_end') {assistantTurns++;}
		if (t === 'tool.execution_complete' || t === 'tool.execution_start') {toolCalls++;}
		if (t === 'subagent.started') {subagentCount++;}

		if (t === 'tool.execution_start') {
			if (d.toolCallId && d.toolName) {
				toolCallNames.set(d.toolCallId, { name: d.toolName, args: d.arguments || {} });
			}
			if (d.toolName === 'open_pr_session') {
				const a = d.arguments || {};
				if (a.pr_number && a.repo_full_name) {
					upsert(refs, a.repo_full_name, a.pr_number, 'open_pr_session', 2);
				}
			}
			if (d.toolName === 'open_issue_session') {
				const a = d.arguments || {};
				if (a.issue_number && a.repo_full_name) {
					upsert(issueRefs, a.repo_full_name, a.issue_number, 'open_issue_session', 2);
				}
			}
		}

		if (t === 'tool.execution_complete') {
			const result = d.result || {};
			const success = result.success !== false;
			// `tool.execution_complete` does not always carry toolName — correlate via toolCallId.
			const meta = toolCallNames.get(d.toolCallId) || { name: undefined, args: {} };
			const toolName: string | undefined = d.toolName || meta.name;
			const args = d.arguments || meta.args || {};
			const text = [
				typeof result.content === 'string' ? result.content : null,
				typeof result.detailedContent === 'string' ? result.detailedContent : null,
				typeof result === 'string' ? result : null,
			].filter(Boolean).join('\n');

			if (success && toolName && EDIT_TOOLS.has(toolName)) {
				editCount++;
				if (args && typeof args.path === 'string') {editedFiles.add(args.path);}
			}
			if (success && toolName === 'powershell') {
				const cmd = (args && args.command) || '';
				if (typeof cmd === 'string' && /\bgit\s+commit\b/.test(cmd)) {commitCount++;}
			}

			if (toolName === 'create_pull_request' && success) {
				for (const m of text.matchAll(CREATED_PR_RE)) {
					upsert(refs, m[2], parseInt(m[1], 10), 'create_pull_request', 3);
				}
				for (const m of text.matchAll(PR_URL_RE)) {
					upsert(refs, `${m[1]}/${m[2]}`, parseInt(m[3], 10), 'create_pull_request', 3);
				}
			} else if (toolName === 'powershell' && /gh\s+pr\s+create/.test(JSON.stringify(args))) {
				for (const m of text.matchAll(PR_URL_RE)) {
					upsert(refs, `${m[1]}/${m[2]}`, parseInt(m[3], 10), 'gh_pr_create', 2);
				}
			} else {
				for (const m of text.matchAll(PR_URL_RE)) {
					upsert(refs, `${m[1]}/${m[2]}`, parseInt(m[3], 10), toolName || 'tool_output', 1);
				}
			}

			if (toolName === 'powershell' && /gh\s+issue\s+create/.test(JSON.stringify(args)) && success) {
				for (const m of text.matchAll(ISSUE_URL_RE)) {
					upsert(issueRefs, `${m[1]}/${m[2]}`, parseInt(m[3], 10), 'gh_issue_create', 2);
				}
			} else {
				for (const m of text.matchAll(ISSUE_URL_RE)) {
					upsert(issueRefs, `${m[1]}/${m[2]}`, parseInt(m[3], 10), toolName || 'tool_output', 1);
				}
			}
		}
	}

	return {
		refs: [...refs.values()],
		issueRefs: [...issueRefs.values()],
		stats: {
			userTurns,
			assistantTurns,
			toolCalls,
			editCount,
			commitCount,
			filesEdited: editedFiles.size,
			subagentCount,
			firstUserMsg,
			firstTs,
			lastTs,
			model,
		},
	};
}

function classify(
	prsCreated: number,
	issuesCreated: number,
	commitCount: number,
	editCount: number,
	toolCalls: number,
): EfficiencyCategory {
	if (prsCreated > 0) {return 'shipped';}
	if (commitCount > 0) {return 'committed';}
	if (issuesCreated > 0) {return 'issue';}
	if (editCount > 0) {return 'edited';}
	return toolCalls > 50 ? 'no-pr' : 'exploratory';
}

function buildSession(dir: string, info: HarvestResult, ws: any): SessionEfficiency {
	const stats = info.stats;
	const prsCreated = info.refs.filter(r => r.confidence >= 2).length;
	const issuesCreated = info.issueRefs.filter(r => r.confidence >= 2).length;
	const output =
		prsCreated * 10 +
		issuesCreated * 3 +
		stats.commitCount * 4 +
		stats.filesEdited;
	const cost = stats.toolCalls;
	const efficiency = cost > 0 ? output / cost : 0;
	const category = classify(prsCreated, issuesCreated, stats.commitCount, stats.editCount, stats.toolCalls);

	return {
		id: (ws && ws.id) || path.basename(dir),
		repository: (ws && ws.repository) || null,
		branch: (ws && ws.branch) || null,
		summary: (ws && ws.summary) || null,
		createdAt: String((ws && ws.created_at) || stats.firstTs || ''),
		updatedAt: String((ws && ws.updated_at) || stats.lastTs || ''),
		model: stats.model,
		userTurns: stats.userTurns,
		assistantTurns: stats.assistantTurns,
		toolCalls: stats.toolCalls,
		editCount: stats.editCount,
		commitCount: stats.commitCount,
		filesEdited: stats.filesEdited,
		subagentCount: stats.subagentCount,
		prRefs: info.refs,
		issueRefs: info.issueRefs,
		prsCreated,
		issuesCreated,
		output,
		efficiency,
		category,
		firstUserMsg: stats.firstUserMsg,
	};
}

/**
 * Scan all sessions in `~/.copilot/session-state/` and return per-session
 * efficiency data. Returns an empty array if the directory does not exist
 * (e.g. user does not use the Copilot CLI).
 */
export function loadSessionEfficiency(rootDir?: string): SessionEfficiency[] {
	const root = rootDir || getCopilotCliSessionStateDir();
	if (!fs.existsSync(root)) {return [];}
	const out: SessionEfficiency[] = [];
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(root, { withFileTypes: true });
	} catch { return out; }

	for (const e of entries) {
		if (!e.isDirectory()) {continue;}
		// Session dirs are UUIDs (8-4-4-4-12). Skip non-uuid subdirs.
		if (!/^[0-9a-f]{8}-/i.test(e.name)) {continue;}
		const dir = path.join(root, e.name);
		const ws = loadWorkspace(dir);
		const eventsFile = path.join(dir, 'events.jsonl');
		let info: HarvestResult = {
			refs: [],
			issueRefs: [],
			stats: {
				userTurns: 0, assistantTurns: 0, toolCalls: 0,
				editCount: 0, commitCount: 0, filesEdited: 0, subagentCount: 0,
				firstUserMsg: null, firstTs: null, lastTs: null, model: null,
			},
		};
		if (fs.existsSync(eventsFile)) {
			try { info = harvestFromEventsFile(eventsFile); }
			catch { /* ignore unreadable files */ }
		}
		// Skip empty sessions (no events and no workspace metadata).
		if (!ws && info.stats.toolCalls === 0 && info.stats.userTurns === 0) {continue;}
		out.push(buildSession(dir, info, ws));
	}
	return out;
}

/** Aggregate counts by category — handy for summary panels. */
export function categoryCounts(sessions: SessionEfficiency[]): Record<EfficiencyCategory, number> {
	const out: Record<EfficiencyCategory, number> = {
		shipped: 0, committed: 0, issue: 0, edited: 0, exploratory: 0, 'no-pr': 0,
	};
	for (const s of sessions) {out[s.category]++;}
	return out;
}
