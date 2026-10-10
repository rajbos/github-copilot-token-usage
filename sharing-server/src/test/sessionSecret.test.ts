/**
 * Production must never sign session cookies with a missing, default or short secret:
 * admin status is looked up from the cookie's `sub`, so a guessable secret is a forgeable
 * admin session. Uses an isolated temp SQLite dir; no GitHub access is involved.
 */
import { test, describe, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../app.js';
import { startServer } from '../lifecycle.js';
import { closeDb } from '../db.js';
import {
	DEV_SESSION_SECRET, assertSessionSecretConfigured, decodeSession, encodeSession, makeClaims,
} from '../session.js';

const KEYS = ['NODE_ENV', 'SESSION_SECRET', 'LOCAL_DATA_DIR'] as const;
const GOOD_SECRET = 'a'.repeat(32);

describe('SESSION_SECRET enforcement', () => {
	const saved: Record<string, string | undefined> = {};
	let dataDir: string;

	before(() => { dataDir = mkdtempSync(join(tmpdir(), 'sharing-secret-')); });
	after(() => { closeDb(); rmSync(dataDir, { recursive: true, force: true }); });
	beforeEach(() => {
		for (const k of KEYS) saved[k] = process.env[k];
		process.env.LOCAL_DATA_DIR = dataDir;
		delete process.env.SESSION_SECRET;
	});
	afterEach(() => {
		for (const k of KEYS) {
			if (saved[k] === undefined) delete process.env[k];
			else process.env[k] = saved[k];
		}
	});

	const rejections: Array<[string, string | undefined, RegExp]> = [
		['missing', undefined, /not set/],
		['empty', '', /not set/],
		['the dev default', DEV_SESSION_SECRET, /development default/],
		['shorter than 32 characters', 'a'.repeat(31), /shorter than 32/],
	];

	for (const [label, value, pattern] of rejections) {
		test(`production with a ${label} secret throws from startServer before listening`, async () => {
			process.env.NODE_ENV = 'production';
			if (value !== undefined) process.env.SESSION_SECRET = value;
			await assert.rejects(startServer(createAppUnchecked(), { port: 0, backupIntervalMs: 0 }), pattern);
		});

		test(`production with a ${label} secret throws from createApp`, () => {
			process.env.NODE_ENV = 'production';
			if (value !== undefined) process.env.SESSION_SECRET = value;
			assert.throws(() => createApp(), pattern);
		});

		test(`production with a ${label} secret refuses to sign or verify cookies`, () => {
			process.env.NODE_ENV = 'production';
			if (value !== undefined) process.env.SESSION_SECRET = value;
			assert.throws(() => encodeSession(makeClaims(1)), pattern);
			assert.throws(() => decodeSession('x.y'), pattern);
		});
	}

	test('production with a valid secret is accepted and cookies round-trip', async () => {
		process.env.NODE_ENV = 'production';
		process.env.SESSION_SECRET = GOOD_SECRET;
		assert.doesNotThrow(() => assertSessionSecretConfigured());
		const app = createApp();
		assert.equal((await app.request('/health')).status, 200);
		assert.equal(decodeSession(encodeSession(makeClaims(7)))?.sub, 7);
	});

	test('a cookie signed with the dev default is rejected in production', () => {
		delete process.env.NODE_ENV;
		const forged = encodeSession(makeClaims(1)); // signed with the dev fallback
		process.env.NODE_ENV = 'production';
		process.env.SESSION_SECRET = GOOD_SECRET;
		assert.equal(decodeSession(forged), null);
	});

	test('outside production the dev fallback still works and warns once', () => {
		delete process.env.NODE_ENV;
		const warnings: string[] = [];
		const original = console.warn;
		console.warn = (...args: unknown[]) => { warnings.push(args.join(' ')); };
		try {
			assert.doesNotThrow(() => createApp());
			assert.equal(decodeSession(encodeSession(makeClaims(3)))?.sub, 3);
			encodeSession(makeClaims(3));
		} finally {
			console.warn = original;
		}
		assert.ok(warnings.length <= 1, 'warning must be emitted at most once per process');
	});
});

/** A bare Hono app: startServer must throw before it ever touches it. */
function createAppUnchecked() {
	const saved = process.env.NODE_ENV;
	delete process.env.NODE_ENV;
	try { return createApp(); } finally { if (saved !== undefined) process.env.NODE_ENV = saved; }
}
