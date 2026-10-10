import test from 'node:test';
import assert from 'node:assert/strict';
import { SqlJsDbCacheBase, type SqlDatabase } from '../../../src/utils/sqlJsDbCache';

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
