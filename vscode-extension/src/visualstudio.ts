/**
 * Visual Studio data access layer.
 * Handles reading session data from Visual Studio Copilot Chat binary session files.
 *
 * VS stores Copilot Chat sessions as MessagePack-encoded binary files inside each project's .vs folder:
 *   <project>\.vs\<solution>.<ext>\copilot-chat\<hash>\sessions\<uuid>
 *
 * Discovery: VS logs session paths to %LOCALAPPDATA%\Temp\VSGitHubCopilotLogs\*.chat.log
 * with entries: "[PersistedCopilotSessionRepository V] Updating session file '<path>'"
 * A supplemental filesystem scan covers sessions not yet referenced in log files
 * (e.g. VS started but not yet chatted, or log files cleaned up).
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
import { decode, decodeMulti } from '@msgpack/msgpack';
import type { ModelUsage } from './types';

/** Directory names to skip during filesystem scan (heavy / non-project dirs). */
const SCAN_SKIP_DIRS = new Set([
    'node_modules', '.git', '.github', 'bin', 'obj', 'out', 'dist', 'build', 'target',
    'packages', 'vendor', '__pycache__', '.tox', '.venv', 'venv', 'env',
    'Windows', 'Program Files', 'Program Files (x86)', 'ProgramData',
    '$Recycle.Bin', 'System Volume Information', 'Recovery',
]);

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
 * Discover VS Copilot session files.
 * Primary: parse VS temp chat log files (fast).
 * Supplemental: filesystem scan of common development roots, to catch sessions
 * not yet referenced in logs (e.g. VS running but session not yet persisted to log,
 * or log files cleaned up by system temp cleaner).
 */
discoverSessions(): string[] {
const seen = new Set<string>();
const sessionFiles: string[] = [];

this._discoverFromLogs(seen, sessionFiles);
this._discoverFromFilesystem(seen, sessionFiles);

return sessionFiles;
}

/** Parse *.chat.log files in the VS temp log dir for "Updating session file" entries. */
private _discoverFromLogs(seen: Set<string>, results: string[]): void {
const logDir = this.getLogDir();
if (!fs.existsSync(logDir)) { return; }

let logFiles: string[];
try {
logFiles = fs.readdirSync(logDir)
.filter(f => f.endsWith('.chat.log'))
.map(f => path.join(logDir, f));
} catch {
return;
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
results.push(sessionPath);
}
} catch { /* ignore */ }
}
} catch { /* ignore file read errors */ }
}
}

/**
 * Supplement log discovery by scanning common development root directories
 * for `.vs/<solution>/copilot-chat/<hash>/sessions/<uuid>` paths.
 * Scans: user home dir, and common named dev roots (C:\repos, C:\code, etc.).
 * Depth-limited and skips known heavy directories to stay fast.
 *
 * Visual Studio only runs on Windows — skip entirely on macOS/Linux to avoid
 * a deep recursive home-directory walk that causes the extension to hang.
 */
private _discoverFromFilesystem(seen: Set<string>, results: string[]): void {
if (os.platform() !== 'win32') { return; }
const home = os.homedir();
// Drive letter(s): default to C, also try D if it exists
const drives = ['C', 'D'];

const roots: string[] = [home];

// Add common named dev roots at drive root
for (const drive of drives) {
for (const name of ['repos', 'code', 'src', 'projects', 'dev']) {
const p = drive + ':\\' + name;
try { if (fs.existsSync(p)) { roots.push(p); } } catch { /* ok */ }
}
}

for (const root of roots) {
// For home dir, allow depth 7 (home/code/repos/org/project/.vs/...)
// For explicit dev roots, allow depth 5
const maxDepth = root === home ? 7 : 5;
this._scanForVsDirs(root, 0, maxDepth, seen, results);
}
}

/**
 * Recursively scan for `.vs` directories starting from `dir`, up to `maxDepth`.
 * When a `.vs` directory is found, scan it for Copilot Chat session files.
 */
private _scanForVsDirs(
dir: string, depth: number, maxDepth: number,
seen: Set<string>, results: string[]
): void {
if (depth > maxDepth) { return; }

let entries: fs.Dirent[];
try {
entries = fs.readdirSync(dir, { withFileTypes: true });
} catch {
return;
}

for (const entry of entries) {
if (!entry.isDirectory()) { continue; }

const name = entry.name;

// Skip heavy / non-project directories
if (SCAN_SKIP_DIRS.has(name)) { continue; }
// Skip other hidden dirs (but NOT .vs — that's what we're looking for)
if (name.startsWith('.') && name !== '.vs') { continue; }

const fullPath = path.join(dir, name);

if (name === '.vs') {
// Found a .vs directory — look inside for copilot-chat sessions
this._findSessionsInVsDir(fullPath, seen, results);
// Do NOT recurse further into .vs itself
} else {
this._scanForVsDirs(fullPath, depth + 1, maxDepth, seen, results);
}
}
}

/**
 * Given a `.vs` directory, find all `copilot-chat/<hash>/sessions/<uuid>` files.
 * Pattern: `.vs/<solution-dir>/copilot-chat/<hash>/sessions/<file>`
 */
private _findSessionsInVsDir(vsDir: string, seen: Set<string>, results: string[]): void {
let solutionDirs: fs.Dirent[];
try {
solutionDirs = fs.readdirSync(vsDir, { withFileTypes: true });
} catch { return; }

for (const sol of solutionDirs) {
if (!sol.isDirectory()) { continue; }
const copilotChatDir = path.join(vsDir, sol.name, 'copilot-chat');
let hashDirs: fs.Dirent[];
try {
hashDirs = fs.readdirSync(copilotChatDir, { withFileTypes: true });
} catch { continue; }

for (const hashDir of hashDirs) {
if (!hashDir.isDirectory()) { continue; }
const sessionsDir = path.join(copilotChatDir, hashDir.name, 'sessions');
let sessionFiles: fs.Dirent[];
try {
sessionFiles = fs.readdirSync(sessionsDir, { withFileTypes: true });
} catch { continue; }

for (const sf of sessionFiles) {
if (!sf.isFile()) { continue; }
const fullPath = path.join(sessionsDir, sf.name);
if (seen.has(fullPath)) { continue; }
seen.add(fullPath);
results.push(fullPath);
}
}
}
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

/**
 * Extract the session title.
 * VS does not store an explicit title — it displays the text of the first user message.
 */
getSessionTitle(objects: any[]): string | undefined {
const req = objects.find((_: any, i: number) => i > 0 && i % 2 === 1);
const reqData = req?.[1];
if (!reqData?.Content) { return undefined; }
const text = this.extractTextFromContent(reqData.Content).trim();
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
 * Extract text from the Context array attached to a VS request message.
 * Each context item carries a ValueContainer whose second element is a
 * nested MessagePack-encoded byte array; decoded inner object has a Content field.
 */
extractContextText(contextArr: any): string {
if (!Array.isArray(contextArr)) { return ''; }
const parts: string[] = [];
for (const item of contextArr) {
const vc = item?.ValueContainer;
if (!Array.isArray(vc) || vc.length < 2) { continue; }
const vcRaw = vc[1];
if (!vcRaw || typeof vcRaw !== 'object') { continue; }
const keys = Object.keys(vcRaw);
if (keys.length === 0) { continue; }
if (!isNaN(Number(keys[0]))) {
// Byte array stored as numeric-keyed object — decode as nested MessagePack
try {
const numKeys = keys.map(Number).sort((a, b) => a - b);
const bytes = Buffer.from(numKeys.map(k => (vcRaw as Record<number, number>)[k]));
const inner = decode(bytes) as any;
const innerData = Array.isArray(inner) ? inner[1] : inner;
if (innerData?.Content && typeof innerData.Content === 'string') {
parts.push(innerData.Content);
}
} catch { /* ignore malformed context */ }
} else if (vcRaw.Content && typeof vcRaw.Content === 'string') {
parts.push(vcRaw.Content);
}
}
return parts.join('\n');
}
/**
 * Extract the model ID from a message's inner data object (obj[1]).
 * Responses carry Model[1].Id.
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
const objData = objects[i]?.[1];
if (!objData?.Content) { continue; }
const text = this.extractTextFromContent(objData.Content);
const isRequest = i % 2 === 1;
// For requests, also count context (injected file/document content)
const contextText = isRequest ? this.extractContextText(objData.Context) : '';
if (!text && !contextText) { continue; }
const model = this.getModelId(objData, isRequest) || undefined;
total += estimator(text + contextText, model);
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
const obj2Data = objects[i]?.[1];
if (!obj2Data?.Content) { continue; }
const text = this.extractTextFromContent(obj2Data.Content);
const isRequest = i % 2 === 1;
const contextText = isRequest ? this.extractContextText(obj2Data.Context) : '';
if (!text && !contextText) { continue; }
const model = this.getModelId(obj2Data, isRequest) || 'unknown';
if (!modelTexts[model]) { modelTexts[model] = { input: '', output: '' }; }
if (isRequest) {
modelTexts[model].input += text + contextText;
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