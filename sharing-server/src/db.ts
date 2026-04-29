import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, existsSync, copyFileSync } from 'fs';
import { join, dirname } from 'path';

export interface UserRow {
	id: number;
	github_id: number;
	github_login: string;
	github_name: string | null;
	avatar_url: string | null;
	created_at: string;
	last_seen_at: string | null;
	is_admin: number;
	fluency_score_json: string | null;
}

export interface UserUsageSummary {
	user_id: number;
	github_login: string;
	github_name: string | null;
	avatar_url: string | null;
	is_admin: number;
	total_input: number;
	total_output: number;
	total_interactions: number;
	days_active: number;
	last_upload_day: string | null;
}

export interface AdminDailyRow {
	day: string;
	github_login: string;
	input_tokens: number;
	output_tokens: number;
	interactions: number;
}

export interface UploadRow {
	id: number;
	user_id: number;
	dataset_id: string;
	day: string;
	model: string;
	workspace_id: string;
	workspace_name: string | null;
	machine_id: string;
	machine_name: string | null;
	editor: string;
	input_tokens: number;
	output_tokens: number;
	interactions: number;
	schema_version: number;
	uploaded_at: string;
	fluency_json: string | null;
}

export interface UploadEntry {
	datasetId?: string;
	day: string;
	model: string;
	workspaceId: string;
	workspaceName?: string;
	machineId: string;
	machineName?: string;
	editor?: string;
	inputTokens: number;
	outputTokens: number;
	interactions: number;
	fluencyMetrics?: Record<string, unknown>;
}

let _db: DatabaseSync | undefined;

// SQLite runs on the container's LOCAL ephemeral disk (LOCAL_DATA_DIR / /tmp/db).
// Azure Files (/data) is used ONLY for backup/restore via plain file copy — never
// as a live SQLite database. Azure Files SMB does not support the POSIX advisory
// byte-range locks that SQLite requires, causing persistent "database is locked"
// errors when using Azure Files as the live database path.
function resolveLocalDbPath(): string {
	const dir = process.env.LOCAL_DATA_DIR
		?? process.env.DATA_DIR
		?? (process.env.NODE_ENV === 'production' ? '/tmp/db' : './data');
	return join(dir, 'sharing.db');
}

function resolveBackupPath(): string | null {
	// Backup is only meaningful when LOCAL_DATA_DIR is set (SQLite not on DATA_DIR).
	if (!process.env.LOCAL_DATA_DIR) return null;
	const backupDir = process.env.DATA_DIR ?? (process.env.NODE_ENV === 'production' ? '/data' : null);
	return backupDir ? join(backupDir, 'sharing.db') : null;
}

/** Restore the database from Azure Files backup (if one exists) onto local disk. */
export function restoreFromBackup(): void {
	const backupPath = resolveBackupPath();
	if (!backupPath || !existsSync(backupPath)) return;
	const localPath = resolveLocalDbPath();
	try {
		mkdirSync(dirname(localPath), { recursive: true });
		copyFileSync(backupPath, localPath);
		console.log('[db] Restored database from Azure Files backup');
	} catch (err) {
		console.error('[db] Failed to restore from backup (will start fresh):', err);
	}
}

/** Copy the local database to Azure Files for persistence across container restarts. */
export function backupToAzureFiles(): void {
	const backupPath = resolveBackupPath();
	if (!backupPath) return;
	const localPath = resolveLocalDbPath();
	if (!existsSync(localPath)) return;
	try {
		mkdirSync(dirname(backupPath), { recursive: true });
		copyFileSync(localPath, backupPath);
		console.log('[db] Backed up database to Azure Files');
	} catch (err) {
		console.error('[db] Failed to backup to Azure Files:', err);
	}
}

export function getDb(): DatabaseSync {
	if (!_db) {
		const dbPath = resolveLocalDbPath();
		const dataDir = dirname(dbPath);
		if (!existsSync(dataDir)) {
			mkdirSync(dataDir, { recursive: true });
		}
		// Open first, then configure — only assign _db once fully initialized so
		// that a failed startup causes the next request to retry initialization.
		const db = new DatabaseSync(dbPath);
		try {
			db.exec('PRAGMA busy_timeout = 5000');
			// WAL mode is safe on local disk and gives better concurrency than DELETE.
			db.exec('PRAGMA journal_mode = WAL');
			db.exec('PRAGMA foreign_keys = ON');
			initSchema(db);
			_db = db;
		} catch (err) {
			try { db.close(); } catch { /* ignore */ }
			throw err;
		}
	}
	return _db;
}

const UPLOADS_TABLE_DDL = `
	CREATE TABLE usage_uploads (
		id             INTEGER PRIMARY KEY,
		user_id        INTEGER NOT NULL REFERENCES users(id),
		dataset_id     TEXT NOT NULL DEFAULT 'default',
		day            TEXT NOT NULL,
		model          TEXT NOT NULL,
		workspace_id   TEXT NOT NULL,
		workspace_name TEXT,
		machine_id     TEXT NOT NULL,
		machine_name   TEXT,
		editor         TEXT NOT NULL DEFAULT 'VS Code',
		input_tokens   INTEGER NOT NULL DEFAULT 0,
		output_tokens  INTEGER NOT NULL DEFAULT 0,
		interactions   INTEGER NOT NULL DEFAULT 0,
		schema_version INTEGER NOT NULL DEFAULT 3,
		uploaded_at    TEXT DEFAULT (datetime('now')),
		fluency_json   TEXT,
		UNIQUE(user_id, dataset_id, day, model, workspace_id, machine_id, editor)
	)`;

function initSchema(db: DatabaseSync): void {
	// Users table — stable schema
	db.exec(`
		CREATE TABLE IF NOT EXISTS users (
			id           INTEGER PRIMARY KEY,
			github_id    INTEGER UNIQUE NOT NULL,
			github_login TEXT NOT NULL,
			github_name  TEXT,
			avatar_url   TEXT,
			created_at   TEXT DEFAULT (datetime('now')),
			last_seen_at TEXT,
			is_admin     INTEGER DEFAULT 0
		)
	`);

	// Check whether usage_uploads needs to be created or migrated
	const tableRow = db
		.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='usage_uploads'")
		.get() as unknown as { sql: string } | undefined;

	if (!tableRow) {
		// Fresh database — create with current schema
		db.exec(UPLOADS_TABLE_DDL);
	} else if (!tableRow.sql.includes('editor')) {
		// Old schema without the editor column — rebuild to add editor to the UNIQUE key.
		// A plain ALTER TABLE is insufficient because SQLite cannot modify existing constraints.
		db.exec(`
			BEGIN TRANSACTION;

			CREATE TABLE usage_uploads_v2 (
				id             INTEGER PRIMARY KEY,
				user_id        INTEGER NOT NULL REFERENCES users(id),
				dataset_id     TEXT NOT NULL DEFAULT 'default',
				day            TEXT NOT NULL,
				model          TEXT NOT NULL,
				workspace_id   TEXT NOT NULL,
				workspace_name TEXT,
				machine_id     TEXT NOT NULL,
				machine_name   TEXT,
				editor         TEXT NOT NULL DEFAULT 'VS Code',
				input_tokens   INTEGER NOT NULL DEFAULT 0,
				output_tokens  INTEGER NOT NULL DEFAULT 0,
				interactions   INTEGER NOT NULL DEFAULT 0,
				schema_version INTEGER NOT NULL DEFAULT 3,
				uploaded_at    TEXT DEFAULT (datetime('now')),
				UNIQUE(user_id, dataset_id, day, model, workspace_id, machine_id, editor)
			);

			INSERT INTO usage_uploads_v2
				SELECT id, user_id, dataset_id, day, model, workspace_id, workspace_name,
				       machine_id, machine_name, 'VS Code',
				       input_tokens, output_tokens, interactions, schema_version, uploaded_at
				FROM usage_uploads;

			DROP TABLE usage_uploads;
			ALTER TABLE usage_uploads_v2 RENAME TO usage_uploads;

			COMMIT;
		`);
	}

	db.exec(`
		CREATE INDEX IF NOT EXISTS idx_uploads_user_day ON usage_uploads(user_id, day);
		CREATE INDEX IF NOT EXISTS idx_uploads_dataset   ON usage_uploads(dataset_id, day);
		CREATE INDEX IF NOT EXISTS idx_uploads_day       ON usage_uploads(day);
	`);

	// Add fluency_json column if it doesn't exist (migration for existing DBs)
	const cols = db
		.prepare("PRAGMA table_info(usage_uploads)")
		.all() as unknown as Array<{ name: string }>;
	if (!cols.some(c => c.name === 'fluency_json')) {
		db.exec('ALTER TABLE usage_uploads ADD COLUMN fluency_json TEXT');
	}

	// Add fluency_score_json column to users if it doesn't exist (migration for existing DBs)
	const userCols = db
		.prepare("PRAGMA table_info(users)")
		.all() as unknown as Array<{ name: string }>;
	if (!userCols.some(c => c.name === 'fluency_score_json')) {
		db.exec('ALTER TABLE users ADD COLUMN fluency_score_json TEXT');
	}
}

/** Returns the parsed ADMIN_GITHUB_LOGINS env var as an array of lowercase logins. */
function getAdminLoginsFromEnv(): string[] {
	const raw = process.env.ADMIN_GITHUB_LOGINS ?? '';
	return raw.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
}

/**
 * Sync admin status for all existing users based on ADMIN_GITHUB_LOGINS.
 * When the env var is set and non-empty, it is authoritative: users in the list
 * get is_admin=1, all others get is_admin=0. When unset or empty, no changes are made.
 */
export function syncAdminLogins(): void {
	const logins = getAdminLoginsFromEnv();
	if (logins.length === 0) return;
	const db = getDb();
	const placeholders = logins.map(() => '?').join(', ');
	db.prepare(`UPDATE users SET is_admin = CASE WHEN LOWER(github_login) IN (${placeholders}) THEN 1 ELSE 0 END`).run(...logins);
	console.log(`[db] Admin sync from ADMIN_GITHUB_LOGINS: ${logins.join(', ')}`);
}

export function upsertUser(
	githubId: number,
	login: string,
	name: string | null,
	avatarUrl: string | null,
): UserRow {
	const db = getDb();
	db.prepare(`
		INSERT INTO users (github_id, github_login, github_name, avatar_url, last_seen_at)
		VALUES (?, ?, ?, ?, datetime('now'))
		ON CONFLICT(github_id) DO UPDATE SET
			github_login = excluded.github_login,
			github_name  = excluded.github_name,
			avatar_url   = excluded.avatar_url,
			last_seen_at = datetime('now')
	`).run(githubId, login, name, avatarUrl);
	// Apply env-var admin grant immediately so new users get the right role on first login.
	const adminLogins = getAdminLoginsFromEnv();
	if (adminLogins.includes(login.toLowerCase())) {
		db.prepare('UPDATE users SET is_admin = 1 WHERE github_id = ?').run(githubId);
	}
	return db.prepare('SELECT * FROM users WHERE github_id = ?').get(githubId) as unknown as UserRow;
}

export function getUserById(id: number): UserRow | undefined {
	return getDb().prepare('SELECT * FROM users WHERE id = ?').get(id) as unknown as UserRow | undefined;
}

export function getUserByGithubId(githubId: number): UserRow | undefined {
	return getDb().prepare('SELECT * FROM users WHERE github_id = ?').get(githubId) as unknown as UserRow | undefined;
}

export function upsertUpload(userId: number, entry: UploadEntry): void {
	const editor = ((entry.editor ?? '').trim() || 'VS Code').slice(0, 100);
	const fluencyJson = entry.fluencyMetrics ? JSON.stringify(entry.fluencyMetrics) : null;
	getDb().prepare(`
		INSERT INTO usage_uploads
			(user_id, dataset_id, day, model, workspace_id, workspace_name, machine_id, machine_name,
			 editor, input_tokens, output_tokens, interactions, fluency_json)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(user_id, dataset_id, day, model, workspace_id, machine_id, editor) DO UPDATE SET
			workspace_name = excluded.workspace_name,
			machine_name   = excluded.machine_name,
			input_tokens   = excluded.input_tokens,
			output_tokens  = excluded.output_tokens,
			interactions   = excluded.interactions,
			fluency_json   = excluded.fluency_json,
			uploaded_at    = datetime('now')
	`).run(
		userId,
		entry.datasetId ?? 'default',
		entry.day,
		entry.model,
		entry.workspaceId,
		entry.workspaceName ?? null,
		entry.machineId,
		entry.machineName ?? null,
		editor,
		entry.inputTokens,
		entry.outputTokens,
		entry.interactions,
		fluencyJson,
	);
}

/**
 * Delete all rows for a user+dataset for specific days before a full re-upload.
 * This prevents stale rows (e.g. old editor="VS Code" rows for what are now
 * correctly-attributed CLI/Claude sessions) from accumulating when the upload
 * schema changes.
 */
export function deleteUploadsForDays(userId: number, datasetId: string, days: string[]): void {
	if (days.length === 0) return;
	const placeholders = days.map(() => '?').join(', ');
	getDb().prepare(`
		DELETE FROM usage_uploads
		WHERE user_id = ? AND dataset_id = ? AND day IN (${placeholders})
	`).run(userId, datasetId, ...days);
}

export function getUploadsForUser(userId: number, days = 30): UploadRow[] {
	return getDb().prepare(`
		SELECT * FROM usage_uploads
		WHERE user_id = ?
		  AND day >= date('now', '-' || ? || ' days')
		ORDER BY day DESC, model
	`).all(userId, days) as unknown as UploadRow[];
}

export function getAllUsers(): UserRow[] {
	return getDb().prepare('SELECT * FROM users ORDER BY created_at DESC').all() as unknown as UserRow[];
}

export interface AdminUploadRow extends UploadRow {
	github_login: string;
}

export function getAllUploads(days = 30): AdminUploadRow[] {
	return getDb().prepare(`
		SELECT uu.*, u.github_login
		FROM usage_uploads uu
		JOIN users u ON uu.user_id = u.id
		WHERE uu.day >= date('now', '-' || ? || ' days')
		ORDER BY uu.day DESC, uu.model
	`).all(days) as unknown as AdminUploadRow[];
}

export function upsertUserFluencyScore(userId: number, scoreJson: string): void {
	getDb().prepare(`
		UPDATE users SET fluency_score_json = ? WHERE id = ?
	`).run(scoreJson, userId);
}

export function getUserFluencyScore(userId: number): string | null {
	const row = getDb().prepare('SELECT fluency_score_json FROM users WHERE id = ?').get(userId) as unknown as { fluency_score_json: string | null } | undefined;
	return row?.fluency_score_json ?? null;
}

/** Cleanly close the database connection — call on SIGTERM to release Azure Files SMB locks. */
export function closeDb(): void {
	if (_db) {
		try { _db.close(); } catch { /* ignore */ }
		_db = undefined;
	}
}

/**
 * Per-user aggregate stats for the admin dashboard.
 * LEFT JOIN ensures users with no uploads in the period still appear (with zeros).
 * `last_upload_day` reflects their all-time last upload, not filtered to the period.
 */
export function getAdminUserSummaries(days: number): UserUsageSummary[] {
	const cutoff = new Date();
	cutoff.setUTCDate(cutoff.getUTCDate() - days);
	const cutoffStr = cutoff.toISOString().slice(0, 10);
	return getDb().prepare(`
		SELECT
			u.id                                                                       AS user_id,
			u.github_login,
			u.github_name,
			u.avatar_url,
			u.is_admin,
			COALESCE(SUM(CASE WHEN uu.day >= ? THEN uu.input_tokens  ELSE 0 END), 0)  AS total_input,
			COALESCE(SUM(CASE WHEN uu.day >= ? THEN uu.output_tokens ELSE 0 END), 0)  AS total_output,
			COALESCE(SUM(CASE WHEN uu.day >= ? THEN uu.interactions  ELSE 0 END), 0)  AS total_interactions,
			COUNT(DISTINCT CASE WHEN uu.day >= ? THEN uu.day END)                     AS days_active,
			MAX(uu.day)                                                                AS last_upload_day
		FROM users u
		LEFT JOIN usage_uploads uu ON uu.user_id = u.id
		GROUP BY u.id
		ORDER BY total_input + total_output DESC
	`).all(cutoffStr, cutoffStr, cutoffStr, cutoffStr) as unknown as UserUsageSummary[];
}

/** Daily per-user token totals for the admin trend chart. */
export function getAdminDailyTotals(days: number): AdminDailyRow[] {
	return getDb().prepare(`
		SELECT
			uu.day,
			u.github_login,
			SUM(uu.input_tokens)  AS input_tokens,
			SUM(uu.output_tokens) AS output_tokens,
			SUM(uu.interactions)  AS interactions
		FROM usage_uploads uu
		JOIN users u ON u.id = uu.user_id
		WHERE uu.day >= date('now', '-' || ? || ' days')
		GROUP BY uu.day, u.github_login
		ORDER BY uu.day, u.github_login
	`).all(days) as unknown as AdminDailyRow[];
}
