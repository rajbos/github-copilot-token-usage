import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import initSqlJs from 'sql.js';
import { CopilotAppDataAccess } from '../../../vscode-extension/src/copilotAppData';

type FakeRow = (string | number | null)[];

/**
 * Minimal fake sql.js `Database` used to control exactly what
 * `getSessionHierarchy`/`getSessionContextInfo` see, without depending on a
 * real SQLite file layout. `readDbBufferWithWal` still runs for real against
 * `dbPath` (this is what we are testing) — only the sql.js parsing layer is
 * faked, mirroring the approach in opencode-cache.test.ts.
 */
class FakeDatabase {
	closed = false;
	constructor(public readonly buffer: Buffer) {}

	exec(sql: string): Array<{ columns: string[]; values: FakeRow[] }> {
		if (sql.includes('FROM sessions')) {
			return [{
				columns: ['id', 'context_tier', 'context_current_tokens', 'context_input_token_limit'],
				values: [['session-1', 'default', 4200, 128000]],
			}];
		}
		if (sql.includes('workspace_parent_links')) {
			return [];
		}
		return [];
	}

	close(): void {
		this.closed = true;
	}
}

function createHarness() {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-app-data-'));
	const dbPath = path.join(tmpDir, 'data.db');
	const opened: FakeDatabase[] = [];

	const access = new CopilotAppDataAccess();
	access.getDbPath = () => dbPath;
	(access as any).initSqlJs = async () => ({
		Database: class extends FakeDatabase {
			constructor(buffer: Buffer) {
				super(buffer);
				opened.push(this);
			}
		},
	});

	return {
		access,
		dbPath,
		opened,
		cleanup: () => fs.rmSync(tmpDir, { recursive: true, force: true }),
	};
}

test('getSessionContextInfo returns parsed context window data when no WAL file exists', async () => {
	const harness = createHarness();
	try {
		fs.writeFileSync(harness.dbPath, 'fake-db-bytes');

		const result = await harness.access.getSessionContextInfo(['session-1']);

		assert.equal(result.size, 1);
		assert.deepEqual(result.get('session-1'), {
			uuid: 'session-1',
			contextTier: 'default',
			contextReachedTokens: 4200,
			contextWindowLimit: 128000,
		});
		assert.equal(harness.opened.length, 1);
		// The loaded copy is shared for a short while; it is released on dispose.
		assert.equal(harness.opened[0].closed, false);
		harness.access.dispose();
		assert.equal(harness.opened[0].closed, true);
	} finally {
		harness.cleanup();
	}
});

test('repeated queries reuse one loaded copy of data.db instead of re-reading it each time', async () => {
	const harness = createHarness();
	try {
		fs.writeFileSync(harness.dbPath, 'fake-db-bytes');

		await Promise.all([
			harness.access.getSessionContextInfo(['session-1']),
			harness.access.getSessionHierarchy(['session-1']),
			harness.access.getSessionContextInfo(['session-1']),
		]);
		await harness.access.getSessionHierarchy(['session-1']);

		assert.equal(harness.opened.length, 1, 'concurrent and follow-up queries must share one load');
		harness.access.dispose();
		assert.equal(harness.opened[0].closed, true);
	} finally {
		harness.access.dispose();
		harness.cleanup();
	}
});

test('separate access instances (different screens) share one process-wide loaded data.db', async () => {
	const harness = createHarness();
	try {
		fs.writeFileSync(harness.dbPath, 'fake-db-bytes');
		const other = new CopilotAppDataAccess();
		other.getDbPath = () => harness.dbPath;
		(other as any).initSqlJs = (harness.access as any).initSqlJs;

		await harness.access.getSessionContextInfo(['session-1']);
		await other.getSessionContextInfo(['session-1']);

		assert.equal(harness.opened.length, 1, 'the second screen must reuse the loaded copy of the first');
	} finally {
		harness.access.dispose();
		harness.cleanup();
	}
});

test('getSessionContextInfo returns empty map when data.db does not exist', async () => {
	const harness = createHarness();
	try {
		// Note: dbPath is never written to disk.
		const result = await harness.access.getSessionContextInfo(['session-1']);

		assert.equal(result.size, 0);
		assert.equal(harness.opened.length, 0);
	} finally {
		harness.cleanup();
	}
});

test('getSessionContextInfo falls back to a direct read when the WAL file is empty', async () => {
	const harness = createHarness();
	try {
		fs.writeFileSync(harness.dbPath, 'fake-db-bytes');
		fs.writeFileSync(harness.dbPath + '-wal', ''); // empty WAL — no merge needed

		const result = await harness.access.getSessionContextInfo(['session-1']);

		assert.equal(result.size, 1);
		assert.equal(result.get('session-1')?.contextReachedTokens, 4200);
	} finally {
		harness.cleanup();
	}
});

test('getSessionContextInfo tolerates an unmergeable WAL file without leaking temp files', async () => {
	const harness = createHarness();
	try {
		fs.writeFileSync(harness.dbPath, 'fake-db-bytes');
		// Non-empty but not a real SQLite WAL — node:sqlite will fail to open the
		// copied temp db, so tryReadDbWithWal should fall back to a direct read
		// of the (unmerged) main file rather than throwing.
		fs.writeFileSync(harness.dbPath + '-wal', 'not-a-real-wal-file');

		const tmpDir = path.join(os.homedir(), '.copilot', 'tmp');
		const before = fs.existsSync(tmpDir) ? fs.readdirSync(tmpDir).length : 0;

		const result = await harness.access.getSessionContextInfo(['session-1']);

		assert.equal(result.size, 1, 'should still read the main db file even when the WAL merge fails');

		const after = fs.existsSync(tmpDir) ? fs.readdirSync(tmpDir).length : 0;
		assert.equal(after, before, 'no temp WAL-merge files should remain after a failed merge attempt');
	} finally {
		harness.cleanup();
	}
});

test('getSessionHierarchy returns an empty map for an empty input list without touching data.db', async () => {
	const harness = createHarness();
	try {
		const result = await harness.access.getSessionHierarchy([]);

		assert.equal(result.size, 0);
		assert.equal(harness.opened.length, 0);
	} finally {
		harness.cleanup();
	}
});

test('getSessionContextInfo sees a row that exists only in the WAL (not yet checkpointed), unlike a main-file-only read', async (t) => {
	let DatabaseSync: typeof import('node:sqlite').DatabaseSync;
	try {
		({ DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite'));
	} catch {
		t.skip('node:sqlite is not available in this Node version');
		return;
	}
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-app-data-wal-'));
	const dbPath = path.join(tmpDir, 'data.db');
	const writer = new DatabaseSync(dbPath);
	try {
		writer.exec('PRAGMA journal_mode=WAL;');
		writer.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, context_tier TEXT, context_current_tokens INTEGER, context_input_token_limit INTEGER);');
		// Fold the schema into the main file, then commit the row so it lives only in the -wal.
		writer.exec('PRAGMA wal_checkpoint(TRUNCATE);');
		writer.exec("INSERT INTO sessions VALUES ('wal-only-session', 'default', 9876, 200000);");
		assert.ok(fs.statSync(dbPath + '-wal').size > 0, 'fixture setup: the row must be pending in the -wal file');

		// Negative control: a reader of just the main file (the original bug) cannot see the row.
		const sqlJs = await initSqlJs();
		const mainOnly = new sqlJs.Database(fs.readFileSync(dbPath));
		try {
			const res = mainOnly.exec("SELECT id FROM sessions WHERE id = 'wal-only-session'");
			assert.equal(res.length, 0, 'main-file-only read must NOT see the uncheckpointed row — otherwise this test would not exercise the bug');
		} finally {
			mainOnly.close();
		}

		const access = new CopilotAppDataAccess();
		access.getDbPath = () => dbPath;
		const result = await access.getSessionContextInfo(['wal-only-session']);

		assert.deepEqual(result.get('wal-only-session'), {
			uuid: 'wal-only-session',
			contextTier: 'default',
			contextReachedTokens: 9876,
			contextWindowLimit: 200000,
		});
	} finally {
		try { writer.close(); } catch { /* ignore */ }
		fs.rmSync(tmpDir, { recursive: true, force: true });
	}
});
