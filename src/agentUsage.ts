import type { AgentSource, AgentUsage } from './types';

/**
 * Per-custom-agent usage: which agent the user selected (agent picker, `@agent`, `/agent`) and
 * how many requests ran under it. Agents are keyed by the name exactly as the session log shows
 * it, with no harmonising: VS Code lists `.github/agents/product-owner.agent.md` ("Product Owner")
 * and `.claude/agents/product-owner.md` ("Product Owner[Claude]") as two different agents, so
 * they stay two entries. Subagents (agents the model delegates to) are not counted here.
 *
 * Sources:
 * - VS Code Copilot Chat: per request `modeInfo.modeInstructions.{name,uri}`, falling back to the
 *   `inputState.mode.id` (agent file URI) in force when the request was sent.
 * - Copilot CLI: top-level `subagent.selected` / `subagent.deselected` events (no `agentId`).
 */

const MAX_NAME_LENGTH = 80;
/** Keys that would write to the prototype of a plain-object map. */
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

const CLAUDE_AGENT_FILE = /[\\/]\.claude[\\/]agents[\\/][^\\/]+\.md$/i;
const GITHUB_AGENT_FILE = /[\\/]\.github[\\/]agents[\\/][^\\/]+\.md$/i;
/** Ask/Plan ship with the extension as agent files under its globalStorage; they are built-in modes. */
const BUILTIN_AGENT_FILE = /github\.copilot-chat[\\/](ask|plan)-agent[\\/]/i;

export function createEmptyAgentUsage(): AgentUsage {
	return { byAgent: {} };
}

/** True when an agent file path/URI is a custom agent definition (`*.agent.md` or `.claude/agents/*.md`). */
export function isCustomAgentFile(pathOrUri: unknown): boolean {
	if (typeof pathOrUri !== 'string' || !pathOrUri || BUILTIN_AGENT_FILE.test(pathOrUri)) { return false; }
	return /\.agent\.md$/i.test(pathOrUri) || CLAUDE_AGENT_FILE.test(pathOrUri);
}

/** Where the agent definition lives, derived from its file path/URI. */
export function classifyAgentSource(pathOrUri: string | undefined): AgentSource {
	if (!pathOrUri) { return 'other'; }
	if (CLAUDE_AGENT_FILE.test(pathOrUri)) { return 'claude'; }
	if (GITHUB_AGENT_FILE.test(pathOrUri)) { return 'github'; }
	if (/^vscode-userdata:/i.test(pathOrUri) || /[\\/]prompts[\\/][^\\/]+\.agent\.md$/i.test(pathOrUri)) { return 'user'; }
	return 'other';
}

function decodeURIComponentSafe(value: string): string {
	try { return decodeURIComponent(value); } catch { return value; }
}

/** The file name without `.agent.md` / `.md`, used when the log carries no display name. */
function agentNameFromPath(pathOrUri: string): string | undefined {
	const file = decodeURIComponentSafe(pathOrUri.split(/[\\/]/).pop() ?? '');
	const name = file.replace(/\.agent\.md$/i, '').replace(/\.md$/i, '');
	return name || undefined;
}

/** A VS Code URI is either a string or a serialized `{ path, external, scheme }` object. */
function uriToString(uri: unknown): string | undefined {
	if (typeof uri === 'string') { return uri; }
	if (uri && typeof uri === 'object') {
		const u = uri as { path?: unknown; external?: unknown };
		if (typeof u.path === 'string') { return u.path; }
		if (typeof u.external === 'string') { return u.external; }
	}
	return undefined;
}

export interface ResolvedAgent { name: string; source: AgentSource }

/**
 * Resolve the custom agent a VS Code request ran under, or null for built-in modes
 * (Ask / Edit / Agent / Plan). `modeInfo` is preferred; `fallbackModeId` is the
 * `inputState.mode.id` in force when the request was sent (older logs have no `modeInfo`).
 */
export function resolveVsCodeAgent(modeInfo: unknown, fallbackModeId?: unknown): ResolvedAgent | null {
	const instructions = (modeInfo as { modeInstructions?: { name?: unknown; uri?: unknown } } | undefined)?.modeInstructions;
	const uri = uriToString(instructions?.uri) ?? (typeof fallbackModeId === 'string' ? fallbackModeId : undefined);
	if (!uri || !isCustomAgentFile(uri)) { return null; }
	const name = typeof instructions?.name === 'string' && instructions.name.trim()
		? instructions.name.trim()
		: agentNameFromPath(uri);
	return name ? { name, source: classifyAgentSource(uri) } : null;
}

/** Count one request under a custom agent, creating `analysis.agentUsage` lazily. */
export function recordAgent(analysis: { agentUsage?: AgentUsage }, agent: ResolvedAgent | null): void {
	if (!agent) { return; }
	const name = agent.name.slice(0, MAX_NAME_LENGTH);
	if (!name || UNSAFE_KEYS.has(name)) { return; }
	const usage = (analysis.agentUsage ??= createEmptyAgentUsage());
	const entry = (usage.byAgent[name] ??= { sessions: 1, requests: 0, source: agent.source });
	entry.requests++;
}

/** Record every request of a reconstructed VS Code session under the agent it ran with. */
export function recordVsCodeRequestAgents(
	analysis: { agentUsage?: AgentUsage },
	requests: ReadonlyArray<{ requestId?: string; modeInfo?: unknown } | undefined>,
	fallbackModeIdByRequest: ReadonlyArray<unknown>
): void {
	requests.forEach((req, i) => {
		if (req?.requestId) { recordAgent(analysis, resolveVsCodeAgent(req.modeInfo, fallbackModeIdByRequest[i])); }
	});
}

function modeIdOf(mode: unknown): string | undefined {
	const id = (mode as { id?: unknown } | undefined)?.id;
	return typeof id === 'string' ? id : undefined;
}

/** Read an `inputState.mode.id` from a VS Code kind-0 (header) or kind-1 (patch) delta event. */
export function readVsCodeModeId(delta: unknown): string | undefined {
	const d = delta as { kind?: number; k?: unknown[]; v?: unknown } | undefined;
	if (d?.kind === 0) { return modeIdOf((d.v as { inputState?: { mode?: unknown } } | undefined)?.inputState?.mode); }
	if (d?.kind !== 1 || !Array.isArray(d.k) || d.k[0] !== 'inputState') { return undefined; }
	if (d.k[1] === 'mode') { return modeIdOf(d.v); }
	if (d.k.length === 1) { return modeIdOf((d.v as { mode?: unknown } | undefined)?.mode); }
	return undefined;
}

/** Copilot CLI agent selection state, advanced one event at a time. */
export interface CliAgentState {
	active: ResolvedAgent | null;
	/** A user message was seen this turn and has not yet been attributed (agent selected after it). */
	pendingRequest: boolean;
}

export function createCliAgentState(): CliAgentState {
	return { active: null, pendingRequest: false };
}

/**
 * Advance the CLI agent state for one event. A top-level `subagent.selected` (no `agentId`) is the
 * user picking an agent; one carrying an `agentId` is the model delegating to a subagent and is
 * ignored. The selection can land just after the user message that started the turn, so a message
 * seen with no active agent stays pending until `assistant.turn_end`.
 */
/** The slice of a Copilot CLI event this module reads. */
export interface CliAgentEvent {
	type?: unknown;
	agentId?: unknown;
	data?: { agentName?: unknown; agentDisplayName?: unknown };
}

function selectedAgentOf(event: CliAgentEvent): ResolvedAgent | null {
	const name = event.data?.agentDisplayName || event.data?.agentName;
	return typeof name === 'string' && name.trim() ? { name: name.trim(), source: 'other' } : null;
}

function onCliAgentSelected(state: CliAgentState, analysis: { agentUsage?: AgentUsage }, event: CliAgentEvent): void {
	state.active = selectedAgentOf(event);
	if (state.active && state.pendingRequest) { recordAgent(analysis, state.active); }
	state.pendingRequest = false;
}

function onCliUserMessage(state: CliAgentState, analysis: { agentUsage?: AgentUsage }): void {
	if (state.active) { recordAgent(analysis, state.active); state.pendingRequest = false; }
	else { state.pendingRequest = true; }
}

/**
 * Advance the CLI agent state for one event. A top-level `subagent.selected` (no `agentId`) is the
 * user picking an agent; one carrying an `agentId` is the model delegating to a subagent and is
 * ignored. The selection can land just after the user message that started the turn, so a message
 * seen with no active agent stays pending until `assistant.turn_end`.
 */
export function advanceCliAgentState(state: CliAgentState, analysis: { agentUsage?: AgentUsage }, event: CliAgentEvent | undefined): void {
	if (!event || event.agentId) { return; }
	switch (event.type) {
		case 'subagent.selected': onCliAgentSelected(state, analysis, event); break;
		case 'subagent.deselected': state.active = null; break;
		case 'user.message': onCliUserMessage(state, analysis); break;
		case 'assistant.turn_end': state.pendingRequest = false; break;
	}
}

/** Add `from` into `period.agentUsage` (no-op when the session reported no custom agent). */
export function mergeAgentUsage(period: { agentUsage?: AgentUsage }, from: AgentUsage | undefined): void {
	if (!from) { return; }
	const dest = (period.agentUsage ??= createEmptyAgentUsage());
	for (const [name, entry] of Object.entries(from.byAgent)) {
		if (UNSAFE_KEYS.has(name)) { continue; }
		const existing = (dest.byAgent[name] ??= { sessions: 0, requests: 0, source: entry.source });
		existing.sessions += entry.sessions;
		existing.requests += entry.requests;
	}
}
