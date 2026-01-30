import test from 'node:test';
import * as assert from 'node:assert/strict';

import {
	derivePseudonymousUserKey,
	resolveUserIdentityForSync,
	tryParseJwtClaims,
	validateTeamAlias
} from '../backend/identity';

import {
	buildAggPartitionKey,
	buildOdataEqFilter,
	createDailyAggEntity,
	listAggDailyEntitiesFromTableClient,
	sanitizeTableKey,
	stableDailyRollupRowKey
} from '../backend/storageTables';

import {
	aggregateByDimension,
	dailyRollupMapKey,
	filterByDimension,
	isoWeekKeyFromUtcDayKey,
	upsertDailyRollup
} from '../backend/rollups';

test('validateTeamAlias accepts lowercase/digits/dash only', () => {
	assert.deepStrictEqual(validateTeamAlias('alice-01'), { valid: true, alias: 'alice-01' });
	assert.equal(validateTeamAlias('Alice-01').valid, false);
	assert.equal(validateTeamAlias('alice@example.com').valid, false);
	assert.equal(validateTeamAlias('alice bob').valid, false);
	assert.equal(validateTeamAlias('').valid, false);
	assert.equal(validateTeamAlias('a'.repeat(33)).valid, false);
	assert.equal(validateTeamAlias('alice_01').valid, false);
});

test('validateTeamAlias rejects common name patterns (CR-015)', () => {
	// Test rejection of common names
	const invalidNames = ['john', 'jane', 'smith', 'doe', 'admin', 'user', 'dev', 'test', 'demo'];
	for (const name of invalidNames) {
		const result = validateTeamAlias(name);
		assert.equal(result.valid, false, `Should reject common name: ${name}`);
		if (!result.valid) {
			assert.ok(result.error.includes('looks like a real name'), `Error message should mention real name for: ${name}`);
		}
	}
	
	// Test rejection with compound names
	assert.equal(validateTeamAlias('john-smith').valid, false);
	assert.equal(validateTeamAlias('test-user').valid, false);
	assert.equal(validateTeamAlias('admin-dev').valid, false);
	
	// Test case-insensitive matching
	assert.equal(validateTeamAlias('admin').valid, false);
	assert.equal(validateTeamAlias('john').valid, false);
	
	// Test that valid non-common names still pass
	assert.deepStrictEqual(validateTeamAlias('alice-01'), { valid: true, alias: 'alice-01' });
	assert.deepStrictEqual(validateTeamAlias('bob-team-x'), { valid: true, alias: 'bob-team-x' });
	assert.deepStrictEqual(validateTeamAlias('charlie-99'), { valid: true, alias: 'charlie-99' });
});

test('derivePseudonymousUserKey is stable and dataset-scoped', () => {
	const a = derivePseudonymousUserKey({ tenantId: 't', objectId: 'o', datasetId: 'd1' });
	const b = derivePseudonymousUserKey({ tenantId: 't', objectId: 'o', datasetId: 'd1' });
	const c = derivePseudonymousUserKey({ tenantId: 't', objectId: 'o', datasetId: 'd2' });
	assert.equal(a, b);
	assert.notEqual(a, c);
	assert.equal(a.length, 16);
});

test('tryParseJwtClaims returns tid/oid when present', () => {
	// Header/payload/signature with base64url payload {"tid":"t","oid":"o"}
	const token = 'e30.eyJ0aWQiOiJ0Iiwib2lkIjoibyJ9.sig';
	assert.deepStrictEqual(tryParseJwtClaims(token), { tenantId: 't', objectId: 'o' });
});

test('tryParseJwtClaims returns empty for invalid tokens', () => {
	assert.deepStrictEqual(tryParseJwtClaims(''), {});
	assert.deepStrictEqual(tryParseJwtClaims('not-a-jwt'), {});
	assert.deepStrictEqual(tryParseJwtClaims('a..b'), {});
});

test('resolveUserIdentityForSync gates on shareWithTeam', () => {
	const r = resolveUserIdentityForSync({
		shareWithTeam: false,
		userIdentityMode: 'teamAlias',
		configuredUserId: 'alice-01',
		datasetId: 'default'
	});
	assert.equal('userId' in r, false);
});

test('resolveUserIdentityForSync teamAlias validates and returns alias', () => {
	const r = resolveUserIdentityForSync({
		shareWithTeam: true,
		userIdentityMode: 'teamAlias',
		configuredUserId: 'alice-01',
		datasetId: 'default'
	});
	assert.deepStrictEqual(r, { userId: 'alice-01', userKeyType: 'teamAlias' });
});

test('resolveUserIdentityForSync teamAlias invalid returns no identity', () => {
	const r = resolveUserIdentityForSync({
		shareWithTeam: true,
		userIdentityMode: 'teamAlias',
		configuredUserId: 'Alice@Example.com',
		datasetId: 'default'
	});
	assert.equal('userId' in r, false);
});

test('resolveUserIdentityForSync pseudonymous derives from claims token', () => {
	const token = 'e30.eyJ0aWQiOiJ0Iiwib2lkIjoibyJ9.sig';
	const r = resolveUserIdentityForSync({
		shareWithTeam: true,
		userIdentityMode: 'pseudonymous',
		configuredUserId: '',
		datasetId: 'default',
		accessTokenForClaims: token
	});
	assert.equal(typeof (r as any).userId, 'string');
	assert.equal((r as any).userKeyType, 'pseudonymous');
});

test('resolveUserIdentityForSync pseudonymous changes with dataset and omits raw object id', () => {
	const token = 'e30.eyJ0aWQiOiJ0ZW5hbnQtb25lIiwib2lkIjoiMDAwMDAwMDAtMDAwMC0wMDAwLTAwMDAtMDAwMDAwMDAwMDAwIn0.sig';
	const first = resolveUserIdentityForSync({
		shareWithTeam: true,
		userIdentityMode: 'pseudonymous',
		configuredUserId: '',
		datasetId: 'dataset-a',
		accessTokenForClaims: token
	});
	const second = resolveUserIdentityForSync({
		shareWithTeam: true,
		userIdentityMode: 'pseudonymous',
		configuredUserId: '',
		datasetId: 'dataset-b',
		accessTokenForClaims: token
	});
	assert.equal((first as any).userKeyType, 'pseudonymous');
	assert.equal((second as any).userKeyType, 'pseudonymous');
	assert.ok((first as any).userId);
	assert.equal((first as any).userId.length, 16);
	assert.notEqual((first as any).userId, '00000000-0000-0000-0000-000000000000');
	assert.notEqual((first as any).userId, (second as any).userId);
});

test('resolveUserIdentityForSync pseudonymous without claims returns no identity', () => {
	const r = resolveUserIdentityForSync({
		shareWithTeam: true,
		userIdentityMode: 'pseudonymous',
		configuredUserId: '',
		datasetId: 'default',
		accessTokenForClaims: 'e30.e30.sig'
	});
	assert.equal('userId' in r, false);
});

test('resolveUserIdentityForSync entraObjectId requires GUID', () => {
	const ok = resolveUserIdentityForSync({
		shareWithTeam: true,
		userIdentityMode: 'entraObjectId',
		configuredUserId: '00000000-0000-0000-0000-000000000000',
		datasetId: 'default'
	});
	assert.deepStrictEqual(ok, { userId: '00000000-0000-0000-0000-000000000000', userKeyType: 'entraObjectId' });

	const bad = resolveUserIdentityForSync({
		shareWithTeam: true,
		userIdentityMode: 'entraObjectId',
		configuredUserId: 'not-a-guid',
		datasetId: 'default'
	});
	assert.equal('userId' in bad, false);
});

test('createDailyAggEntity emits schema v3 consent metadata when shareWithTeam true', () => {
	const entity = createDailyAggEntity({
		datasetId: 'default',
		day: '2026-01-16',
		model: 'gpt-4o',
		workspaceId: 'w',
		machineId: 'm',
		userId: 'alice-01',
		userKeyType: 'teamAlias',
		shareWithTeam: true,
		consentAt: '2026-01-16T00:00:00Z',
		inputTokens: 1,
		outputTokens: 2,
		interactions: 1
	});
	assert.equal(entity.schemaVersion, 3);
	assert.equal(entity.userKeyType, 'teamAlias');
	assert.equal(entity.shareWithTeam, true);
	assert.equal(entity.consentAt, '2026-01-16T00:00:00Z');
});

test('createDailyAggEntity schema versions: v1 no user, v2 user without consent', () => {
	const v1 = createDailyAggEntity({
		datasetId: 'default',
		day: '2026-01-16',
		model: 'gpt-4o',
		workspaceId: 'w',
		machineId: 'm',
		inputTokens: 1,
		outputTokens: 1,
		interactions: 1
	});
	assert.equal(v1.schemaVersion, 1);
	assert.equal('userId' in v1, false);

	const v2 = createDailyAggEntity({
		datasetId: 'default',
		day: '2026-01-16',
		model: 'gpt-4o',
		workspaceId: 'w',
		machineId: 'm',
		userId: 'alice-01',
		shareWithTeam: false,
		inputTokens: 1,
		outputTokens: 1,
		interactions: 1
	});
	assert.equal(v2.schemaVersion, 2);
	assert.equal(v2.userId, 'alice-01');
	assert.equal('shareWithTeam' in v2, false);
});

test('storageTables key helpers sanitize and build stable keys', () => {
	assert.equal(sanitizeTableKey(''), '');
	assert.equal(sanitizeTableKey('a/b\\c#d?e'), 'a_b_c_d_e');
	assert.equal(sanitizeTableKey('a\u0000b'), 'a_b');

	const pk = buildAggPartitionKey('default', '2026-01-16');
	assert.equal(pk, 'ds:default|d:2026-01-16');

	const rk1 = stableDailyRollupRowKey({ day: '2026-01-16', model: 'm', workspaceId: 'w', machineId: 'mc' });
	const rk2 = stableDailyRollupRowKey({ day: '2026-01-16', model: 'm', workspaceId: 'w', machineId: 'mc', userId: 'alice-01' });
	assert.ok(rk1.includes('m:m'));
	assert.ok(rk1.includes('w:w'));
	assert.ok(rk1.includes('mc:mc'));
	assert.ok(!rk1.includes('u:'));
	assert.ok(rk2.includes('u:alice-01'));

	// Test OData filter with allowed field (CR-001 fix validates field names)
	assert.equal(buildOdataEqFilter('PartitionKey', "a'b"), "PartitionKey eq 'a''b'");
	
	// Test that invalid fields are rejected
	assert.throws(() => buildOdataEqFilter('InvalidField', 'value'), /Invalid filter field/);
});

test('listAggDailyEntitiesFromTableClient normalizes and filters entities', async () => {
	const tableClient = {
		async *listEntities() {
			yield { partitionKey: 'p', rowKey: 'r', schemaVersion: 2, datasetId: 'd', day: '2026-01-16', model: 'm', workspaceId: 'w', machineId: 'mc', inputTokens: 1, outputTokens: 2, interactions: 1 };
			yield { partitionKey: 'p', rowKey: 'r3', schemaVersion: 'not-a-number', datasetId: 'd', model: 'm2', workspaceId: 'w', machineId: 'mc', inputTokens: '1', outputTokens: null, interactions: '0' };
			yield { partitionKey: 'p', rowKey: 'r2', schemaVersion: 1, datasetId: 'd', day: '2026-01-16', model: '', workspaceId: 'w', machineId: 'mc', inputTokens: 0, outputTokens: 0, interactions: 0 };
		}
	};
	const results = await listAggDailyEntitiesFromTableClient({ tableClient: tableClient as any, partitionKey: 'p', defaultDayKey: '2026-01-16' });
	assert.equal(results.length, 2);
	assert.equal(results[0].model, 'm');
	assert.equal(results[1].schemaVersion, undefined);
	assert.equal(results[1].day, '2026-01-16');
	assert.equal(results[1].inputTokens, 0);
	assert.equal(results[1].outputTokens, 0);
	assert.equal(results[1].interactions, 0);
});

test('listAggDailyEntitiesFromTableClient handles errors gracefully', async () => {
	const tableClient = {
		async *listEntities() {
			throw new Error('boom');
		}
	};
	const results = await listAggDailyEntitiesFromTableClient({
		tableClient: tableClient as any,
		partitionKey: 'p',
		defaultDayKey: '2026-01-16',
		logger: { error: () => {} }
	});
	assert.deepStrictEqual(results, []);
});

test('rollups helpers aggregate and build stable map keys', () => {
	const key = { day: '2026-01-16', model: 'm', workspaceId: 'w', machineId: 'mc', userId: 'alice-01' };
	assert.ok(dailyRollupMapKey(key).includes('alice-01'));

	const map = new Map<string, any>();
	upsertDailyRollup(map, key as any, { inputTokens: 1, outputTokens: 2, interactions: 1 });
	upsertDailyRollup(map, key as any, { inputTokens: 3, outputTokens: 4, interactions: 1 });
	assert.equal(map.size, 1);
	const entry = Array.from(map.values())[0];
	assert.deepStrictEqual(entry.value, { inputTokens: 4, outputTokens: 6, interactions: 2 });

	const rollups = [
		{ key, value: entry.value },
		{ key: { ...key, userId: undefined as any }, value: { inputTokens: 1, outputTokens: 1, interactions: 1 } }
	];
	const byModel = aggregateByDimension(rollups as any, 'model');
	// Existing-branch: aggregate two entries with same model.
	assert.deepStrictEqual(byModel.get('m'), { inputTokens: 5, outputTokens: 7, interactions: 3 });

	const byUser = aggregateByDimension(rollups as any, 'userId');
	assert.ok(byUser.has('unknown'));

	const filteredYes = filterByDimension(rollups as any, 'model', 'm');
	assert.equal(filteredYes.length, 2);
	const filteredNo = filterByDimension(rollups as any, 'model', 'nope');
	assert.equal(filteredNo.length, 0);

	assert.equal(isoWeekKeyFromUtcDayKey('2026-01-16').startsWith('2026-W'), true);
});
