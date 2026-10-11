/**
 * Bounded reads for untrusted, on-disk session-log files written by other tools
 * (Copilot Chat, Copilot CLI, Claude Code, JetBrains, Gemini CLI, Antigravity,
 * OpenCode, ...). These files are attacker-influenceable — a corrupted, crafted,
 * or runaway log file should never be able to force the extension to load an
 * unbounded amount of data into memory.
 *
 * Real-world JSONL/JSON session files are KBs to tens of MBs. 100 MB is a
 * generous cap that comfortably covers legitimate long-running sessions while
 * still bounding worst-case memory use for a single file.
 */
import * as fs from 'fs';
import * as path from 'path';

/** Maximum number of bytes read from a single untrusted session-log file. */
export const MAX_SESSION_FILE_BYTES = 100 * 1024 * 1024; // 100 MB

/** Memoized result of {@link getSystemTempRoots}; computed lazily on first use. */
let cachedSystemTempRoots: string[] | undefined;

function getSystemTempRoots(): string[] {
	if (cachedSystemTempRoots) {
		return cachedSystemTempRoots;
	}

	const envRoots = [
		process.env.TMPDIR,
		process.env.TMP,
		process.env.TEMP,
		process.env.WINDIR ? path.join(process.env.WINDIR, 'Temp') : undefined,
	].filter((value): value is string => Boolean(value && value.trim().length > 0));

	// Only add platform-appropriate fallback roots: POSIX-style paths are
	// meaningless on win32 (and vice versa) and, worse, path.resolve() would
	// silently reinterpret them as CWD-relative paths on the "wrong" platform.
	const fallbackRoots = process.platform === 'win32'
		? ['C:\\Windows\\Temp', 'C:\\Temp']
		: ['/tmp', '/var/tmp'];

	const roots = new Set<string>();
	for (const root of [...envRoots, ...fallbackRoots]) {
		try {
			roots.add(fs.realpathSync(root));
		} catch {
			roots.add(path.resolve(root));
		}
	}
	cachedSystemTempRoots = [...roots];
	return cachedSystemTempRoots;
}

/** Whether a path resolves inside an OS temp directory (session data is never read from there). */
export function isPathInsideSystemTempDir(filePath: string): boolean {
	const resolvedPath = (() => {
		try {
			return fs.realpathSync(filePath);
		} catch {
			return path.resolve(filePath);
		}
	})();

	for (const tempRoot of getSystemTempRoots()) {
		const relative = path.relative(tempRoot, resolvedPath);
		if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
			return true;
		}
	}
	return false;
}

/**
 * Reads a UTF-8 text file, refusing to load files larger than `maxBytes`.
 * Returns `undefined` (after a debug-level log) when the file is over the cap
 * or can't be read/stat'd — callers should treat this the same as "file missing
 * or unparsable" and fall back to their existing empty/default result.
 */
export async function readTextFileWithSizeGuard(
	filePath: string,
	context: string,
	maxBytes: number = MAX_SESSION_FILE_BYTES
): Promise<string | undefined> {
	if (isPathInsideSystemTempDir(filePath)) {
		console.error(`[${context}] Refusing to read file from OS temp directory: ${filePath}`);
		return undefined;
	}
	// Open once and stat/read the same file handle (not the path) so the file
	// can't be swapped out for something larger between the size check and the
	// read (TOCTOU race).
	let handle: fs.promises.FileHandle;
	try {
		handle = await fs.promises.open(filePath, 'r');
	} catch (err) {
		console.error(`[${context}] Failed to open ${filePath}:`, err);
		return undefined;
	}
	try {
		const stat = await handle.stat();
		if (stat.size > maxBytes) {
			console.debug(`[${context}] Skipping oversized file (${stat.size} bytes > ${maxBytes} byte cap): ${filePath}`);
			return undefined;
		}
		return await handle.readFile({ encoding: 'utf8' });
	} catch (err) {
		console.error(`[${context}] Failed to read ${filePath}:`, err);
		return undefined;
	} finally {
		await handle.close();
	}
}

/** Synchronous counterpart of {@link readTextFileWithSizeGuard}, for call sites that can't go async. */
export function readTextFileWithSizeGuardSync(
	filePath: string,
	context: string,
	maxBytes: number = MAX_SESSION_FILE_BYTES
): string | undefined {
	if (isPathInsideSystemTempDir(filePath)) {
		console.error(`[${context}] Refusing to read file from OS temp directory: ${filePath}`);
		return undefined;
	}
	// Open once and fstat/read the same file descriptor (not the path) so the
	// file can't be swapped out for something larger between the size check
	// and the read (TOCTOU race).
	let fd: number;
	try {
		fd = fs.openSync(filePath, 'r');
	} catch (err) {
		console.error(`[${context}] Failed to open ${filePath}:`, err);
		return undefined;
	}
	try {
		const stat = fs.fstatSync(fd);
		if (stat.size > maxBytes) {
			console.debug(`[${context}] Skipping oversized file (${stat.size} bytes > ${maxBytes} byte cap): ${filePath}`);
			return undefined;
		}
		return fs.readFileSync(fd, 'utf8');
	} catch (err) {
		console.error(`[${context}] Failed to read ${filePath}:`, err);
		return undefined;
	} finally {
		fs.closeSync(fd);
	}
}
