/**
 * Mistral Vibe data access layer.
 * Handles reading session data from Mistral Vibe's JSON/JSONL session directories.
 *
 * Mistral Vibe (https://github.com/mistralai/mistral-vibe) is a terminal-based coding agent.
 * Sessions are stored as individual directories under ~/.vibe/logs/session/
 * Each session directory contains:
 *   - meta.json: session metadata including stats (token counts, of which session_cached_tokens is
 *     the cache-read portion already counted inside session_prompt_tokens), config (active_model),
 *     timestamps
 *   - messages.jsonl: one JSON object per line (LLMMessage objects)
 *
 * Session path format: ~/.vibe/logs/session/session_<YYYYMMDD>_<HHMMSS>_<session_id[:8]>/meta.json
 * The meta.json path is used as the session file path throughout the pipeline.
 *
 * Storage location:
 *   - Windows: %USERPROFILE%\.vibe\
 *   - Linux/macOS: ~/.vibe/
 *   Overridable via VIBE_HOME environment variable.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { ModelUsage } from './types';
import { isUnsafeObjectKey } from './utils/protoGuard';
import { normalizePathForComparison } from './utils/pathUtils';

export class MistralVibeDataAccess {

/**
 * Get the Mistral Vibe home directory.
 * Respects the VIBE_HOME environment variable; defaults to ~/.vibe/
 */
getVibeHomeDir(): string {
const vibeHome = process.env.VIBE_HOME;
if (vibeHome) {
return path.resolve(vibeHome.replace(/^~/, os.homedir()));
}
return path.join(os.homedir(), '.vibe');
}

/**
 * Get the session log directory where sessions are stored.
 * Path: <VIBE_HOME>/logs/session/
 */
getSessionLogDir(): string {
return path.join(this.getVibeHomeDir(), 'logs', 'session');
}

/**
 * Check if a file path belongs to a Mistral Vibe session.
 * Session files are meta.json files under <VIBE_HOME>/logs/session/ — the default
 * ~/.vibe/ or a $VIBE_HOME whose folder name differs.
 */
isVibeSessionFile(filePath: string): boolean {
const normalized = normalizePathForComparison(filePath);
if (!normalized.endsWith('/meta.json')) { return false; }
if (normalized.includes('/.vibe/logs/session/')) { return true; }
return normalized.startsWith(normalizePathForComparison(this.getSessionLogDir()) + '/');
}

/**
 * Get the session directory from a meta.json session file path.
 */
getSessionDir(metaJsonPath: string): string {
return path.dirname(metaJsonPath);
}

/**
 * Discover all Mistral Vibe sessions by scanning the session log directory.
 * Returns an array of meta.json paths, one per session.
 */
async discoverSessions(): Promise<string[]> {
const sessionLogDir = this.getSessionLogDir();
try {
const entries = await fs.promises.readdir(sessionLogDir, { withFileTypes: true });
const sessions: string[] = [];
for (const entry of entries) {
if (!entry.isDirectory()) { continue; }
const metaPath = path.join(sessionLogDir, entry.name, 'meta.json');
try {
await fs.promises.access(metaPath);
sessions.push(metaPath);
} catch {
// meta.json missing — skip
}
}
return sessions;
} catch {
return [];
}
}

/**
 * Read session metadata from meta.json.
 * Returns the parsed object or null on failure.
 */
async readSessionMeta(metaJsonPath: string): Promise<any | null> {
try {
const content = await fs.promises.readFile(metaJsonPath, 'utf8');
return JSON.parse(content);
} catch {
return null;
}
}

/**
 * Read all messages from messages.jsonl for a session.
 * Returns an array of parsed message objects.
 */
async readSessionMessages(metaJsonPath: string): Promise<any[]> {
const messagesPath = path.join(this.getSessionDir(metaJsonPath), 'messages.jsonl');
try {
const content = await fs.promises.readFile(messagesPath, 'utf8');
const lines = content.trim().split('\n');
const messages: any[] = [];
for (const line of lines) {
if (!line.trim()) { continue; }
try {
messages.push(JSON.parse(line));
} catch {
// Skip malformed lines
}
}
return messages;
} catch {
return [];
}
}

/**
 * Get actual token counts from a session's meta.json stats field.
 * Mistral Vibe stores session_prompt_tokens and session_completion_tokens in stats.
 */
async getTokensFromSession(metaJsonPath: string): Promise<{ tokens: number; thinkingTokens: number }> {
const meta = await this.readSessionMeta(metaJsonPath);
if (!meta?.stats) {
return { tokens: 0, thinkingTokens: 0 };
}
const promptTokens = typeof meta.stats.session_prompt_tokens === 'number' ? meta.stats.session_prompt_tokens : 0;
const completionTokens = typeof meta.stats.session_completion_tokens === 'number' ? meta.stats.session_completion_tokens : 0;
return { tokens: promptTokens + completionTokens, thinkingTokens: 0 };
}

/**
 * Count user interactions (number of non-injected user-role messages) in a session.
 */
async countInteractions(metaJsonPath: string): Promise<number> {
const messages = await this.readSessionMessages(metaJsonPath);
return messages.filter(m => m.role === 'user' && m.injected !== true).length;
}

/**
 * Get per-model token usage for a session.
 * Mistral Vibe stores only session-level totals in meta.json.
 * The model is from config.active_model (single model per session).
 * We attribute all tokens to that model.
 */
async getModelUsage(metaJsonPath: string): Promise<ModelUsage> {
const meta = await this.readSessionMeta(metaJsonPath);
if (!meta) {
return {};
}
const promptTokens = typeof meta.stats?.session_prompt_tokens === 'number' ? meta.stats.session_prompt_tokens : 0;
const completionTokens = typeof meta.stats?.session_completion_tokens === 'number' ? meta.stats.session_completion_tokens : 0;
if (promptTokens + completionTokens === 0) {
return {};
}
// `session_cached_tokens` is the cache-read portion *already included* in
// session_prompt_tokens, so it maps to cachedReadTokens (which calculateEstimatedCost
// subtracts from inputTokens) rather than being added on top. Reporting it matters: Vibe
// discounts these heavily (0.15 vs 1.5 per million on Mistral Medium 3.5), so omitting it
// overstated cost by up to ~5x on cache-heavy sessions. Verified against Vibe's own
// `session_cost` — `(prompt - cached) * input + cached * cachedInput + completion * output`
// reproduces it exactly, and matches calculateEstimatedCost's formula. Models whose rates
// report no cached price (devstral-2, glm-5-2) have no cachedInputCostPerMillion entry, so
// the calculation falls back to the full input rate — which is what Vibe bills them at.
const cachedTokens = typeof meta.stats?.session_cached_tokens === 'number' ? meta.stats.session_cached_tokens : 0;
// Untrusted `active_model` string from parsed meta.json — treat unsafe object keys
// like a missing model (see protoGuard.ts).
const rawModel = meta.config?.active_model;
const model: string = rawModel && !isUnsafeObjectKey(rawModel) ? rawModel : 'devstral';
return {
[model]: {
inputTokens: promptTokens,
outputTokens: completionTokens,
// Clamp: a malformed meta.json reporting more cached than prompt tokens would otherwise
// drive uncachedInput negative (Math.max(0, …) in calculateEstimatedCost already floors
// it, but clamping here keeps the reported breakdown internally consistent too).
...(cachedTokens > 0 ? { cachedReadTokens: Math.max(0, Math.min(cachedTokens, promptTokens)) } : {}),
sessions: 0,
}
};
}

/**
 * Get session metadata: title, timestamps, model.
 * Timestamps are ISO 8601 strings in meta.json (no epoch conversion needed).
 */
async getSessionMeta(metaJsonPath: string): Promise<{
title: string | undefined;
firstInteraction: string | null;
lastInteraction: string | null;
model: string | undefined;
}> {
const meta = await this.readSessionMeta(metaJsonPath);
if (!meta) {
return { title: undefined, firstInteraction: null, lastInteraction: null, model: undefined };
}
return {
title: meta.title || undefined,
firstInteraction: meta.start_time || null,
lastInteraction: meta.end_time || null,
model: meta.config?.active_model || undefined,
};
}

/**
 * Returns a unified session data object for backend sync.
 * Timestamp: derived from start_time (ISO 8601 string).
 * Token counts: actual values from stats in meta.json.
 * Model usage: attributed to config.active_model.
 * Interactions: count of non-injected user-role messages.
 */
async getSessionData(metaJsonPath: string): Promise<{
tokens: number;
interactions: number;
modelUsage: ModelUsage & { [key: string]: { inputTokens: number; outputTokens: number; interactions?: number } };
timestamp: number;
}> {
const meta = await this.readSessionMeta(metaJsonPath);
if (!meta) {
return { tokens: 0, interactions: 0, modelUsage: {}, timestamp: 0 };
}
const { tokens } = await this.getTokensFromSession(metaJsonPath);
const interactions = await this.countInteractions(metaJsonPath);
const baseModelUsage = await this.getModelUsage(metaJsonPath);
const modelUsage: any = {};
for (const [model, usage] of Object.entries(baseModelUsage)) {
modelUsage[model] = { ...usage, interactions };
}
const timestamp = meta.start_time ? new Date(meta.start_time).getTime() : 0;
return { tokens, interactions, modelUsage, timestamp };
}
}
