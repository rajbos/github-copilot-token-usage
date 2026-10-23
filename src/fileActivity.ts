/**
 * Extracts which files an agent read, edited, created or deleted from a session log.
 *
 * Pure and editor-neutral: it takes the raw text of one session file and returns
 * one {@link FileTouch} per file-touching tool call. Three log families are read:
 *
 *  - Claude Code / Claude Desktop JSONL: `tool_use` blocks (`Read`, `Edit`, `Write`, ...)
 *  - Copilot CLI JSONL: `tool.execution_start` / `tool.execution_complete` (`view`, `edit`, `create`, ...)
 *  - VS Code Copilot Chat (JSON and delta JSONL): `toolInvocationSerialized` response items
 *
 * Deletes are the weak spot: no agent logs a structured "delete file" tool, so they are
 * found by parsing shell commands (`rm`, `git rm`, `del`, `Remove-Item`). That is best-effort
 * and flagged as such by {@link FileTouch.inferred}.
 *
 * Paths are returned as logged (separators normalized to `/`). Anchoring them to a repository
 * root is done by `repoHeatmapViewBuilder.ts`, which knows the session's workspace.
 */

export type FileActivityKind = 'read' | 'edited' | 'created' | 'deleted';

export const FILE_ACTIVITY_KINDS: readonly FileActivityKind[] = ['read', 'edited', 'created', 'deleted'];

export interface FileTouch {
	/** File path as logged, with `/` separators. May be relative (shell deletes). */
	path: string;
	kind: FileActivityKind;
	/** Epoch ms of the tool call when the log carries one; the builder falls back to the session day. */
	ts?: number;
	/** True when the kind was inferred from a shell command rather than a structured tool call. */
	inferred?: boolean;
}

const CLAUDE_READ_TOOLS = new Set(['Read', 'NotebookRead']);
const CLAUDE_EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'NotebookEdit']);
const CLAUDE_SHELL_TOOLS = new Set(['Bash', 'PowerShell']);

const CLI_READ_TOOLS = new Set(['view']);
const CLI_EDIT_TOOLS = new Set(['edit', 'str_replace', 'str_replace_editor', 'apply_patch']);
const CLI_CREATE_TOOLS = new Set(['create']);
const CLI_SHELL_TOOLS = new Set(['powershell', 'bash', 'shell']);

const VSCODE_TOOL_KINDS: Record<string, FileActivityKind> = {
	copilot_readFile: 'read',
	copilot_replaceString: 'edited',
	copilot_multiReplaceString: 'edited',
	copilot_insertEdit: 'edited',
	copilot_applyPatch: 'edited',
	copilot_editNotebook: 'edited',
	copilot_createFile: 'created',
};
const VSCODE_SHELL_TOOLS = new Set(['run_in_terminal', 'copilot_runInTerminal']);

/** Normalizes separators and trims. Returns '' for values that are not a usable file path. */
export function normalizeTouchedPath(raw: unknown): string {
	if (typeof raw !== 'string') { return ''; }
	const p = raw.trim().replace(/\\/g, '/');
	// Directories (and a bare root) are not files.
	if (!p || p.endsWith('/') || p === '.' || p === '..') { return ''; }
	return p;
}

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function epochMs(value: unknown): number | undefined {
	if (typeof value === 'number' && Number.isFinite(value) && value > 0) { return value; }
	if (typeof value === 'string') {
		const t = Date.parse(value);
		return Number.isNaN(t) ? undefined : t;
	}
	return undefined;
}

// ── Shell command parsing (best-effort deletes) ──────────────────────────────

/** Splits a command into whitespace-separated tokens, honouring single and double quotes. */
function tokenizeShell(command: string): string[] {
	const tokens: string[] = [];
	const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(command)) !== null) { tokens.push(m[1] ?? m[2] ?? m[3]); }
	return tokens;
}

const DELETE_COMMANDS = new Set(['rm', 'del', 'erase', 'remove-item', 'ri', 'unlink']);
const COMMAND_SEPARATORS = /\s*(?:&&|\|\||;|\r?\n)\s*/;

function looksLikeGlob(p: string): boolean { return /[*?[\]{}$`]/.test(p); }

/** PowerShell parameters whose next token is a value, not a path. */
const PS_VALUE_PARAMETERS = /^-(erroraction|ea|credential|stream|include|exclude|filter|warningaction|wa|informationaction|ia)$/i;
/** `-r`, `-rf`, `-fr`, `-R`, `-Recurse`, `--recursive`; deliberately not `-Force`. */
const RECURSIVE_FLAG = /^(?:-[a-z]{0,2}r[a-z]?|-recurse|--recursive)$/i;

function deletedPathsOfSegment(segment: string): string[] {
	let tokens = tokenizeShell(segment);
	if (tokens[0]?.toLowerCase() === 'git' && tokens[1]?.toLowerCase() === 'rm') { tokens = tokens.slice(1); }
	const cmd = tokens[0]?.toLowerCase();
	if (!cmd || !DELETE_COMMANDS.has(cmd)) { return []; }
	// A recursive delete removes directories; the heatmap shows files only.
	if (tokens.slice(1).some(t => RECURSIVE_FLAG.test(t))) { return []; }
	const paths: string[] = [];
	for (let i = 1; i < tokens.length; i++) {
		const t = tokens[i];
		if (/^-(literal)?path$/i.test(t)) { if (tokens[i + 1]) { paths.push(...tokens[++i].split(',')); } continue; }
		if (PS_VALUE_PARAMETERS.test(t)) { i++; continue; }
		if (/^-{1,2}[a-z]/i.test(t) || /^\/[a-z]$/i.test(t)) { continue; }
		paths.push(...t.split(','));
	}
	// `Env:FOO`, `HKLM:\...`, `Variable:x` are PowerShell provider paths, not files.
	return paths.filter(p => !looksLikeGlob(p) && !/^[A-Za-z]{2,}:/.test(p));
}

/** Files a shell command line deletes, best-effort. Globs, variables and directories are skipped. */
export function extractDeletedPathsFromCommand(command: unknown): string[] {
	if (typeof command !== 'string' || !command) { return []; }
	const out: string[] = [];
	for (const segment of command.split(COMMAND_SEPARATORS)) {
		for (const p of deletedPathsOfSegment(segment)) {
			const n = normalizeTouchedPath(p);
			if (n) { out.push(n); }
		}
	}
	return out;
}

function shellTouches(command: unknown, ts: number | undefined): FileTouch[] {
	return extractDeletedPathsFromCommand(command).map(path => ({ path, kind: 'deleted' as const, ts, inferred: true }));
}

// ── Claude Code ──────────────────────────────────────────────────────────────

function claudeInputPath(input: Record<string, unknown>): string {
	return normalizeTouchedPath(input.file_path ?? input.notebook_path ?? input.path);
}

function claudeTouchesOfBlock(block: Record<string, unknown>, ts: number | undefined): FileTouch[] {
	const name = String(block.name ?? '');
	const input = isRecord(block.input) ? block.input : {};
	if (CLAUDE_SHELL_TOOLS.has(name)) { return shellTouches(input.command, ts); }
	const path = claudeInputPath(input);
	if (!path) { return []; }
	if (CLAUDE_READ_TOOLS.has(name)) { return [{ path, kind: 'read', ts }]; }
	if (CLAUDE_EDIT_TOOLS.has(name)) { return [{ path, kind: 'edited', ts }]; }
	// `Write` creates or overwrites; the tool_result text tells which (resolved by the caller).
	if (name === 'Write') { return [{ path, kind: 'created', ts }]; }
	return [];
}

function toolResultText(content: unknown): string {
	if (typeof content === 'string') { return content; }
	if (Array.isArray(content)) {
		return content.map(b => (isRecord(b) && typeof b.text === 'string' ? b.text : '')).join('');
	}
	return '';
}

class ClaudeCollector {
	private readonly touches: FileTouch[] = [];
	private readonly seenToolUse = new Set<string>();
	private readonly pending = new Map<string, { tool: string; touches: FileTouch[] }>();
	private readonly failed = new Set<FileTouch>();

	visit(event: Record<string, unknown>): void {
		const message = isRecord(event.message) ? event.message : undefined;
		const content = Array.isArray(message?.content) ? message.content : [];
		if (event.type === 'assistant') { this.visitToolUses(content, epochMs(event.timestamp)); }
		else if (event.type === 'user') { this.visitToolResults(content); }
	}

	private visitToolUses(content: unknown[], ts: number | undefined): void {
		for (const block of content) {
			if (!isRecord(block) || block.type !== 'tool_use') { continue; }
			const id = typeof block.id === 'string' ? block.id : '';
			// Claude Code re-logs streaming fragments of one response; the first sighting wins.
			if (id) {
				if (this.seenToolUse.has(id)) { continue; }
				this.seenToolUse.add(id);
			}
			const touches = claudeTouchesOfBlock(block, ts);
			this.touches.push(...touches);
			if (id && touches.length > 0) { this.pending.set(id, { tool: String(block.name), touches }); }
		}
	}

	private visitToolResults(content: unknown[]): void {
		for (const block of content) {
			if (!isRecord(block) || block.type !== 'tool_result' || typeof block.tool_use_id !== 'string') { continue; }
			const call = this.pending.get(block.tool_use_id);
			if (!call) { continue; }
			this.pending.delete(block.tool_use_id);
			if (block.is_error === true) {
				// A failed call changed nothing, so it must not colour the heatmap.
				for (const t of call.touches) { this.failed.add(t); }
			} else if (call.tool === 'Write' && !/created successfully/i.test(toolResultText(block.content))) {
				// `Write` over an existing file is an edit, not a create.
				call.touches[0].kind = 'edited';
			}
		}
	}

	result(): FileTouch[] { return this.touches.filter(t => !this.failed.has(t)); }
}

// ── Copilot CLI ──────────────────────────────────────────────────────────────

class CliCollector {
	private readonly touches = new Map<string, FileTouch[]>();
	private order = 0;

	visit(event: Record<string, unknown>): void {
		const data = isRecord(event.data) ? event.data : undefined;
		if (!data) { return; }
		const id = typeof data.toolCallId === 'string' ? data.toolCallId : `anon-${this.order++}`;
		if (event.type === 'tool.execution_start') { this.touches.set(id, this.touchesOfStart(data, epochMs(event.timestamp))); }
		else if (event.type === 'tool.execution_complete' && data.success === false) { this.touches.delete(id); }
	}

	private touchesOfStart(data: Record<string, unknown>, ts: number | undefined): FileTouch[] {
		const name = String(data.toolName ?? '');
		const args = isRecord(data.arguments) ? data.arguments : {};
		if (CLI_SHELL_TOOLS.has(name)) { return shellTouches(args.command, ts); }
		const path = normalizeTouchedPath(args.path ?? args.file_path);
		if (!path) { return []; }
		if (CLI_READ_TOOLS.has(name)) { return [{ path, kind: 'read', ts }]; }
		if (CLI_EDIT_TOOLS.has(name)) { return [{ path, kind: 'edited', ts }]; }
		if (CLI_CREATE_TOOLS.has(name)) { return [{ path, kind: 'created', ts }]; }
		return [];
	}

	result(): FileTouch[] { return [...this.touches.values()].flat(); }
}

// ── VS Code Copilot Chat ─────────────────────────────────────────────────────

function urisOf(message: unknown): string[] {
	if (!isRecord(message) || !isRecord(message.uris)) { return []; }
	const out: string[] = [];
	for (const [key, value] of Object.entries(message.uris)) {
		const raw = isRecord(value) && typeof value.path === 'string' ? value.path : safeDecode(key.replace(/^file:\/\//, ''));
		// `/c:/Users/x` (URI path) -> `c:/Users/x`.
		const p = normalizeTouchedPath(raw.replace(/^\/([a-zA-Z]:)/, '$1'));
		if (p) { out.push(p); }
	}
	return out;
}

function safeDecode(s: string): string {
	try { return decodeURIComponent(s); } catch { return s; }
}

function vscodeCommand(item: Record<string, unknown>): unknown {
	const data = isRecord(item.toolSpecificData) ? item.toolSpecificData : {};
	const cmd = data.commandLine;
	if (isRecord(cmd)) { return cmd.original ?? cmd.toolEdited ?? cmd.userEdited; }
	return typeof cmd === 'string' ? cmd : undefined;
}

function vscodeTouches(item: Record<string, unknown>, ts: number | undefined): FileTouch[] {
	const toolId = String(item.toolId ?? '');
	if (VSCODE_SHELL_TOOLS.has(toolId)) { return shellTouches(vscodeCommand(item), ts); }
	const kind = VSCODE_TOOL_KINDS[toolId];
	if (!kind) { return []; }
	// The past-tense message ("Read [](file)") is the one written once the call finished.
	const paths = new Set([...urisOf(item.pastTenseMessage), ...urisOf(item.invocationMessage)]);
	return [...paths].map(path => ({ path, kind, ts }));
}

class VsCodeCollector {
	private readonly byCallId = new Map<string, FileTouch[]>();
	private anon = 0;

	/** Walks any parsed JSON value (a legacy session object or one delta line) for tool invocations. */
	visit(value: unknown, ts?: number, depth = 0): void {
		if (depth > 12 || typeof value !== 'object' || value === null) { return; }
		if (Array.isArray(value)) { for (const v of value) { this.visit(v, ts, depth + 1); } return; }
		const obj = value as Record<string, unknown>;
		if (obj.kind === 'toolInvocationSerialized' && typeof obj.toolId === 'string') {
			const id = typeof obj.toolCallId === 'string' ? obj.toolCallId : `anon-${this.anon++}`;
			// The same invocation is re-sent as it progresses; the latest snapshot wins.
			this.byCallId.set(id, vscodeTouches(obj, ts));
			return;
		}
		const nextTs = typeof obj.requestId === 'string' ? (epochMs(obj.timestamp) ?? ts) : ts;
		for (const v of Object.values(obj)) { this.visit(v, nextTs, depth + 1); }
	}

	result(): FileTouch[] { return [...this.byCallId.values()].flat(); }
}

// ── Entry point ──────────────────────────────────────────────────────────────

/** Cheap pre-filter so a log without any file-touching tool is not JSON-parsed line by line. */
const MAY_TOUCH_FILES = /"tool_use"|tool\.execution_start|toolInvocationSerialized/;

function parseWhole(content: string): unknown {
	const trimmed = content.trimStart();
	if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) { return undefined; }
	try { return JSON.parse(content); } catch { return undefined; }
}

const LINE_HINTS = ['tool_result', 'tool.execution_complete'];

function mayMatterLine(line: string): boolean {
	return line.length > 0 && (MAY_TOUCH_FILES.test(line) || LINE_HINTS.some(h => line.includes(h)));
}

function parseRecordLine(line: string): Record<string, unknown> | undefined {
	try {
		const event: unknown = JSON.parse(line);
		return isRecord(event) ? event : undefined;
	} catch {
		return undefined;
	}
}

/** Extracts every file-touching tool call of one session log, in log order. */
export function extractFileActivity(content: string): FileTouch[] {
	if (!content || !MAY_TOUCH_FILES.test(content)) { return []; }
	const claude = new ClaudeCollector();
	const cli = new CliCollector();
	const vscode = new VsCodeCollector();

	const whole = parseWhole(content);
	if (whole !== undefined) {
		vscode.visit(whole);
		if (isRecord(whole)) { claude.visit(whole); cli.visit(whole); }
	} else {
		for (const line of content.split('\n')) {
			const event = mayMatterLine(line) ? parseRecordLine(line) : undefined;
			if (!event) { continue; }
			claude.visit(event);
			cli.visit(event);
			vscode.visit(event);
		}
	}
	return [...claude.result(), ...cli.result(), ...vscode.result()];
}

/**
 * The working directory a session ran in, from the first event that records one: Claude Code
 * stamps `cwd` on every event, Copilot CLI records `context.cwd` on `session.start`.
 * VS Code Copilot Chat logs carry none (the host resolves its workspace folder instead).
 */
export function extractSessionCwd(content: string): string | undefined {
	for (const line of content.split('\n', 40)) {
		if (!line.includes('cwd')) { continue; }
		let event: unknown;
		try { event = JSON.parse(line); } catch { continue; }
		if (!isRecord(event)) { continue; }
		const data = isRecord(event.data) ? event.data : undefined;
		const context = data && isRecord(data.context) ? data.context : undefined;
		const cwd = event.cwd ?? context?.cwd;
		if (typeof cwd === 'string' && cwd) { return cwd; }
	}
	return undefined;
}
