/**
 * Visual Studio data access layer.
 * Handles reading session data from Visual Studio Copilot Chat binary session files.
 *
 * VS stores Copilot Chat sessions as MessagePack-encoded binary files inside each project's .vs folder:
 *   <project>\.vs\<solution>.<ext>\copilot-chat\<hash>\sessions\<uuid>
 *
 * Discovery: VS logs session paths to %LOCALAPPDATA%\Temp\VSGitHubCopilotLogs\*.chat.log
 * with entries: "[PersistedCopilotSessionRepository V] Updating session file '<path>'"
 *
 * File format: 1-byte version prefix (0x01) + stream of MessagePack objects:
 *   - Object 0:           session header { Name(null), TimeCreated, TimeUpdated, ConversationMode, ... }
 *   - Objects 1,3,5,...:  user request   { CorrelationId, Content, Model.ModelId, ... }
 *   - Objects 2,4,6,...:  AI response    { Content, Model[1].Id, Author, Quotas, ... }
 *
 * Token counts: NOT stored — estimated from content text length.
 * Title: derived from first user message content (same as VS UI behaviour).
 * Model: response objects carry Model[1].Id per turn; can switch mid-session.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { decodeMulti } from '@msgpack/msgpack';
import type { ModelUsage } from './types';

export class VisualStudioDataAccess {

/**
 * Returns true if the path looks like a VS Copilot session file.
 * Detection: normalised path contains `/.vs/`, `/copilot-chat/`, and `/sessions/`.
 */
isVSSessionFile(filePath: string): boolean {
const n = filePath.replace(/\\/g, '/');
return n.includes('/.vs/') && n.includes('/copilot-chat/') && n.includes('/sessions/');
}

/**
 * Stat the VS session file (no virtual path — the file IS the binary blob).
 */
async statSessionFile(filePath: string): Promise<fs.Stats> {
return fs.promises.stat(filePath);
}

/**
 * Returns the VS temp log directory where .chat.log files are written.
 */
getLogDir(): string {
const localAppData = process.env.LOCALAPPDATA
|| path.join(os.homedir(), 'AppData', 'Local');
return path.join(localAppData, 'Temp', 'VSGitHubCopilotLogs');
}

/**
 * Discover VS Copilot session files by parsing VS temp chat log files.
 * Each .chat.log contains "Updating session file '<abs-path>'" entries.
 * Only returns paths that exist on disk; deduplicates across multiple log files.
 */
discoverSessions(): string[] {
const sessionFiles: string[] = [];
const seen = new Set<string>();
const logDir = this.getLogDir();

if (!fs.existsSync(logDir)) { return []; }

let logFiles: string[];
try {
logFiles = fs.readdirSync(logDir)
.filter(f => f.endsWith('.chat.log'))
.map(f => path.join(logDir, f));
} catch {
return [];
}

const pattern = /Updating session file '([^']+)'/;

for (const logFile of logFiles) {
try {
const content = fs.readFileSync(logFile, 'utf8');
for (const line of content.split('\n')) {
const m = pattern.exec(line);
if (!m) { continue; }
const sessionPath = m[1];
if (seen.has(sessionPath)) { continue; }
seen.add(sessionPath);
try {
if (fs.existsSync(sessionPath)) {
sessionFiles.push(sessionPath);
}
} catch { /* ignore stat errors */ }
}
} catch { /* ignore file read errors */ }
}

return sessionFiles;
}

/**
 * Decode the MessagePack stream from a VS session binary file.
 * Returns an array of decoded objects; Object[0] is the session header,
 * odd-indexed objects are user requests, even-indexed are AI responses.
 */
decodeSessionFile(filePath: string): any[] {
try {
const buf = fs.readFileSync(filePath);
if (buf.length < 2) { return []; }
return Array.from(decodeMulti(buf.slice(1)) as Iterable<any>);
} catch {
return [];
}
}

/**
 * Extract the session title.
 * VS does not store an explicit title — it displays the text of the first user message.
 */
getSessionTitle(objects: any[]): string | undefined {
// Find the first request object (odd index ≥ 1)
const req = objects.find((_: any, i: number) => i > 0 && i % 2 === 1);
if (!req?.Content) { return undefined; }
const text = this.extractTextFromContent(req.Content).trim();
if (!text) { return undefined; }
return text.length > 80 ? text.substring(0, 80) + '\u2026' : text;
}

/**
 * Extract ISO timestamps from the session header object (Object[0]).
 */
getSessionTimestamps(objects: any[]): { timeCreated: string | null; timeUpdated: string | null } {
const header = objects[0];
if (!header) { return { timeCreated: null, timeUpdated: null }; }
return {
timeCreated: header.TimeCreated ? new Date(header.TimeCreated as string).toISOString() : null,
timeUpdated: header.TimeUpdated ? new Date(header.TimeUpdated as string).toISOString() : null,
};
}

/**
 * Count user interactions (number of request objects = odd-indexed objects above index 0).
 */
countInteractions(objects: any[]): number {
return objects.filter((_: any, i: number) => i > 0 && i % 2 === 1).length;
}

/**
 * Extract concatenated text content from a VS message Content array.
 * Each element is a [type, inner] tuple; inner.Content holds the text string.
 */
extractTextFromContent(contentArr: any): string {
if (!Array.isArray(contentArr)) { return ''; }
const parts: string[] = [];
for (const c of contentArr) {
const inner = c?.[1];
if (inner && typeof inner.Content === 'string' && inner.Content) {
parts.push(inner.Content);
}
}
return parts.join('\n');
}

/**
 * Extract the model ID from a request or response message object.
 * Requests carry Model.ModelId; responses carry Model[1].Id.
 */
getModelId(msgObj: any, isRequest: boolean): string | null {
if (!msgObj) { return null; }
if (isRequest) {
return msgObj.Model?.ModelId || null;
}
// Response: Model is [version, { Id, Name, ... }]
const modelArr = msgObj.Model;
if (Array.isArray(modelArr) && modelArr.length >= 2 && modelArr[1]?.Id) {
return modelArr[1].Id as string;
}
return null;
}

/**
 * Estimate total tokens for a session using a caller-supplied estimator.
 * Iterates all request + response content, summing estimated tokens.
 */
getTokenEstimates(
filePath: string,
estimator: (text: string, model?: string) => number
): { tokens: number; thinkingTokens: number } {
const objects = this.decodeSessionFile(filePath);
let total = 0;
for (let i = 1; i < objects.length; i++) {
const obj = objects[i];
if (!obj?.Content) { continue; }
const text = this.extractTextFromContent(obj.Content);
if (!text) { continue; }
const isRequest = i % 2 === 1;
const model = this.getModelId(obj, isRequest) || undefined;
total += estimator(text, model);
}
return { tokens: total, thinkingTokens: 0 };
}

/**
 * Build per-model token usage for a VS Copilot session.
 * Groups input/output text by model and estimates tokens per group.
 */
getModelUsage(
filePath: string,
estimator: (text: string, model?: string) => number
): ModelUsage {
const modelUsage: ModelUsage = {};
const objects = this.decodeSessionFile(filePath);

const modelTexts: { [model: string]: { input: string; output: string } } = {};

for (let i = 1; i < objects.length; i++) {
const obj2 = objects[i];
if (!obj2?.Content) { continue; }
const text = this.extractTextFromContent(obj2.Content);
if (!text) { continue; }
const isRequest = i % 2 === 1;
const model = this.getModelId(obj2, isRequest) || 'unknown';
if (!modelTexts[model]) { modelTexts[model] = { input: '', output: '' }; }
if (isRequest) {
modelTexts[model].input += text;
} else {
modelTexts[model].output += text;
}
}

for (const [model, texts] of Object.entries(modelTexts)) {
modelUsage[model] = {
inputTokens: estimator(texts.input, model),
outputTokens: estimator(texts.output, model),
};
}
return modelUsage;
}
}
