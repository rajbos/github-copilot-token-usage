/**
 * Mistral Vibe data access layer.
 * Handles reading session data from Mistral Vibe's JSON/JSONL session directories.
 *
 * Mistral Vibe (https://github.com/mistralai/mistral-vibe) is a terminal-based coding agent.
 * Sessions are stored as individual directories under ~/.vibe/logs/session/
 * Each session directory contains:
 *   - meta.json: session metadata including stats (token counts), config (active_model), timestamps
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
 * Session files are meta.json files under ~/.vibe/logs/session/
 */
isVibeSessionFile(filePath: string): boolean {
const normalized = filePath.replace(/\\/g, '/');
return normalized.includes('/.vibe/logs/session/') && normalized.endsWith('/meta.json');
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
discoverSessions(): string[] {
const sessionLogDir = this.getSessionLogDir();
if (!fs.existsSync(sessionLogDir)) {
return [];
}
try {
const entries = fs.readdirSync(sessionLogDir, { withFileTypes: true });
const sessions: string[] = [];
for (const entry of entries) {
if (!entry.isDirectory()) { continue; }
const metaPath = path.join(sessionLogDir, entry.name, 'meta.json');
if (fs.existsSync(metaPath)) {
sessions.push(metaPath);
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
readSessionMeta(metaJsonPath: string): any | null {
try {
const content = fs.readFileSync(metaJsonPath, 'utf8');
return JSON.parse(content);
} catch {
return null;
}
}

/**
 * Read all messages from messages.jsonl for a session.
 * Returns an array of parsed message objects.
 */
readSessionMessages(metaJsonPath: string): any[] {
const messagesPath = path.join(this.getSessionDir(metaJsonPath), 'messages.jsonl');
if (!fs.existsSync(messagesPath)) {
return [];
}
try {
const content = fs.readFileSync(messagesPath, 'utf8');
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
getTokensFromSession(metaJsonPath: string): { tokens: number; thinkingTokens: number } {
const meta = this.readSessionMeta(metaJsonPath);
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
countInteractions(metaJsonPath: string): number {
const messages = this.readSessionMessages(metaJsonPath);
return messages.filter(m => m.role === 'user' && m.injected !== true).length;
}

/**
 * Get per-model token usage for a session.
 * Mistral Vibe stores only session-level totals in meta.json.
 * The model is from config.active_model (single model per session).
 * We attribute all tokens to that model.
 */
getModelUsage(metaJsonPath: string): ModelUsage {
const meta = this.readSessionMeta(metaJsonPath);
if (!meta) {
return {};
}
const promptTokens = typeof meta.stats?.session_prompt_tokens === 'number' ? meta.stats.session_prompt_tokens : 0;
const completionTokens = typeof meta.stats?.session_completion_tokens === 'number' ? meta.stats.session_completion_tokens : 0;
if (promptTokens + completionTokens === 0) {
return {};
}
const model: string = meta.config?.active_model || 'devstral';
return {
[model]: { inputTokens: promptTokens, outputTokens: completionTokens }
};
}

/**
 * Get session metadata: title, timestamps, model.
 * Timestamps are ISO 8601 strings in meta.json (no epoch conversion needed).
 */
getSessionMeta(metaJsonPath: string): {
title: string | undefined;
firstInteraction: string | null;
lastInteraction: string | null;
model: string | undefined;
} {
const meta = this.readSessionMeta(metaJsonPath);
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
getSessionData(metaJsonPath: string): {
tokens: number;
interactions: number;
modelUsage: ModelUsage & { [key: string]: { inputTokens: number; outputTokens: number; interactions?: number } };
timestamp: number;
} {
const meta = this.readSessionMeta(metaJsonPath);
if (!meta) {
return { tokens: 0, interactions: 0, modelUsage: {}, timestamp: 0 };
}
const { tokens } = this.getTokensFromSession(metaJsonPath);
const interactions = this.countInteractions(metaJsonPath);
const baseModelUsage = this.getModelUsage(metaJsonPath);
const modelUsage: any = {};
for (const [model, usage] of Object.entries(baseModelUsage)) {
modelUsage[model] = { ...usage, interactions };
}
const timestamp = meta.start_time ? new Date(meta.start_time).getTime() : 0;
return { tokens, interactions, modelUsage, timestamp };
}
}
