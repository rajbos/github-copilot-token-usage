import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SqlJsDbCacheBase, SqlJsFileDbCacheBase, type SqlDatabase, type SqlJsStatic } from '../utils/sqlJsDbCache';

/** Exposes the protected state of the base class so the lifecycle can be asserted directly. */
class Harness extends SqlJsDbCacheBase {
	setCache(db: SqlDatabase, dbPath: string): void {
		this._dbCache = { db, mtimeMs: 1, size: 1, path: dbPath, walMtimeMs: 0, walSize: 0 };
	}
	setPending(db: SqlDatabase): void { this._pendingTransientDb = db; }
	get cache() { return this._dbCache; }
	get pending() { return this._pendingTransientDb; }
	get inflight() { return this._dbCacheInflight; }
	cachedFor(dbPath: string) { return this.getCachedDbForPath(dbPath); }
	missing(error: unknown) { return this.isMissingFileError(error); }
	close(db: SqlDatabase) { this.closeDb(db); }
}

function fakeDb(onClose: () => void = () => { /* noop */ }): SqlDatabase {
	return { close: onClose } as unknown as SqlDatabase;
}

test('getCachedDbForPath returns the cached db only for the matching path', () => {
	const h = new Harness();
	const db = fakeDb();
	assert.equal(h.cachedFor('/a/db'), null);
	h.setCache(db, '/a/db');
	assert.equal(h.cachedFor('/a/db'), db);
	assert.equal(h.cachedFor('/b/db'), null);
});

test('dispose closes the cached and pending databases and clears in-flight state', () => {
	const h = new Harness();
	let closed = 0;
	h.setCache(fakeDb(() => { closed++; }), '/a/db');
	h.setPending(fakeDb(() => { closed++; }));
	h.inflight.set('/a/db', Promise.resolve(null));

	h.dispose();

	assert.equal(closed, 2);
	assert.equal(h.cache, null);
	assert.equal(h.pending, null);
	assert.equal(h.inflight.size, 0);
});

test('dispose is safe to call twice and when nothing was opened', () => {
	const h = new Harness();
	h.dispose();
	h.dispose();
	assert.equal(h.cache, null);
});

test('closeDb swallows errors thrown by db.close()', () => {
	const h = new Harness();
	assert.doesNotThrow(() => h.close(fakeDb(() => { throw new Error('already closed'); })));
});

test('isMissingFileError matches ENOENT and ENOTDIR only', () => {
	const h = new Harness();
	assert.equal(h.missing({ code: 'ENOENT' }), true);
	assert.equal(h.missing({ code: 'ENOTDIR' }), true);
	assert.equal(h.missing({ code: 'EACCES' }), false);
	assert.equal(h.missing(new Error('boom')), false);
	assert.equal(h.missing(undefined), false);
});

test('initSqlJs shares one load between concurrent callers and returns the cached module afterwards', async () => {
	const h = new Harness();
	const [a, b] = await Promise.all([h.initSqlJs(), h.initSqlJs()]);
	assert.equal(a, b);
	assert.equal(await h.initSqlJs(), a);
	assert.equal(typeof a.Database, 'function');
});

// ── SqlJsFileDbCacheBase ─────────────────────────────────────────────────

class FileHarness extends SqlJsFileDbCacheBase {
	opened: Array<{ closed: boolean; db: SqlDatabase }> = [];
	factoryCalls = 0;
	failFactory = false;
	protected override createSqlJs(): Promise<SqlJsStatic> {
		this.factoryCalls++;
		if (this.failFactory) { return Promise.reject(new Error('wasm failed')); }
		const self = this;
		return Promise.resolve({
			Database: function () {
				const rec = { closed: false, db: undefined as unknown as SqlDatabase };
				rec.db = { close: () => { rec.closed = true; } } as unknown as SqlDatabase;
				self.opened.push(rec);
				return rec.db;
			},
		} as unknown as SqlJsStatic);
	}
	open(p: string) { return this.getDb(p); }
	get cache() { return this._dbCache; }
	get inflight() { return this._dbCacheInflight; }
	rows(r: Parameters<SqlJsFileDbCacheBase['rowsToObjects']>[0]) { return this.rowsToObjects(r); }
}

function tempDbFile(content = 'x'): { dir: string; file: string } {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqljs-file-cache-'));
	const file = path.join(dir, 'a.db');
	fs.writeFileSync(file, content);
	return { dir, file };
}

test('file cache: reuses the Database while mtime/size are unchanged, reopens (and closes the old one) on change', async () => {
	const { dir, file } = tempDbFile('one');
	try {
		const h = new FileHarness();
		const first = await h.open(file);
		assert.equal(await h.open(file), first);
		assert.equal(h.opened.length, 1);
		fs.writeFileSync(file, 'longer content');
		const second = await h.open(file);
		assert.notEqual(second, first);
		assert.equal(h.opened.length, 2);
		assert.equal(h.opened[0].closed, true);
		assert.equal(h.opened[1].closed, false);
	} finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('file cache: concurrent opens share one in-flight load and clear it afterwards', async () => {
	const { dir, file } = tempDbFile();
	try {
		const h = new FileHarness();
		const [a, b] = await Promise.all([h.open(file), h.open(file)]);
		assert.equal(a, b);
		assert.equal(h.opened.length, 1);
		assert.equal(h.inflight.size, 0);
	} finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('file cache: missing file returns null, and evicts + closes a previously cached db', async () => {
	const { dir, file } = tempDbFile();
	try {
		const h = new FileHarness();
		assert.equal(await h.open(path.join(dir, 'nope.db')), null);
		await h.open(file);
		fs.rmSync(file);
		assert.equal(await h.open(file), null);
		assert.equal(h.cache.has(file), false);
		assert.equal(h.opened[0].closed, true);
	} finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('file cache: sql.js init failure yields null, is retried, and the module is cached once it works', async () => {
	const { dir, file } = tempDbFile();
	try {
		const h = new FileHarness();
		h.failFactory = true;
		assert.equal(await h.open(file), null);
		await assert.rejects(h.initSqlJs());
		h.failFactory = false;
		assert.notEqual(await h.open(file), null);
		await h.initSqlJs();
		assert.equal(h.factoryCalls, 3);
	} finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('file cache: dispose closes every cached db and clears state', async () => {
	const a = tempDbFile(); const b = tempDbFile();
	try {
		const h = new FileHarness();
		await h.open(a.file); await h.open(b.file);
		h.dispose();
		assert.equal(h.opened.every(o => o.closed), true);
		assert.equal(h.cache.size, 0);
	} finally { fs.rmSync(a.dir, { recursive: true, force: true }); fs.rmSync(b.dir, { recursive: true, force: true }); }
});

test('file cache: rowsToObjects maps columns to keys and handles empty results', () => {
	const h = new FileHarness();
	assert.deepEqual(h.rows([]), []);
	assert.deepEqual(h.rows([{ columns: ['id', 'n'], values: [['a', 1], ['b', 2]] }]), [{ id: 'a', n: 1 }, { id: 'b', n: 2 }]);
});
