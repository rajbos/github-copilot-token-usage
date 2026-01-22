/**
 * Utility service for backend facade.
 * Pure utility functions for data transformations and normalization.
 */

import * as path from 'path';
import * as fs from 'fs/promises';

const MAX_DISPLAY_NAME_LENGTH = 64;

/**
 * BackendUtility provides pure static helper functions for the backend module.
 */
export class BackendUtility {
	/**
	 * Sanitize a value to be used as Azure Table PartitionKey/RowKey.
	 * Azure Tables disallow '/', '\\', '#', '?' in keys.
	 */
	static sanitizeTableKey(value: string): string {
		return value.replace(/[\/\\#\?]/g, '_');
	}

	/**
	 * Convert a Date to a UTC day key string (YYYY-MM-DD).
	 * @throws {Error} If date is invalid
	 */
	static toUtcDayKey(date: Date): string {
		if (!(date instanceof Date) || isNaN(date.getTime())) {
			throw new Error(`Invalid date object provided to toUtcDayKey: ${date}`);
		}
		return date.toISOString().slice(0, 10);
	}

	/**
	 * Validate a dayKey string format (YYYY-MM-DD).
	 * @param dayKey - The day key to validate
	 * @returns true if valid, false otherwise
	 */
	static isValidDayKey(dayKey: string): boolean {
		if (!dayKey || typeof dayKey !== 'string') {
			return false;
		}
		if (!/^\d{4}-\d{2}-\d{2}$/.test(dayKey)) {
			return false;
		}
		const date = new Date(`${dayKey}T00:00:00.000Z`);
		if (isNaN(date.getTime())) {
			return false;
		}
		return date.toISOString().slice(0, 10) === dayKey;
	}

	/**
	 * Validate and sanitize a dayKey, returning undefined if invalid.
	 * @param dayKey - The day key to validate
	 * @returns Validated dayKey or undefined
	 */
	static validateDayKey(dayKey: unknown): string | undefined {
		if (typeof dayKey !== 'string') {
			return undefined;
		}
		return BackendUtility.isValidDayKey(dayKey) ? dayKey : undefined;
	}

	/**
	 * Add days to a UTC day key string.
	 */
	static addDaysUtc(dayKey: string, daysToAdd: number): string {
		const date = new Date(`${dayKey}T00:00:00.000Z`);
		date.setUTCDate(date.getUTCDate() + daysToAdd);
		return BackendUtility.toUtcDayKey(date);
	}

	/**
	 * Get an array of day keys (YYYY-MM-DD) inclusive between start and end.
	 * @throws {Error} If dayKeys are invalid or range is too large
	 */
	static getDayKeysInclusive(startDayKey: string, endDayKey: string): string[] {
		if (!BackendUtility.isValidDayKey(startDayKey)) {
			throw new Error(`Invalid startDayKey format: ${startDayKey}`);
		}
		if (!BackendUtility.isValidDayKey(endDayKey)) {
			throw new Error(`Invalid endDayKey format: ${endDayKey}`);
		}
		
		const MAX_DAYS = 400;
		const startDate = new Date(`${startDayKey}T00:00:00.000Z`);
		const endDate = new Date(`${endDayKey}T00:00:00.000Z`);
		const dayCount = Math.ceil((endDate.getTime() - startDate.getTime()) / (24 * 60 * 60 * 1000)) + 1;
		
		if (dayCount < 0) {
			throw new Error(`Invalid date range: startDayKey (${startDayKey}) is after endDayKey (${endDayKey})`);
		}
		if (dayCount > MAX_DAYS) {
			throw new Error(`Date range too large: ${dayCount} days (max ${MAX_DAYS})`);
		}
		
		const result: string[] = [];
		let current = startDayKey;
		while (current <= endDayKey) {
			result.push(current);
			if (current === endDayKey) {
				break;
			}
			current = BackendUtility.addDaysUtc(current, 1);
		}
		return result;
	}

	/**
	 * Normalize a timestamp value to milliseconds since epoch.
	 * Handles numbers (seconds or ms), ISO strings, etc.
	 */
	static normalizeTimestampToMs(value: unknown): number | undefined {
		const asNumber = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : undefined;
		if (typeof asNumber === 'number' && Number.isFinite(asNumber)) {
			// Treat sub-second epochs as seconds, otherwise assume milliseconds.
			return asNumber < 1_000_000_000_000 ? asNumber * 1000 : asNumber;
		}

		if (typeof value === 'string') {
			const parsed = Date.parse(value);
			return Number.isFinite(parsed) ? parsed : undefined;
		}

		return undefined;
	}

	/**
	 * Strip the domain suffix from a hostname.
	 */
	static stripHostnameDomain(hostname: string): string {
		const trimmed = (hostname ?? '').trim();
		if (!trimmed) {
			return '';
		}
		const idx = trimmed.indexOf('.');
		return idx > 0 ? trimmed.substring(0, idx) : trimmed;
	}

	/**
	 * Normalize a name for storage (trim and truncate if needed).
	 */
	static normalizeNameForStorage(name: string | undefined): string | undefined {
		if (!name || typeof name !== 'string') {
			return undefined;
		}
		const trimmed = name.trim();
		if (!trimmed) {
			return undefined;
		}
		return trimmed.length > MAX_DISPLAY_NAME_LENGTH ? trimmed.slice(0, MAX_DISPLAY_NAME_LENGTH) : trimmed;
	}

	/**
	 * Extract workspace ID from a session file path.
	 */
	static extractWorkspaceIdFromSessionPath(sessionFile: string): string {
		const normalized = sessionFile.replace(/\\/g, '/');
		const parts = normalized.split('/');
		const idx = parts.findIndex(p => p.toLowerCase() === 'workspacestorage');
		if (idx >= 0 && parts[idx + 1]) {
			return parts[idx + 1];
		}
		if (normalized.toLowerCase().includes('/globalstorage/emptywindowchatsessions/')) {
			return 'emptyWindow';
		}
		if (normalized.toLowerCase().includes('/globalstorage/github.copilot-chat/')) {
			return 'copilot-chat';
		}
		if (normalized.toLowerCase().includes('/.copilot/session-state/')) {
			return 'copilot-cli';
		}
		return 'unknown';
	}

	/**
	 * Try to resolve workspace name from a session file path by reading workspace.json or meta.json.
	 */
	static async tryResolveWorkspaceNameFromSessionPath(sessionFile: string): Promise<string | undefined> {
		try {
			const normalized = sessionFile.replace(/\\/g, '/');
			const marker = '/workspacestorage/';
			const idx = normalized.toLowerCase().indexOf(marker);
			if (idx < 0) {
				return undefined;
			}
			const after = normalized.substring(idx + marker.length);
			const workspaceStorageId = after.split('/')[0];
			if (!workspaceStorageId) {
				return undefined;
			}

			const workspaceStorageRoot = path.join(sessionFile.substring(0, idx), 'workspaceStorage', workspaceStorageId);
			const candidates = [
				path.join(workspaceStorageRoot, 'workspace.json'),
				path.join(workspaceStorageRoot, 'meta.json')
			];

			for (const filePath of candidates) {
				try {
					const raw = await fs.readFile(filePath, 'utf8');
					const parsed = JSON.parse(raw);
					
					const uriStr = (parsed?.folder ?? parsed?.workspace ?? parsed?.configuration ?? '').toString();
					if (!uriStr) {
						continue;
					}
					
					// Parse the URI string to get the file path
					// This is a simplified version that doesn't require vscode.Uri
					let fsPath: string;
					if (uriStr.startsWith('file://')) {
						// file:// URI - extract path after protocol
						fsPath = uriStr.substring('file://'.length);
						// Handle Windows drive letters (e.g., file:///C:/path -> C:/path)
						if (fsPath.startsWith('/') && /^\/[a-zA-Z]:\//.test(fsPath)) {
							fsPath = fsPath.substring(1);
						}
						// Decode URI components
						fsPath = decodeURIComponent(fsPath);
					} else {
						// Assume it's already a file path
						fsPath = uriStr;
					}
					
					if (!fsPath) {
						continue;
					}
					const base = path.basename(fsPath);
					if (!base) {
						continue;
					}
					// For .code-workspace files, show name without extension.
					const name = base.toLowerCase().endsWith('.code-workspace')
						? base.substring(0, base.length - '.code-workspace'.length)
						: base;
					return BackendUtility.normalizeNameForStorage(name);
				} catch {
					// File doesn't exist or can't be read - continue to next candidate
					continue;
				}
			}
		} catch {
			// Best-effort only.
		}
		return undefined;
	}
}
