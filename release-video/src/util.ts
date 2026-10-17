/**
 * Shared primitives: process spawning, path containment, hashing and logging.
 *
 * Two rules here are load-bearing for the whole pipeline and are the reason
 * this is a module rather than inline calls:
 *
 *   1. **No shell, ever.** Every external program is spawned with an argv
 *      array. Narration text, file names and model output therefore can never
 *      be re-parsed as commands, no matter what a local model emits.
 *   2. **Every path is contained.** Anything that came from the catalog, a
 *      manifest or a model is resolved and then checked to be inside the
 *      project root before it is opened, written or handed to FFmpeg.
 */

import { spawn, type SpawnOptions } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

/** The `release-video/` directory — the root every generated path must sit inside. */
export const PROJECT_ROOT = path.resolve(__dirname, '..');

/** The repository root, one level up. */
export const REPO_ROOT = path.resolve(PROJECT_ROOT, '..');

export interface RunResult {
	readonly code: number;
	readonly stdout: string;
	readonly stderr: string;
}

export interface RunOptions {
	readonly cwd?: string;
	readonly stdin?: string;
	/** Fail the call when the process exits non-zero. Default true. */
	readonly check?: boolean;
	readonly timeoutMs?: number;
	/** Stream child output to this process's stderr as it arrives. */
	readonly stream?: boolean;
	readonly env?: NodeJS.ProcessEnv;
}

/**
 * Runs a program with an explicit argument vector.
 *
 * Deliberately never uses `shell: true`. On Windows that also means a bare
 * command name is resolved by the OS rather than by cmd.exe, so `.cmd` shims
 * (npm, npx) must be passed with their extension by the caller.
 */
export async function run(command: string, args: readonly string[], options: RunOptions = {}): Promise<RunResult> {
	const { cwd, stdin, check = true, timeoutMs, stream = false, env } = options;

	const spawnOptions: SpawnOptions = {
		cwd: cwd ?? PROJECT_ROOT,
		shell: false,
		windowsHide: true,
		env: env ?? process.env,
		stdio: [stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
	};

	return await new Promise<RunResult>((resolve, reject) => {
		const child = spawn(command, [...args], spawnOptions);
		let stdout = '';
		let stderr = '';
		let timer: NodeJS.Timeout | undefined;
		let timedOut = false;

		if (timeoutMs !== undefined) {
			timer = setTimeout(() => {
				timedOut = true;
				child.kill('SIGKILL');
			}, timeoutMs);
		}

		child.stdout?.on('data', (chunk: Buffer) => {
			stdout += chunk.toString('utf8');
		});
		child.stderr?.on('data', (chunk: Buffer) => {
			const text = chunk.toString('utf8');
			stderr += text;
			if (stream) {
				process.stderr.write(text);
			}
		});

		if (stdin !== undefined) {
			child.stdin?.end(stdin, 'utf8');
		}

		child.on('error', (error) => {
			if (timer) { clearTimeout(timer); }
			reject(new Error(`could not start "${command}": ${error.message}`));
		});

		child.on('close', (code) => {
			if (timer) { clearTimeout(timer); }
			const result: RunResult = { code: code ?? -1, stdout, stderr };
			if (timedOut) {
				reject(new Error(`"${command}" timed out after ${timeoutMs}ms`));
				return;
			}
			if (check && result.code !== 0) {
				const detail = (stderr.trim() || stdout.trim()).split('\n').slice(-20).join('\n');
				reject(new Error(`"${command}" exited ${result.code}\n${detail}`));
				return;
			}
			resolve(result);
		});
	});
}

/** True when `command` can be started at all. Used by `doctor`. */
export async function isRunnable(command: string, args: readonly string[] = ['-version']): Promise<boolean> {
	try {
		await run(command, args, { check: false, timeoutMs: 20000 });
		return true;
	} catch {
		return false;
	}
}

/**
 * Resolves `candidate` against the project root and refuses anything that
 * escapes it.
 *
 * This is the allowlist the whole pipeline leans on: an image path from a
 * manifest, a cache key derived from a feature id, or a filename a local model
 * suggested all pass through here before any I/O happens.
 */
export function resolveInProject(candidate: string, label = 'path'): string {
	rejectForeignAbsolute(candidate, label);
	const resolved = path.resolve(PROJECT_ROOT, candidate);
	const relative = path.relative(PROJECT_ROOT, resolved);
	if (relative.startsWith('..') || path.isAbsolute(relative)) {
		throw new Error(`${label} "${candidate}" resolves outside the project root (${resolved})`);
	}
	assertRealPathContained(resolved, PROJECT_ROOT, candidate, label);
	return resolved;
}

/**
 * Resolves a path that may live anywhere in the repository, not just in this
 * project.
 *
 * Branding assets — the product logo, the marketplace logos — belong to the
 * repository as a whole and are read-only inputs here, so they are addressed
 * relative to the repo root. Containment still applies: a path that escapes
 * the repository is refused exactly as one escaping the project would be.
 */
export function resolveInRepo(candidate: string, label = 'path'): string {
	rejectForeignAbsolute(candidate, label);
	const resolved = path.resolve(REPO_ROOT, candidate);
	const relative = path.relative(REPO_ROOT, resolved);
	if (relative.startsWith('..') || path.isAbsolute(relative)) {
		throw new Error(`${label} "${candidate}" resolves outside the repository (${resolved})`);
	}
	assertRealPathContained(resolved, REPO_ROOT, candidate, label);
	return resolved;
}

/**
 * Containment that survives symlinks.
 *
 * `path.relative` is purely lexical, so `assets/screenshots/link.png` passes it
 * while the link points anywhere at all — and FFmpeg would then happily read
 * the target. Since these functions are documented as the allowlist the whole
 * pipeline leans on, the check has to look at what the path *actually* reaches.
 *
 * The target itself often does not exist yet (an output file, a cache entry),
 * so this resolves the deepest ancestor that does. That is sufficient: a new
 * file can only escape the root if some directory above it already does.
 */
function assertRealPathContained(resolved: string, root: string, candidate: string, label: string): void {
	// `lstat`, not `existsSync`. `existsSync` follows links, so a *dangling*
	// symlink reports "does not exist" — the walk below would then skip past it,
	// accept its in-root parent, and a later write would follow the link
	// straight out of the root. lstat sees the link itself.
	let existing = resolved;
	while (!linkAwareExists(existing)) {
		const parent = path.dirname(existing);
		if (parent === existing) { return; } // Reached the filesystem root; nothing to resolve.
		existing = parent;
	}

	let realRoot: string;
	try {
		realRoot = fs.realpathSync(root);
	} catch {
		return; // The root itself is unreadable; the caller's own I/O will fail.
	}

	let realPath: string;
	try {
		realPath = fs.realpathSync(existing);
	} catch {
		// Something is there — lstat just said so — but it cannot be resolved:
		// a dangling or looping symlink. Unverifiable is not the same as safe,
		// so this is refused rather than waved through.
		throw new Error(
			`${label} "${candidate}" points at a link that cannot be resolved (${existing}), ` +
			'so it cannot be shown to stay inside the root',
		);
	}

	const relative = path.relative(realRoot, realPath);
	if (relative !== '' && (relative.startsWith('..') || path.isAbsolute(relative))) {
		throw new Error(
			`${label} "${candidate}" is inside the root only lexically — it links out to ${realPath}`,
		);
	}
}

/** True when the path itself exists, even as a symlink with no target. */
function linkAwareExists(file: string): boolean {
	try {
		fs.lstatSync(file);
		return true;
	} catch {
		return false;
	}
}

/**
 * Refuses an absolute path belonging to a *different* platform.
 *
 * `path.resolve` applies the host's rules, so on Linux `C:/Windows/x.png` is
 * not absolute — it is a directory literally named `C:` — and resolving it
 * against the project root yields a path *inside* the project that the
 * containment check then happily accepts. Without this, the allowlist is
 * strictly weaker on Linux than on Windows, which is the opposite of what a
 * reader of these functions would assume.
 *
 * A natively-absolute path is left alone: the containment check that follows
 * is already the right test for it.
 */
function rejectForeignAbsolute(candidate: string, label: string): void {
	if (path.isAbsolute(candidate)) { return; }
	// win32.isAbsolute covers drive roots and UNC shares; the pattern also
	// catches drive-relative forms such as "C:notes.png".
	if (path.win32.isAbsolute(candidate) || /^[A-Za-z]:/.test(candidate)) {
		throw new Error(
			`${label} "${candidate}" is an absolute path from another platform, ` +
			'so it would escape the project root rather than resolve inside it',
		);
	}
}

/**
 * Resolves the executable named by an argv template.
 *
 * A command containing a path separator is a file in this project — a Python
 * interpreter in a TTS virtualenv, typically — and must be made absolute:
 * Windows resolves a relative executable against the *parent* process's
 * working directory, not the child's, so `.venv-tts/...` would be looked up
 * wherever the CLI happened to be invoked from. A bare name is left alone for
 * PATH lookup.
 *
 * Shared so that `doctor` tests exactly the command the voice adapter will
 * run; checking one thing and running another is how a green doctor ends up
 * paired with a failing render.
 */
export function resolveExecutable(command: string, label = 'command'): string {
	// Both separators, and deliberately not a regex: the character class that
	// was here read `[\/]` — only a forward slash, because the backslash had
	// been lost to one escaping layer too many. A Windows path such as
	// `.venv-tts\Scripts\python.exe` was therefore treated as a bare PATH
	// command and left relative, which is precisely the case this exists for.
	const hasSeparator = command.includes(path.posix.sep) || command.includes(path.win32.sep);
	return hasSeparator ? resolveInProject(command, label) : command;
}

/**
 * A filename-safe slug. Used for cache keys and scene ids, which become real
 * file names, so the character set is an allowlist rather than a blocklist.
 */
export function slug(value: string): string {
	const cleaned = value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
	return cleaned || 'scene';
}

/** Files over this size are fingerprinted by metadata rather than content. */
const CONTENT_HASH_LIMIT_BYTES = 8 * 1024 * 1024;

/**
 * Fingerprints one file through a single file descriptor.
 *
 * Deliberately *not* `statSync` followed by `readFileSync`. Those are two
 * independent lookups of the same name, and between them the name can be
 * repointed at something else — so the size that chose the strategy and the
 * bytes that were hashed need not describe the same file. Opening once and
 * calling `fstat` on that descriptor closes the window: there is only ever one
 * file object, whatever happens to the path afterwards.
 *
 * Returns null when the path cannot be read or is not a regular file, which
 * the callers treat as "nothing to fingerprint".
 */
export function fingerprintFile(file: string): string | null {
	let handle: number;
	try {
		handle = fs.openSync(file, 'r');
	} catch {
		return null;
	}

	try {
		const stats = fs.fstatSync(handle);
		if (!stats.isFile()) { return null; }
		// Content for small files, metadata for large ones: digesting a hundred
		// megabytes of model weights once per scene would cost far more than
		// the regeneration it prevents.
		return stats.size <= CONTENT_HASH_LIMIT_BYTES
			? digest(fs.readFileSync(handle))
			: `${stats.size}:${Math.round(stats.mtimeMs)}`;
	} catch {
		return null;
	} finally {
		fs.closeSync(handle);
	}
}

/** Short stable digest, for content-addressed caching. */
export function digest(...parts: readonly unknown[]): string {
	const hash = createHash('sha256');
	for (const part of parts) {
		hash.update(typeof part === 'string' ? part : JSON.stringify(part));
		hash.update('\u0000');
	}
	return hash.digest('hex').slice(0, 16);
}

export function ensureDir(dir: string): string {
	fs.mkdirSync(dir, { recursive: true });
	return dir;
}

export function readJson<T>(file: string): T {
	return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
}

export function writeJson(file: string, value: unknown): void {
	ensureDir(path.dirname(file));
	fs.writeFileSync(file, `${JSON.stringify(value, null, '\t')}\n`, 'utf8');
}

/**
 * Removes `$comment` keys recursively, so config files can document themselves
 * inline and still be plain JSON that any tool can edit.
 */
export function stripComments<T>(value: T): T {
	if (Array.isArray(value)) {
		return value.map((item) => stripComments(item)) as unknown as T;
	}
	if (value && typeof value === 'object') {
		const out: Record<string, unknown> = {};
		for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
			if (key === '$comment') { continue; }
			out[key] = stripComments(item);
		}
		return out as T;
	}
	return value;
}

let indent = 0;

export const log = {
	step(message: string): void {
		process.stderr.write(`${'  '.repeat(indent)}▸ ${message}\n`);
	},
	info(message: string): void {
		process.stderr.write(`${'  '.repeat(indent)}  ${message}\n`);
	},
	warn(message: string): void {
		process.stderr.write(`${'  '.repeat(indent)}! ${message}\n`);
	},
	group(message: string): void {
		log.step(message);
		indent += 1;
	},
	groupEnd(): void {
		indent = Math.max(0, indent - 1);
	},
};

/** Formats seconds as `H:MM:SS.cc`, the form ASS timestamps take. */
export function assTime(seconds: number): string {
	// Round to centiseconds *once*, then derive every field from that total.
	//
	// Rounding the fraction separately and clamping an overflowing 100 back to
	// 99 makes a timestamp just under a boundary move backwards: 1.9999 became
	// 0:00:01.99 rather than 0:00:02.00, and the carry never reached minutes or
	// hours either — 59.999 became 0:00:59.99 and 3599.9999 became 0:59:59.99.
	// A cue could therefore end fractionally before the time it was computed to
	// end at.
	const totalCentis = Math.round(Math.max(0, seconds) * 100);
	const centis = totalCentis % 100;
	const totalSeconds = (totalCentis - centis) / 100;

	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const secs = totalSeconds % 60;

	const pad = (n: number, width: number) => String(n).padStart(width, '0');
	return `${hours}:${pad(minutes, 2)}:${pad(secs, 2)}.${pad(centis, 2)}`;
}
