/**
 * Smoke test for the published shape of `@rajbos/ai-engineering-fluency/session`: loads the
 * built dist/ through the package's own `exports` map (Node resolves a package's own name
 * from inside it), exactly as a consumer's `require()` / `import` would. `npm test` builds
 * dist/ first; esbuild.tests.js keeps the specifier external so it is not bundled here.
 */
import test, { after } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// sql.js has no types in the CLI's own node_modules; type just what the DB fixture uses.
type SqlDatabase = { run(sql: string, params?: unknown[]): void; export(): Uint8Array; close(): void };
// eslint-disable-next-line @typescript-eslint/no-require-imports
const initSqlJs: (config: { wasmBinary: ArrayBuffer }) => Promise<{ Database: new () => SqlDatabase }> = require('sql.js');

const PKG = '@rajbos/ai-engineering-fluency/session';
const CLI_ROOT = path.resolve(__dirname, '..', '..');

// Not under os.tmpdir(): the shared safe file reader refuses to read session files there.
const fakeHome = fs.mkdtempSync(path.join(CLI_ROOT, 'out', 'pkg-home-'));
process.env.HOME = fakeHome;
process.env.USERPROFILE = fakeHome;
after(() => fs.rmSync(fakeHome, { recursive: true, force: true }));
const FIXTURES = path.join(CLI_ROOT, 'src', 'test', 'fixtures');

function placeCopilotCliFixture(): string {
	const target = path.join(fakeHome, '.copilot', 'session-state', '44444444-4444-4444-8444-444444444444', 'events.jsonl');
	fs.mkdirSync(path.dirname(target), { recursive: true });
	fs.copyFileSync(path.join(FIXTURES, 'copilot-cli-events.jsonl'), target);
	return target;
}

test('require() of the package subpath loads the built CommonJS library', async () => {
	// eslint-disable-next-line @typescript-eslint/no-require-imports
	const lib = require(PKG);
	assert.equal(require.resolve(PKG), path.join(CLI_ROOT, 'dist', 'lib', 'session.js'));
	assert.equal(typeof lib.analyzeSessionFile, 'function');
	assert.equal(typeof lib.analyzeSessionFiles, 'function');

	const usage = await lib.analyzeSessionFile(placeCopilotCliFixture());
	assert.equal(usage.copilotNanoAiu, 3_750_000_000);
	assert.equal(usage.copilotCredits, 3.75);
	assert.equal(await lib.analyzeSessionFile(path.join(fakeHome, 'missing.jsonl')), null);
});

const STORE_PATH = path.join(fakeHome, '.copilot', 'session-store.db');

/** Write ~/.copilot/session-store.db with the given billing rows: [sessionId, outputTokens, nanoAiu]. */
async function writeSessionStore(rows: Array<[string, number, number]>): Promise<void> {
	const SQL = await initSqlJs({ wasmBinary: fs.readFileSync(path.join(CLI_ROOT, 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm')).buffer as ArrayBuffer });
	const db = new SQL.Database();
	db.run(`CREATE TABLE sessions (id TEXT, cwd TEXT, repository TEXT, branch TEXT, summary TEXT, created_at TEXT, updated_at TEXT);
		CREATE TABLE turns (session_id TEXT, turn_index INTEGER, user_message TEXT, assistant_response TEXT, timestamp TEXT);
		CREATE TABLE assistant_usage_events (session_id TEXT, model TEXT, input_tokens INTEGER, output_tokens INTEGER,
			cache_read_tokens INTEGER, cache_write_tokens INTEGER, total_nano_aiu INTEGER);`);
	for (const sessionId of new Set(rows.map(([id]) => id))) {
		db.run('INSERT INTO sessions VALUES (?, ?, NULL, NULL, NULL, ?, ?)', [sessionId, '/work/demo', '2026-10-01T09:00:00Z', '2026-10-01T09:05:00Z']);
		db.run('INSERT INTO turns VALUES (?, 0, ?, ?, ?)', [sessionId, 'hi', 'hello', '2026-10-01T09:00:00Z']);
	}
	for (const [sessionId, outputTokens, nanoAiu] of rows) {
		db.run('INSERT INTO assistant_usage_events VALUES (?, ?, 1000, ?, 0, 0, ?)', [sessionId, 'claude-sonnet-4.5', outputTokens, nanoAiu]);
	}
	fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
	fs.writeFileSync(STORE_PATH, Buffer.from(db.export()));
	db.close();
}

test('Copilot CLI DB-only sessions (session-store.db#<id>) carry exact billing', async () => {
	const sessionId = '88888888-8888-4888-8888-888888888888';
	await writeSessionStore([[sessionId, 200, 2_000_000_000], [sessionId, 100, 500_000_000]]);

	// eslint-disable-next-line @typescript-eslint/no-require-imports
	const lib = require(PKG);
	const usage = await lib.analyzeSessionFile(`${STORE_PATH}#${sessionId}`);
	assert.ok(usage, 'expected a result for a DB-only Copilot CLI session');
	assert.equal(usage.editorSource, 'Copilot CLI');
	assert.equal(usage.copilotNanoAiu, 2_500_000_000);
	assert.equal(usage.copilotCredits, 2.5);
	assert.equal(usage.modelUsage['claude-sonnet-4.5'].outputTokens, 300);
});

test('cache: billing rows landing in session-store.db are picked up without the events.jsonl changing', async () => {
	const sessionId = '99999999-9999-4999-8999-999999999999';
	const events = path.join(fakeHome, '.copilot', 'session-state', sessionId, 'events.jsonl');
	fs.mkdirSync(path.dirname(events), { recursive: true });
	fs.copyFileSync(path.join(FIXTURES, 'copilot-cli-events.jsonl'), events);
	const before = fs.statSync(events);

	// eslint-disable-next-line @typescript-eslint/no-require-imports
	const lib = require(PKG);
	const first = await lib.analyzeSessionFile(events);
	assert.equal(first.copilotNanoAiu, 3_750_000_000, 'no store rows yet: billing from the latest usage_checkpoint');
	assert.equal(await lib.analyzeSessionFile(events), first, 'unchanged sources: cache hit');

	await writeSessionStore([[sessionId, 400, 9_000_000_000]]);
	const second = await lib.analyzeSessionFile(events);
	const after = fs.statSync(events);
	assert.equal(after.mtimeMs, before.mtimeMs);
	assert.equal(after.size, before.size);
	assert.equal(second.copilotNanoAiu, 9_000_000_000, 'store rows win over the event log');
	assert.equal(second.copilotCredits, 9);
});

test('Copilot billing is only matched to Copilot CLI paths, not to another tool with the same UUID', async () => {
	// Same UUID as billing rows in ~/.copilot/session-store.db, but the file is not under
	// ~/.copilot/session-state/, so it must not pick up Copilot's exact usage.
	const sessionId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
	await writeSessionStore([[sessionId, 400, 7_000_000_000]]);
	const elsewhere = path.join(fakeHome, 'other-tool', 'session-state', sessionId, 'events.jsonl');
	fs.mkdirSync(path.dirname(elsewhere), { recursive: true });
	fs.copyFileSync(path.join(FIXTURES, 'copilot-cli-events.jsonl'), elsewhere);

	// eslint-disable-next-line @typescript-eslint/no-require-imports
	const lib = require(PKG);
	const usage = await lib.analyzeSessionFile(elsewhere);
	assert.ok(usage);
	assert.equal(usage.copilotNanoAiu, 3_750_000_000, 'from its own usage_checkpoint, not the store row');
});

test('per-model usage is normalized to the single-session shape (sessions: 0)', async () => {
	// Hermes' fallback (sessions row, no session_model_usage rows) reports `sessions: 1`.
	const SQL = await initSqlJs({ wasmBinary: fs.readFileSync(path.join(CLI_ROOT, 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm')).buffer as ArrayBuffer });
	const db = new SQL.Database();
	db.run(`CREATE TABLE sessions (id TEXT, source TEXT, display_name TEXT, model TEXT, started_at REAL, ended_at REAL,
		message_count INTEGER, tool_call_count INTEGER, input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER,
		cache_write_tokens INTEGER, reasoning_tokens INTEGER, cwd TEXT, git_branch TEXT, git_repo_root TEXT, title TEXT,
		api_call_count INTEGER, parent_session_id TEXT, archived INTEGER, pinned INTEGER);`);
	db.run(`INSERT INTO sessions VALUES ('s1', 'cli', NULL, 'claude-sonnet-4.5', 1, 2, 2, 0, 1000, 200, 0, 0, 0,
		NULL, NULL, NULL, 'demo', 1, NULL, 0, 0)`);
	const hermesDb = path.join(fakeHome, 'hermes', 'state.db');
	fs.mkdirSync(path.dirname(hermesDb), { recursive: true });
	fs.writeFileSync(hermesDb, Buffer.from(db.export()));
	db.close();

	// eslint-disable-next-line @typescript-eslint/no-require-imports
	const lib = require(PKG);
	const usage = await lib.analyzeSessionFile(`${hermesDb}#s1`);
	assert.ok(usage, 'expected a result for a Hermes session');
	assert.equal(usage.modelUsage['claude-sonnet-4.5'].inputTokens, 1000);
	assert.equal(usage.modelUsage['claude-sonnet-4.5'].sessions, 0);
});

test('adapter-handled paths whose backing file is in the OS temp directory are refused', async () => {
	// A valid DB-only Copilot CLI session, but the store sits in os.tmpdir(): the adapter would
	// read the whole DB, so the library refuses it before any adapter runs.
	const sessionId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
	await writeSessionStore([[sessionId, 200, 1_000_000_000]]);
	const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aief-pkg-temp-'));
	try {
		const tempStore = path.join(tempRoot, 'session-store.db');
		fs.copyFileSync(STORE_PATH, tempStore);
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		const lib = require(PKG);
		assert.ok(await lib.analyzeSessionFile(`${STORE_PATH}#${sessionId}`), 'the same store outside temp is read');
		assert.equal(await lib.analyzeSessionFile(`${tempStore}#${sessionId}`), null);
	} finally {
		fs.rmSync(tempRoot, { recursive: true, force: true });
	}
});

test('import() of the package subpath shares the CommonJS module instance', async () => {
	const esm = await import(PKG);
	// eslint-disable-next-line @typescript-eslint/no-require-imports
	const cjs = require(PKG);
	assert.equal(esm.analyzeSessionFile, cjs.analyzeSessionFile);
});

test('exports map points at files that exist, with self-contained types', () => {
	const pkg = JSON.parse(fs.readFileSync(path.join(CLI_ROOT, 'package.json'), 'utf-8'));
	assert.equal(pkg.bin['ai-engineering-fluency'], 'dist/cli.js');
	const entry = pkg.exports['./session'];
	for (const target of [entry.import.types, entry.import.default, entry.require.types, entry.require.default]) {
		assert.ok(fs.existsSync(path.join(CLI_ROOT, target)), `${target} is missing from dist/`);
	}
	assert.ok(fs.existsSync(path.join(CLI_ROOT, 'dist', 'lib', 'sql-wasm.wasm')), 'library needs its own sql-wasm.wasm');

	const dts = fs.readFileSync(path.join(CLI_ROOT, entry.require.types), 'utf-8');
	assert.doesNotMatch(dts, /\bfrom\s+['"]|\bimport\s*\(/, 'session.d.ts must not import other modules');
	for (const name of ['SessionUsage', 'AnalyzeSessionOptions', 'analyzeSessionFile', 'analyzeSessionFiles']) {
		assert.match(dts, new RegExp(`\\b${name}\\b`));
	}
});

test('the library bundle carries no CLI code or console output', () => {
	const bundle = fs.readFileSync(path.join(CLI_ROOT, 'dist', 'lib', 'session.js'), 'utf-8');
	assert.doesNotMatch(bundle, /^#!/, 'no CLI shebang');
	assert.doesNotMatch(bundle, /node_modules\/(chalk|commander)\//, 'no chalk/commander');
	// Shared code's console calls are rerouted to a no-op object at bundle time. Comment lines
	// are skipped: a doc comment may mention console.error() without calling it.
	const code = bundle.split('\n').filter(line => !/^\s*(\/\/|\/?\*)/.test(line)).join('\n');
	assert.doesNotMatch(code, /\bconsole\.(log|info|warn|error|debug)\(/);
	assert.doesNotMatch(code, /process\.exit\(/);
});

test('the library writes nothing to the console, even for files it cannot read', async () => {
	// eslint-disable-next-line @typescript-eslint/no-require-imports
	const lib = require(PKG);
	const methods = ['log', 'info', 'warn', 'error', 'debug'] as const;
	const calls: string[] = [];
	const originals = methods.map(m => console[m]);
	methods.forEach(m => { console[m] = (...args: unknown[]) => { calls.push(`${m}: ${args.join(' ')}`); }; });
	try {
		const garbage = path.join(fakeHome, '.claude', 'projects', '-x', 'not-a-session.jsonl');
		fs.mkdirSync(path.dirname(garbage), { recursive: true });
		fs.writeFileSync(garbage, '{not json\n\u0000\u0001');
		await lib.analyzeSessionFile(garbage);
		await lib.analyzeSessionFile(path.join(fakeHome, 'missing.jsonl'));
		await lib.analyzeSessionFiles([fakeHome, garbage]);
	} finally {
		methods.forEach((m, i) => { console[m] = originals[i]; });
	}
	assert.deepEqual(calls, []);
});
