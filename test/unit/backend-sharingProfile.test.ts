import './vscode-shim-register';
import test from 'node:test';
import * as assert from 'node:assert/strict';

import {
	parseBackendSharingProfile,
	computeBackendSharingPolicy,
	hashWorkspaceIdForTeam,
	hashMachineIdForTeam,
	type BackendSharingProfile
} from '../backend/sharingProfile';

test('parseBackendSharingProfile validates profile values', () => {
	assert.equal(parseBackendSharingProfile('off'), 'off');
	assert.equal(parseBackendSharingProfile('soloFull'), 'soloFull');
	assert.equal(parseBackendSharingProfile('teamAnonymized'), 'teamAnonymized');
	assert.equal(parseBackendSharingProfile('teamPseudonymous'), 'teamPseudonymous');
	assert.equal(parseBackendSharingProfile('teamIdentified'), 'teamIdentified');
	assert.equal(parseBackendSharingProfile('invalid'), undefined);
	assert.equal(parseBackendSharingProfile(null), undefined);
	assert.equal(parseBackendSharingProfile(undefined), undefined);
});

test('computeBackendSharingPolicy: off profile disallows cloud sync', () => {
	const policy = computeBackendSharingPolicy({
		enabled: true,
		profile: 'off',
		shareWorkspaceMachineNames: false
	});

	assert.equal(policy.profile, 'off');
	assert.equal(policy.allowCloudSync, false);
	assert.equal(policy.includeUserDimension, false);
	assert.equal(policy.includeNames, false);
	assert.equal(policy.workspaceIdStrategy, 'raw');
	assert.equal(policy.machineIdStrategy, 'raw');
});

test('computeBackendSharingPolicy: soloFull allows raw IDs and names', () => {
	const policy = computeBackendSharingPolicy({
		enabled: true,
		profile: 'soloFull',
		shareWorkspaceMachineNames: true
	});

	assert.equal(policy.profile, 'soloFull');
	assert.equal(policy.allowCloudSync, true);
	assert.equal(policy.includeUserDimension, false);
	assert.equal(policy.includeNames, true);
	assert.equal(policy.workspaceIdStrategy, 'raw');
	assert.equal(policy.machineIdStrategy, 'raw');
});

test('computeBackendSharingPolicy: teamAnonymized hashes IDs, no user dimension, no names', () => {
	const policy = computeBackendSharingPolicy({
		enabled: true,
		profile: 'teamAnonymized',
		shareWorkspaceMachineNames: false
	});

	assert.equal(policy.profile, 'teamAnonymized');
	assert.equal(policy.allowCloudSync, true);
	assert.equal(policy.includeUserDimension, false);
	assert.equal(policy.includeNames, false);
	assert.equal(policy.workspaceIdStrategy, 'hashed');
	assert.equal(policy.machineIdStrategy, 'hashed');
});

test('computeBackendSharingPolicy: teamPseudonymous includes user dimension, hashes IDs', () => {
	const policy = computeBackendSharingPolicy({
		enabled: true,
		profile: 'teamPseudonymous',
		shareWorkspaceMachineNames: false
	});

	assert.equal(policy.profile, 'teamPseudonymous');
	assert.equal(policy.allowCloudSync, true);
	assert.equal(policy.includeUserDimension, true);
	assert.equal(policy.includeNames, false);
	assert.equal(policy.workspaceIdStrategy, 'hashed');
	assert.equal(policy.machineIdStrategy, 'hashed');
});

test('computeBackendSharingPolicy: teamIdentified includes user dimension, hashes IDs', () => {
	const policy = computeBackendSharingPolicy({
		enabled: true,
		profile: 'teamIdentified',
		shareWorkspaceMachineNames: false
	});

	assert.equal(policy.profile, 'teamIdentified');
	assert.equal(policy.allowCloudSync, true);
	assert.equal(policy.includeUserDimension, true);
	assert.equal(policy.includeNames, false);
	assert.equal(policy.workspaceIdStrategy, 'hashed');
	assert.equal(policy.machineIdStrategy, 'hashed');
});

test('computeBackendSharingPolicy: teamPseudonymous respects shareWorkspaceMachineNames', () => {
	const policyWithNames = computeBackendSharingPolicy({
		enabled: true,
		profile: 'teamPseudonymous',
		shareWorkspaceMachineNames: true
	});

	assert.equal(policyWithNames.includeNames, true);

	const policyWithoutNames = computeBackendSharingPolicy({
		enabled: true,
		profile: 'teamPseudonymous',
		shareWorkspaceMachineNames: false
	});

	assert.equal(policyWithoutNames.includeNames, false);
});

test('computeBackendSharingPolicy: enabled=false disallows cloud sync regardless of profile', () => {
	const policy = computeBackendSharingPolicy({
		enabled: false,
		profile: 'soloFull',
		shareWorkspaceMachineNames: true
	});

	assert.equal(policy.allowCloudSync, false);
});

test('hashWorkspaceIdForTeam produces stable hashed IDs', () => {
	const hash1 = hashWorkspaceIdForTeam({ datasetId: 'ds1', workspaceId: 'ws1' });
	const hash2 = hashWorkspaceIdForTeam({ datasetId: 'ds1', workspaceId: 'ws1' });
	const hash3 = hashWorkspaceIdForTeam({ datasetId: 'ds2', workspaceId: 'ws1' });

	assert.equal(hash1, hash2, 'Same datasetId + workspaceId should produce same hash');
	assert.notEqual(hash1, hash3, 'Different datasetId should produce different hash');
	assert.equal(hash1.length, 16, 'Hash should be 16 hex chars (truncated)');
});

test('hashMachineIdForTeam produces stable hashed IDs', () => {
	const hash1 = hashMachineIdForTeam({ datasetId: 'ds1', machineId: 'm1' });
	const hash2 = hashMachineIdForTeam({ datasetId: 'ds1', machineId: 'm1' });
	const hash3 = hashMachineIdForTeam({ datasetId: 'ds2', machineId: 'm1' });

	assert.equal(hash1, hash2, 'Same datasetId + machineId should produce same hash');
	assert.notEqual(hash1, hash3, 'Different datasetId should produce different hash');
	assert.equal(hash1.length, 16, 'Hash should be 16 hex chars (truncated)');
});

test('hashWorkspaceIdForTeam handles empty datasetId gracefully', () => {
	const hash1 = hashWorkspaceIdForTeam({ datasetId: '', workspaceId: 'ws1' });
	const hash2 = hashWorkspaceIdForTeam({ datasetId: '   ', workspaceId: 'ws1' });
	const hash3 = hashWorkspaceIdForTeam({ datasetId: 'default', workspaceId: 'ws1' });

	// Empty/whitespace datasetId should fall back to 'default'
	assert.equal(hash1, hash2, 'Empty and whitespace datasetId should produce same hash');
	assert.equal(hash1, hash3, 'Empty datasetId should use "default" key');
});

test('regression: shareWithTeam=false never uploads names or raw IDs when profile is off', () => {
	const policy = computeBackendSharingPolicy({
		enabled: true,
		profile: 'off',
		shareWorkspaceMachineNames: true // Should be ignored
	});

	assert.equal(policy.allowCloudSync, false);
	assert.equal(policy.includeNames, false);
	assert.equal(policy.includeUserDimension, false);
});

test('regression: teamAnonymized never includes user dimension even if shareWorkspaceMachineNames=true', () => {
	const policy = computeBackendSharingPolicy({
		enabled: true,
		profile: 'teamAnonymized',
		shareWorkspaceMachineNames: true
	});

	assert.equal(policy.includeUserDimension, false);
	assert.equal(policy.includeNames, false, 'teamAnonymized should never include names');
});

test('regression: no names uploaded without explicit opt-in (default is names off)', () => {
	const profiles: BackendSharingProfile[] = ['teamAnonymized', 'teamPseudonymous', 'teamIdentified'];

	for (const profile of profiles) {
		const policy = computeBackendSharingPolicy({
			enabled: true,
			profile,
			shareWorkspaceMachineNames: false
		});

		assert.equal(policy.includeNames, false, `${profile} with shareWorkspaceMachineNames=false should not include names`);
	}
});
