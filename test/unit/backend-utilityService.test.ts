import test from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import { BackendUtility } from '../../src/backend/services/utilityService';

// ── sanitizeTableKey ─────────────────────────────────────────────────────

test('sanitizeTableKey replaces forbidden characters', () => {
	assert.equal(BackendUtility.sanitizeTableKey('a/b\\c#d?e'), 'a_b_c_d_e');
});

test('sanitizeTableKey leaves safe characters unchanged', () => {
	assert.equal(BackendUtility.sanitizeTableKey('hello-world_123'), 'hello-world_123');
});

test('sanitizeTableKey handles empty string', () => {
	assert.equal(BackendUtility.sanitizeTableKey(''), '');
});

// ── toUtcDayKey ──────────────────────────────────────────────────────────

test('toUtcDayKey converts Date to YYYY-MM-DD', () => {
	assert.equal(BackendUtility.toUtcDayKey(new Date('2024-06-15T12:00:00Z')), '2024-06-15');
	assert.equal(BackendUtility.toUtcDayKey(new Date('2024-01-01T00:00:00Z')), '2024-01-01');
});

test('toUtcDayKey throws for invalid date', () => {
	assert.throws(() => BackendUtility.toUtcDayKey(new Date('invalid')), /Invalid date/);
});

// ── isValidDayKey ────────────────────────────────────────────────────────

test('isValidDayKey accepts valid dates', () => {
	assert.equal(BackendUtility.isValidDayKey('2024-06-15'), true);
	assert.equal(BackendUtility.isValidDayKey('2024-01-01'), true);
	assert.equal(BackendUtility.isValidDayKey('2024-12-31'), true);
});

test('isValidDayKey rejects invalid dates', () => {
	assert.equal(BackendUtility.isValidDayKey(''), false);
	assert.equal(BackendUtility.isValidDayKey('not-a-date'), false);
	assert.equal(BackendUtility.isValidDayKey('2024-13-01'), false);  // month 13
	assert.equal(BackendUtility.isValidDayKey('2024-02-30'), false);  // invalid day
	assert.equal(BackendUtility.isValidDayKey('2024/06/15'), false);  // wrong format
});

test('isValidDayKey rejects non-string input', () => {
	assert.equal(BackendUtility.isValidDayKey(null as any), false);
	assert.equal(BackendUtility.isValidDayKey(undefined as any), false);
	assert.equal(BackendUtility.isValidDayKey(123 as any), false);
});

// ── validateDayKey ───────────────────────────────────────────────────────

test('validateDayKey returns dayKey for valid input', () => {
	assert.equal(BackendUtility.validateDayKey('2024-06-15'), '2024-06-15');
});

test('validateDayKey returns undefined for invalid input', () => {
	assert.equal(BackendUtility.validateDayKey('invalid'), undefined);
	assert.equal(BackendUtility.validateDayKey(123), undefined);
	assert.equal(BackendUtility.validateDayKey(null), undefined);
});

// ── addDaysUtc ───────────────────────────────────────────────────────────

test('addDaysUtc adds days correctly', () => {
	assert.equal(BackendUtility.addDaysUtc('2024-06-15', 1), '2024-06-16');
	assert.equal(BackendUtility.addDaysUtc('2024-06-15', 7), '2024-06-22');
	assert.equal(BackendUtility.addDaysUtc('2024-06-30', 1), '2024-07-01');  // month boundary
	assert.equal(BackendUtility.addDaysUtc('2024-12-31', 1), '2025-01-01');  // year boundary
});

test('addDaysUtc subtracts days with negative value', () => {
	assert.equal(BackendUtility.addDaysUtc('2024-06-15', -1), '2024-06-14');
	assert.equal(BackendUtility.addDaysUtc('2024-01-01', -1), '2023-12-31');
});

// ── getDayKeysInclusive ──────────────────────────────────────────────────

test('getDayKeysInclusive returns single day for same start and end', () => {
	const result = BackendUtility.getDayKeysInclusive('2024-06-15', '2024-06-15');
	assert.deepEqual(result, ['2024-06-15']);
});

test('getDayKeysInclusive returns inclusive range', () => {
	const result = BackendUtility.getDayKeysInclusive('2024-06-14', '2024-06-16');
	assert.deepEqual(result, ['2024-06-14', '2024-06-15', '2024-06-16']);
});

test('getDayKeysInclusive throws for start after end', () => {
	assert.throws(() => BackendUtility.getDayKeysInclusive('2024-06-16', '2024-06-14'), /Invalid date range/);
});

test('getDayKeysInclusive throws for invalid date format', () => {
	assert.throws(() => BackendUtility.getDayKeysInclusive('invalid', '2024-06-15'), /Invalid startDayKey/);
	assert.throws(() => BackendUtility.getDayKeysInclusive('2024-06-15', 'invalid'), /Invalid endDayKey/);
});

test('getDayKeysInclusive throws for too large range', () => {
	assert.throws(() => BackendUtility.getDayKeysInclusive('2020-01-01', '2024-06-15'), /too large/);
});

// ── normalizeTimestampToMs ───────────────────────────────────────────────

test('normalizeTimestampToMs handles epoch-seconds', () => {
	const result = BackendUtility.normalizeTimestampToMs(1718000000);
	assert.equal(result, 1718000000000);  // converted to ms
});

test('normalizeTimestampToMs handles epoch-milliseconds', () => {
	const result = BackendUtility.normalizeTimestampToMs(1718000000000);
	assert.equal(result, 1718000000000);  // already ms
});

test('normalizeTimestampToMs handles ISO string', () => {
	const result = BackendUtility.normalizeTimestampToMs('2024-06-10T00:00:00Z');
	assert.ok(result);
	assert.equal(typeof result, 'number');
});

test('normalizeTimestampToMs handles string numbers', () => {
	const result = BackendUtility.normalizeTimestampToMs('1718000000');
	assert.equal(result, 1718000000000);
});

test('normalizeTimestampToMs returns undefined for non-date strings', () => {
	assert.equal(BackendUtility.normalizeTimestampToMs('not-a-date'), undefined);
});

test('normalizeTimestampToMs returns undefined for non-numeric values', () => {
	assert.equal(BackendUtility.normalizeTimestampToMs(null), undefined);
	assert.equal(BackendUtility.normalizeTimestampToMs(undefined), undefined);
	assert.equal(BackendUtility.normalizeTimestampToMs({}), undefined);
	assert.equal(BackendUtility.normalizeTimestampToMs(NaN), undefined);
});

// ── stripHostnameDomain ──────────────────────────────────────────────────

test('stripHostnameDomain strips domain suffix', () => {
	assert.equal(BackendUtility.stripHostnameDomain('myhost.local'), 'myhost');
	assert.equal(BackendUtility.stripHostnameDomain('server.corp.company.com'), 'server');
});

test('stripHostnameDomain returns hostname when no domain', () => {
	assert.equal(BackendUtility.stripHostnameDomain('myhost'), 'myhost');
});

test('stripHostnameDomain handles empty/null input', () => {
	assert.equal(BackendUtility.stripHostnameDomain(''), '');
	assert.equal(BackendUtility.stripHostnameDomain(null as any), '');
	assert.equal(BackendUtility.stripHostnameDomain('  '), '');
});

// ── normalizeNameForStorage ──────────────────────────────────────────────

test('normalizeNameForStorage trims and returns name', () => {
	assert.equal(BackendUtility.normalizeNameForStorage('  hello  '), 'hello');
});

test('normalizeNameForStorage returns undefined for empty/null', () => {
	assert.equal(BackendUtility.normalizeNameForStorage(''), undefined);
	assert.equal(BackendUtility.normalizeNameForStorage(undefined), undefined);
	assert.equal(BackendUtility.normalizeNameForStorage('   '), undefined);
	assert.equal(BackendUtility.normalizeNameForStorage(null as any), undefined);
});

test('normalizeNameForStorage truncates long names', () => {
	const longName = 'a'.repeat(100);
	const result = BackendUtility.normalizeNameForStorage(longName);
	assert.equal(result?.length, 64);
});

test('normalizeNameForStorage keeps names under limit', () => {
	const name = 'short-name';
	assert.equal(BackendUtility.normalizeNameForStorage(name), name);
});

// ── extractWorkspaceIdFromSessionPath ────────────────────────────────────

test('extractWorkspaceIdFromSessionPath extracts workspace ID', () => {
	assert.equal(
		BackendUtility.extractWorkspaceIdFromSessionPath('/home/user/.config/Code/User/workspaceStorage/abc123/chatSessions/s1.json'),
		'abc123'
	);
});

test('extractWorkspaceIdFromSessionPath returns emptyWindow for globalStorage', () => {
	assert.equal(
		BackendUtility.extractWorkspaceIdFromSessionPath('/home/user/.config/Code/User/globalStorage/emptyWindowChatSessions/s1.json'),
		'emptyWindow'
	);
});

test('extractWorkspaceIdFromSessionPath returns copilot-chat for copilot-chat globalStorage', () => {
	assert.equal(
		BackendUtility.extractWorkspaceIdFromSessionPath('/home/user/.config/Code/User/globalStorage/github.copilot-chat/s1.json'),
		'copilot-chat'
	);
});

test('extractWorkspaceIdFromSessionPath returns copilot-cli for CLI sessions', () => {
	assert.equal(
		BackendUtility.extractWorkspaceIdFromSessionPath('/home/user/.copilot/session-state/s1.jsonl'),
		'copilot-cli'
	);
});

test('extractWorkspaceIdFromSessionPath returns unknown for unrecognized paths', () => {
	assert.equal(BackendUtility.extractWorkspaceIdFromSessionPath('/tmp/random/file.json'), 'unknown');
});

test('extractWorkspaceIdFromSessionPath handles Windows-style backslashes', () => {
	assert.equal(
		BackendUtility.extractWorkspaceIdFromSessionPath('C:\\Users\\user\\AppData\\Roaming\\Code\\User\\workspaceStorage\\abc123\\chatSessions\\s1.json'),
		'abc123'
	);
});

// ── tryResolveWorkspaceNameFromSessionPath ────────────────────────────────

test('tryResolveWorkspaceNameFromSessionPath returns undefined for non-workspaceStorage paths', async () => {
	const result = await BackendUtility.tryResolveWorkspaceNameFromSessionPath('/tmp/random/file.json');
	assert.equal(result, undefined);
});

test('tryResolveWorkspaceNameFromSessionPath resolves name from workspace.json with file:// URI', async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'util-ws-'));
	const wsDir = path.join(dir, 'workspaceStorage', 'ws-id-123', 'chatSessions');
	const metaDir = path.join(dir, 'workspaceStorage', 'ws-id-123');
	fs.mkdirSync(wsDir, { recursive: true });
	fs.writeFileSync(path.join(metaDir, 'workspace.json'), JSON.stringify({ folder: 'file:///home/user/my-project' }));
	const sessionFile = path.join(wsDir, 'session.json');
	fs.writeFileSync(sessionFile, '{}');
	try {
		const result = await BackendUtility.tryResolveWorkspaceNameFromSessionPath(sessionFile);
		assert.equal(result, 'my-project');
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test('tryResolveWorkspaceNameFromSessionPath resolves from meta.json if workspace.json is absent', async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'util-meta-'));
	const wsDir = path.join(dir, 'workspaceStorage', 'ws-id-456', 'chatSessions');
	const metaDir = path.join(dir, 'workspaceStorage', 'ws-id-456');
	fs.mkdirSync(wsDir, { recursive: true });
	fs.writeFileSync(path.join(metaDir, 'meta.json'), JSON.stringify({ folder: 'file:///home/user/another-project' }));
	const sessionFile = path.join(wsDir, 'session.json');
	fs.writeFileSync(sessionFile, '{}');
	try {
		const result = await BackendUtility.tryResolveWorkspaceNameFromSessionPath(sessionFile);
		assert.equal(result, 'another-project');
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test('tryResolveWorkspaceNameFromSessionPath strips .code-workspace extension', async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'util-codews-'));
	const wsDir = path.join(dir, 'workspaceStorage', 'ws-id-789', 'chatSessions');
	const metaDir = path.join(dir, 'workspaceStorage', 'ws-id-789');
	fs.mkdirSync(wsDir, { recursive: true });
	fs.writeFileSync(path.join(metaDir, 'workspace.json'), JSON.stringify({ workspace: 'file:///home/user/mywork.code-workspace' }));
	const sessionFile = path.join(wsDir, 'session.json');
	fs.writeFileSync(sessionFile, '{}');
	try {
		const result = await BackendUtility.tryResolveWorkspaceNameFromSessionPath(sessionFile);
		assert.equal(result, 'mywork');
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test('tryResolveWorkspaceNameFromSessionPath returns undefined when no metadata files exist', async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'util-nows-'));
	const wsDir = path.join(dir, 'workspaceStorage', 'ws-id-000', 'chatSessions');
	fs.mkdirSync(wsDir, { recursive: true });
	const sessionFile = path.join(wsDir, 'session.json');
	fs.writeFileSync(sessionFile, '{}');
	try {
		const result = await BackendUtility.tryResolveWorkspaceNameFromSessionPath(sessionFile);
		assert.equal(result, undefined);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test('tryResolveWorkspaceNameFromSessionPath handles plain path (non-URI)', async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'util-plain-'));
	const wsDir = path.join(dir, 'workspaceStorage', 'ws-id-plain', 'chatSessions');
	const metaDir = path.join(dir, 'workspaceStorage', 'ws-id-plain');
	fs.mkdirSync(wsDir, { recursive: true });
	fs.writeFileSync(path.join(metaDir, 'workspace.json'), JSON.stringify({ folder: '/home/user/plain-project' }));
	const sessionFile = path.join(wsDir, 'session.json');
	fs.writeFileSync(sessionFile, '{}');
	try {
		const result = await BackendUtility.tryResolveWorkspaceNameFromSessionPath(sessionFile);
		assert.equal(result, 'plain-project');
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
