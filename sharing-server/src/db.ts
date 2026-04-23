import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, existsSync } from 'fs';
import { join } from 'path';

export interface UserRow {
	id: number;
	github_id: number;
	github_login: string;
	github_name: string | null;
	avatar_url: string | null;
	created_at: string;
	last_seen_at: string | null;
	is_admin: number;
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
}

let _db: DatabaseSync | undefined;

export function getDb(): DatabaseSync {
	if (!_db) {
		const dataDir = process.env.DATA_DIR ?? (process.env.NODE_ENV === 'production' ? '/data' : './data');
		if (!existsSync(dataDir)) {
			mkdirSync(dataDir, { recursive: true });
		}
		const dbPath = join(dataDir, 'sharing.db');
		_db = new DatabaseSync(dbPath);
		_db.exec('PRAGMA journal_mode = WAL');
		_db.exec('PRAGMA foreign_keys = ON');
		initSchema(_db);
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
	`);
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
	getDb().prepare(`
		INSERT INTO usage_uploads
			(user_id, dataset_id, day, model, workspace_id, workspace_name, machine_id, machine_name,
			 editor, input_tokens, output_tokens, interactions)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(user_id, dataset_id, day, model, workspace_id, machine_id, editor) DO UPDATE SET
			workspace_name = excluded.workspace_name,
			machine_name   = excluded.machine_name,
			input_tokens   = excluded.input_tokens,
			output_tokens  = excluded.output_tokens,
			interactions   = excluded.interactions,
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
	);
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
