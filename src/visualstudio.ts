/**
 * Visual Studio data access layer.
 * Handles reading session data from Visual Studio Copilot Chat binary session files.
 *
 * VS stores Copilot Chat sessions as MessagePack-encoded binary files inside each project's .vs folder:
 *   <project>\.vs\<solution>.<ext>\copilot-chat\<hash>\sessions\<uuid>
 *
 * Chats started without a solution open live in VS's own AppData folder instead:
 *   %LOCALAPPDATA%\Microsoft\VisualStudio\<version>\VSGitHubCopilot\copilot-chat\<hash>\sessions\<uuid>
 * Same binary format — they must be matched too, otherwise they fall through to the
 * generic JSON session reader and every consumer logs a parse failure (issue #2137).
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
import { isUnsafeObjectKey } from './utils/protoGuard';
import { normalizePathForComparison } from './workspaceHelpers';

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
 * Detection: normalised path contains `/copilot-chat/` and `/sessions/`, under one of
 * the three known session roots:
 *   - `/.vs/`                           per-solution (`.vs/<solution>/copilot-chat/…`)
 *   - `/vsgithubcopilot/copilot-chat/`  VS AppData, solution-less chats
 *   - `/ssmsgithubcopilot/copilot-chat/` SSMS
 * The two AppData roots are anchored directly against `copilot-chat` rather than matched
 * as a loose substring, so an unrelated folder that merely happens to be named
 * `VSGitHubCopilot` somewhere else in the tree cannot false-positive.
 */
isVSSessionFile(filePath: string): boolean {
	const n = normalizePathForComparison(filePath);
	if (!n.includes('/copilot-chat/') || !n.includes('/sessions/')) { return false; }
	return n.includes('/.vs/')
		|| n.includes('/vsgithubcopilot/copilot-chat/')
		|| n.includes('/ssmsgithubcopilot/copilot-chat/');
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
 * Returns the SSMS AppData base directory where Copilot session files are stored.
 * Pattern: %LOCALAPPDATA%\Microsoft\SSMS\
 */
getSsmsSessionsDir(): string {
const localAppData = process.env.LOCALAPPDATA
|| path.join(os.homedir(), 'AppData', 'Local');
return path.join(localAppData, 'Microsoft', 'SSMS');
}

/**
 * Returns the Visual Studio AppData base directory holding solution-less Copilot chats.
 * Pattern: %LOCALAPPDATA%\Microsoft\VisualStudio\<version>\VSGitHubCopilot\copilot-chat\<hash>\sessions\<uuid>
 */
getVsAppDataSessionsDir(): string {
const localAppData = process.env.LOCALAPPDATA
|| path.join(os.homedir(), 'AppData', 'Local');
return path.join(localAppData, 'Microsoft', 'VisualStudio');
}

/**
 * Discover VS Copilot session files.
 * Primary: parse VS temp chat log files (fast).
 * Supplemental: filesystem scan of common development roots, to catch sessions
 * not yet referenced in logs (e.g. VS running but session not yet persisted to log,
 * or log files cleaned up by system temp cleaner).
 * VS AppData: dedicated scan of %LOCALAPPDATA%\Microsoft\VisualStudio\ for VSGitHubCopilot
 * sessions (chats started without a solution open, so no .vs folder exists).
 * SSMS: dedicated scan of %LOCALAPPDATA%\Microsoft\SSMS\ for SSMSGitHubCopilot sessions.
 */
async discoverSessions(): Promise<string[]> {
const seen = new Set<string>();
const sessionFiles: string[] = [];

await this._discoverFromLogs(seen, sessionFiles);
await this._discoverFromFilesystem(seen, sessionFiles);
await this._discoverFromVsAppData(seen, sessionFiles);
await this._discoverFromSsmsAppData(seen, sessionFiles);

return sessionFiles;
}

/** Parse *.chat.log files in the VS temp log dir for "Updating session file" entries. */
private async _discoverFromLogs(seen: Set<string>, results: string[]): Promise<void> {
const logDir = this.getLogDir();

let logFiles: string[];
try {
const entries = await fs.promises.readdir(logDir);
logFiles = entries
.filter(f => f.endsWith('.chat.log'))
.map(f => path.join(logDir, f));
} catch {
return;
}

const pattern = /Updating session file '([^']+)'/;

for (const logFile of logFiles) {
try {
const content = await fs.promises.readFile(logFile, 'utf8');
await this._processLogFileLines(content, pattern, seen, results);
} catch { /* ignore file read errors */ }
}
}

private async _processLogFileLines(content: string, pattern: RegExp, seen: Set<string>, results: string[]): Promise<void> {
for (const line of content.split('\n')) {
const m = pattern.exec(line);
if (!m) { continue; }
const sessionPath = m[1];
if (seen.has(sessionPath)) { continue; }
seen.add(sessionPath);
try { await fs.promises.access(sessionPath); results.push(sessionPath); } catch { /* ignore */ }
}
}

/**
 * Supplement log discovery by scanning common development root directories
 * for `.vs/<solution>/copilot-chat/<hash>/sessions/<uuid>` paths.
 * Scans known named dev subdirs under home and common drive-root dev dirs.
 * Does NOT scan all of home — that would walk AppData and other heavy dirs.
 * Depth-limited and skips known heavy directories to stay fast.
 *
 * Visual Studio only runs on Windows — skip entirely on macOS/Linux to avoid
 * a deep recursive home-directory walk that causes the extension to hang.
 */
private async _discoverFromFilesystem(seen: Set<string>, results: string[]): Promise<void> {
if (os.platform() !== 'win32') { return; }
const home = os.homedir();
const drives = ['C', 'D'];
const roots: string[] = [];

// Scan only known dev folder names directly under home, not all of home.
// Scanning all of home at depth 7 would include AppData, .copilot, etc. — very slow.
const devFolderNames = ['code', 'repos', 'src', 'projects', 'dev', 'workspace', 'work', 'source'];
for (const name of devFolderNames) {
const p = path.join(home, name);
try { await fs.promises.access(p); roots.push(p); } catch { /* ok */ }
}
// Also check Documents/<devfolder> — common on Windows
for (const name of devFolderNames) {
const p = path.join(home, 'Documents', name);
try { await fs.promises.access(p); roots.push(p); } catch { /* ok */ }
}

// Add common named dev roots at drive root
for (const drive of drives) {
for (const name of devFolderNames) {
const p = drive + ':\\' + name;
try { await fs.promises.access(p); roots.push(p); } catch { /* ok */ }
}
}

for (const root of roots) {
await this._scanForVsDirs(root, 0, 5, seen, results);
}
}

/**
 * Recursively scan for `.vs` directories starting from `dir`, up to `maxDepth`.
 * When a `.vs` directory is found, scan it for Copilot Chat session files.
 * Uses Promise.all at each level — safe because roots are bounded named dev dirs,
 * not the entire home directory. Max 8 concurrent ops per level to bound FD pressure.
 */
private async _scanForVsDirs(
dir: string, depth: number, maxDepth: number,
seen: Set<string>, results: string[]
): Promise<void> {
if (depth > maxDepth) { return; }

let entries: fs.Dirent[];
try {
entries = await fs.promises.readdir(dir, { withFileTypes: true });
} catch {
return;
}

const dirs = entries.filter(e => {
if (!e.isDirectory()) { return false; }
const name = e.name;
if (SCAN_SKIP_DIRS.has(name)) { return false; }
if (name.startsWith('.') && name !== '.vs') { return false; }
return true;
});

// Process in batches of 8 to bound FD pressure
const batchSize = 8;
for (let i = 0; i < dirs.length; i += batchSize) {
await Promise.all(dirs.slice(i, i + batchSize).map(async entry => {
const fullPath = path.join(dir, entry.name);
if (entry.name === '.vs') {
await this._findSessionsInVsDir(fullPath, seen, results);
} else {
await this._scanForVsDirs(fullPath, depth + 1, maxDepth, seen, results);
}
}));
}
}

private async _collectFromSessionsDir(sessionsDir: string, seen: Set<string>, results: string[]): Promise<void> {
let sessionFiles: fs.Dirent[];
try { sessionFiles = await fs.promises.readdir(sessionsDir, { withFileTypes: true }); } catch { return; }
for (const sf of sessionFiles) {
if (!sf.isFile()) { continue; }
const fullPath = path.join(sessionsDir, sf.name);
if (seen.has(fullPath)) { continue; }
seen.add(fullPath);
results.push(fullPath);
}
}

private async _collectFromHashDirs(copilotChatDir: string, seen: Set<string>, results: string[]): Promise<void> {
let hashDirs: fs.Dirent[];
try { hashDirs = await fs.promises.readdir(copilotChatDir, { withFileTypes: true }); } catch { return; }
for (const hashDir of hashDirs) {
if (!hashDir.isDirectory()) { continue; }
await this._collectFromSessionsDir(path.join(copilotChatDir, hashDir.name, 'sessions'), seen, results);
}
}

/**
 * Given a `.vs` directory, find all `copilot-chat/<hash>/sessions/<uuid>` files.
 * Pattern: `.vs/<solution-dir>/copilot-chat/<hash>/sessions/<file>`
 */
private async _findSessionsInVsDir(vsDir: string, seen: Set<string>, results: string[]): Promise<void> {
let solutionDirs: fs.Dirent[];
try {
solutionDirs = await fs.promises.readdir(vsDir, { withFileTypes: true });
} catch { return; }

for (const sol of solutionDirs) {
if (!sol.isDirectory()) { continue; }
await this._collectFromHashDirs(path.join(vsDir, sol.name, 'copilot-chat'), seen, results);
}
}

/**
 * Scan %LOCALAPPDATA%\Microsoft\VisualStudio\ for VSGitHubCopilot Copilot Chat sessions.
 * Pattern: VisualStudio\<version>\VSGitHubCopilot\copilot-chat\<hash>\sessions\<uuid>
 * These are chats started without a solution open, so they have no `.vs` folder.
 * Visual Studio only runs on Windows — skip on other platforms.
 */
private async _discoverFromVsAppData(seen: Set<string>, results: string[]): Promise<void> {
if (os.platform() !== 'win32') { return; }
const vsDir = this.getVsAppDataSessionsDir();

let versionDirs: fs.Dirent[];
try {
versionDirs = await fs.promises.readdir(vsDir, { withFileTypes: true });
} catch { return; }

for (const versionDir of versionDirs) {
if (!versionDir.isDirectory()) { continue; }
await this._collectFromHashDirs(path.join(vsDir, versionDir.name, 'VSGitHubCopilot', 'copilot-chat'), seen, results);
}
}

/**
 * Scan %LOCALAPPDATA%\Microsoft\SSMS\ for SSMSGitHubCopilot Copilot Chat sessions.
 * Pattern: SSMS\<version>\SSMSGitHubCopilot\copilot-chat\<hash>\sessions\<uuid>
 * SSMS only runs on Windows — skip on other platforms.
 */
private async _discoverFromSsmsAppData(seen: Set<string>, results: string[]): Promise<void> {
if (os.platform() !== 'win32') { return; }
const ssmsDir = this.getSsmsSessionsDir();

let versionDirs: fs.Dirent[];
try {
versionDirs = await fs.promises.readdir(ssmsDir, { withFileTypes: true });
} catch { return; }

for (const versionDir of versionDirs) {
if (!versionDir.isDirectory()) { continue; }
await this._collectFromHashDirs(path.join(ssmsDir, versionDir.name, 'SSMSGitHubCopilot', 'copilot-chat'), seen, results);
}
}

/**
 * Decode the MessagePack stream from a VS session binary file.
 * Returns an array of decoded objects; Object[0] is the session header,
 * odd-indexed objects are user requests, even-indexed are AI responses.
 */
async decodeSessionFile(filePath: string): Promise<any[]> {
try {
const buf = await fs.promises.readFile(filePath);
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

 
private _decodeVcRaw(vcRaw: any, parts: string[]): void {
const keys = Object.keys(vcRaw);
if (keys.length === 0) { return; }
if (!isNaN(Number(keys[0]))) {
try {
const numKeys = keys.map(Number).sort((a, b) => a - b);
const bytes = Buffer.from(numKeys.map(k => (vcRaw as Record<number, number>)[k]));
 
const inner = decode(bytes) as any;
const innerData = Array.isArray(inner) ? inner[1] : inner;
if (innerData?.Content && typeof innerData.Content === 'string') { parts.push(innerData.Content); }
} catch { /* ignore malformed context */ }
} else if (vcRaw.Content && typeof vcRaw.Content === 'string') {
parts.push(vcRaw.Content);
}
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
this._decodeVcRaw(vcRaw, parts);
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
async getTokenEstimates(
filePath: string,
estimator: (text: string, model?: string) => number
): Promise<{ tokens: number; thinkingTokens: number }> {
const objects = await this.decodeSessionFile(filePath);
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
async getModelUsage(
filePath: string,
estimator: (text: string, model?: string) => number
): Promise<ModelUsage> {
const modelUsage: ModelUsage = {};
const objects = await this.decodeSessionFile(filePath);

const modelTexts: { [model: string]: { input: string; output: string } } = {};

for (let i = 1; i < objects.length; i++) {
const obj2Data = objects[i]?.[1];
if (!obj2Data?.Content) { continue; }
const text = this.extractTextFromContent(obj2Data.Content);
const isRequest = i % 2 === 1;
const contextText = isRequest ? this.extractContextText(obj2Data.Context) : '';
const model = this.getModelId(obj2Data, isRequest) || 'unknown';
// Untrusted `model` string from the decoded session file — see protoGuard.ts.
if ((!text && !contextText) || isUnsafeObjectKey(model)) { continue; }
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
sessions: 0,
};
}
return modelUsage;
}
}