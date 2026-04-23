import { Hono } from 'hono';
import { requireBearerAuth, checkUploadRateLimit, type AuthVariables } from '../auth.js';
import { upsertUpload, deleteUploadsForDays, getUploadsForUser, getDb, type UploadEntry } from '../db.js';

const MAX_STRING_LENGTHS = {
	model: 128,
	workspaceId: 256,
	workspaceName: 256,
	machineId: 256,
	machineName: 256,
	datasetId: 128,
	editor: 100,
};
const MAX_TOKEN_VALUE = 100_000_000; // 100M tokens per entry is already absurd
const MAX_ENTRIES_PER_UPLOAD = 500;

export const api = new Hono<{ Variables: AuthVariables }>();

// GET /health — no auth required (mounted at root level, not here)

/** POST /api/upload — Upload daily rollup data (one or more entries). */
api.post('/upload', requireBearerAuth, async (c) => {
	const user = c.get('user');

	if (!checkUploadRateLimit(user.id)) {
		return c.json({ error: 'Rate limit exceeded — max 100 uploads per hour.' }, 429);
	}

	let body: unknown;
	try {
		body = await c.req.json();
	} catch {
		return c.json({ error: 'Invalid JSON body.' }, 400);
	}

	if (!Array.isArray(body)) {
		return c.json({ error: 'Body must be a JSON array of upload entries.' }, 400);
	}

	if (body.length === 0) {
		return c.json({ uploaded: 0 });
	}

	if (body.length > MAX_ENTRIES_PER_UPLOAD) {
		return c.json({ error: `Too many entries (max ${MAX_ENTRIES_PER_UPLOAD}).` }, 400);
	}

	let uploaded = 0;
	const errors: string[] = [];

	// Validate all entries first before touching the DB
	const validEntries: UploadEntry[] = [];
	for (let i = 0; i < body.length; i++) {
		const validationError = validateEntry(body[i]);
		if (validationError) {
			errors.push(`Entry ${i}: ${validationError}`);
		} else {
			validEntries.push(body[i] as UploadEntry);
		}
	}

	if (validEntries.length > 0) {
		// Group by dataset_id so we can delete-then-insert per dataset atomically
		const byDataset = new Map<string, UploadEntry[]>();
		for (const entry of validEntries) {
			const dsId = entry.datasetId ?? 'default';
			if (!byDataset.has(dsId)) byDataset.set(dsId, []);
			byDataset.get(dsId)!.push(entry);
		}

		for (const [datasetId, entries] of byDataset) {
			// Collect the unique days being uploaded for this dataset
			const days = [...new Set(entries.map(e => e.day))];
			try {
				// Run delete + insert in a single transaction so there's never a gap
				getDb().exec('BEGIN');
				deleteUploadsForDays(user.id, datasetId, days);
				for (const entry of entries) {
					upsertUpload(user.id, entry);
					uploaded++;
				}
				getDb().exec('COMMIT');
			} catch (err) {
				getDb().exec('ROLLBACK');
				errors.push(`Dataset "${datasetId}": ${String(err)}`);
			}
		}
	}

	return c.json({ uploaded, ...(errors.length > 0 ? { errors } : {}) });
});

/** GET /api/me — Return the authenticated user's GitHub profile info. */
api.get('/me', requireBearerAuth, (c) => {
	const user = c.get('user');
	return c.json({
		githubId: user.github_id,
		login: user.github_login,
		name: user.github_name,
		avatarUrl: user.avatar_url,
		createdAt: user.created_at,
	});
});

/** GET /api/data?days=30 — Return the authenticated user's own upload data. */
api.get('/data', requireBearerAuth, (c) => {
	const user = c.get('user');
	const daysRaw = c.req.query('days');
	const days = clampDays(daysRaw);
	const data = getUploadsForUser(user.id, days);
	return c.json(data);
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function clampDays(raw: string | undefined): number {
	const n = parseInt(raw ?? '30', 10);
	if (!Number.isFinite(n)) return 30;
	return Math.min(Math.max(n, 1), 90);
}

function validateEntry(entry: unknown): string | null {
	if (typeof entry !== 'object' || entry === null) {
		return 'must be an object';
	}
	const e = entry as Record<string, unknown>;

	if (typeof e.day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(e.day)) {
		return '"day" must be a YYYY-MM-DD string';
	}
	if (typeof e.model !== 'string' || e.model.length === 0) {
		return '"model" must be a non-empty string';
	}
	if (e.model.length > MAX_STRING_LENGTHS.model) {
		return `"model" too long (max ${MAX_STRING_LENGTHS.model})`;
	}
	if (typeof e.workspaceId !== 'string' || e.workspaceId.length === 0) {
		return '"workspaceId" must be a non-empty string';
	}
	if (e.workspaceId.length > MAX_STRING_LENGTHS.workspaceId) {
		return `"workspaceId" too long (max ${MAX_STRING_LENGTHS.workspaceId})`;
	}
	if (typeof e.machineId !== 'string' || e.machineId.length === 0) {
		return '"machineId" must be a non-empty string';
	}
	if (e.machineId.length > MAX_STRING_LENGTHS.machineId) {
		return `"machineId" too long (max ${MAX_STRING_LENGTHS.machineId})`;
	}
	if (!isNonNegativeInt(e.inputTokens) || (e.inputTokens as number) > MAX_TOKEN_VALUE) {
		return '"inputTokens" must be a non-negative integer ≤ 100,000,000';
	}
	if (!isNonNegativeInt(e.outputTokens) || (e.outputTokens as number) > MAX_TOKEN_VALUE) {
		return '"outputTokens" must be a non-negative integer ≤ 100,000,000';
	}
	if (!isNonNegativeInt(e.interactions) || (e.interactions as number) > 100_000) {
		return '"interactions" must be a non-negative integer ≤ 100,000';
	}

	// Optional string fields — truncate if too long (defensive, after length check)
	if (e.workspaceName !== undefined && e.workspaceName !== null) {
		if (typeof e.workspaceName !== 'string') return '"workspaceName" must be a string';
	}
	if (e.machineName !== undefined && e.machineName !== null) {
		if (typeof e.machineName !== 'string') return '"machineName" must be a string';
	}
	if (e.datasetId !== undefined && e.datasetId !== null) {
		if (typeof e.datasetId !== 'string') return '"datasetId" must be a string';
		if (e.datasetId.length > MAX_STRING_LENGTHS.datasetId) {
			return `"datasetId" too long (max ${MAX_STRING_LENGTHS.datasetId})`;
		}
	}
	if (e.editor !== undefined && e.editor !== null) {
		if (typeof e.editor !== 'string') return '"editor" must be a string';
		if (e.editor.length > MAX_STRING_LENGTHS.editor) {
			return `"editor" too long (max ${MAX_STRING_LENGTHS.editor})`;
		}
	}

	return null;
}

function isNonNegativeInt(value: unknown): boolean {
	return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}
