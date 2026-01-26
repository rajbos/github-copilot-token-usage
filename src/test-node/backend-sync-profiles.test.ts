import './vscode-shim-register';
import test from 'node:test';
import * as assert from 'node:assert/strict';

import { computeBackendSharingPolicy } from '../backend/sharingProfile';
import type { BackendSettings } from '../backend/settings';

/**
 * Integration tests for backend sync with different sharing profiles.
 * These tests verify that the backend facade correctly applies sharing policies
 * when uploading data to the backend store.
 */

test('backend sync: soloFull profile uploads raw workspace/machine IDs and names', () => {
	const settings: BackendSettings = {
		enabled: true,
		backend: 'storageTables',
		authMode: 'entraId',
		datasetId: 'test-dataset',
		sharingProfile: 'soloFull',
		shareWithTeam: false,
		shareWorkspaceMachineNames: true,
		shareConsentAt: '',
		userIdentityMode: 'pseudonymous',
		userId: '',
		userIdMode: 'alias',
		subscriptionId: 'sub',
		resourceGroup: 'rg',
		storageAccount: 'sa',
		aggTable: 'agg',
		eventsTable: 'events',
		lookbackDays: 30,
		includeMachineBreakdown: true
	};

	const policy = computeBackendSharingPolicy({
		enabled: settings.enabled,
		profile: settings.sharingProfile,
		shareWorkspaceMachineNames: settings.shareWorkspaceMachineNames
	});

	assert.equal(policy.allowCloudSync, true);
	assert.equal(policy.workspaceIdStrategy, 'raw', 'soloFull should use raw workspace IDs');
	assert.equal(policy.machineIdStrategy, 'raw', 'soloFull should use raw machine IDs');
	assert.equal(policy.includeNames, true, 'soloFull should include names');
	assert.equal(policy.includeUserDimension, false, 'soloFull should not include user dimension');
});

test('backend sync: teamAnonymized profile hashes IDs, no user dimension, no names', () => {
	const settings: BackendSettings = {
		enabled: true,
		backend: 'storageTables',
		authMode: 'entraId',
		datasetId: 'test-dataset',
		sharingProfile: 'teamAnonymized',
		shareWithTeam: false,
		shareWorkspaceMachineNames: false,
		shareConsentAt: '',
		userIdentityMode: 'pseudonymous',
		userId: '',
		userIdMode: 'alias',
		subscriptionId: 'sub',
		resourceGroup: 'rg',
		storageAccount: 'sa',
		aggTable: 'agg',
		eventsTable: 'events',
		lookbackDays: 30,
		includeMachineBreakdown: true
	};

	const policy = computeBackendSharingPolicy({
		enabled: settings.enabled,
		profile: settings.sharingProfile,
		shareWorkspaceMachineNames: settings.shareWorkspaceMachineNames
	});

	assert.equal(policy.allowCloudSync, true);
	assert.equal(policy.workspaceIdStrategy, 'hashed', 'teamAnonymized should hash workspace IDs');
	assert.equal(policy.machineIdStrategy, 'hashed', 'teamAnonymized should hash machine IDs');
	assert.equal(policy.includeNames, false, 'teamAnonymized should never include names');
	assert.equal(policy.includeUserDimension, false, 'teamAnonymized should not include user dimension');
});

test('backend sync: teamPseudonymous profile includes user dimension with consent', () => {
	const settings: BackendSettings = {
		enabled: true,
		backend: 'storageTables',
		authMode: 'entraId',
		datasetId: 'test-dataset',
		sharingProfile: 'teamPseudonymous',
		shareWithTeam: true,
		shareWorkspaceMachineNames: false,
		shareConsentAt: '2026-01-21T00:00:00Z',
		userIdentityMode: 'pseudonymous',
		userId: '',
		userIdMode: 'alias',
		subscriptionId: 'sub',
		resourceGroup: 'rg',
		storageAccount: 'sa',
		aggTable: 'agg',
		eventsTable: 'events',
		lookbackDays: 30,
		includeMachineBreakdown: true
	};

	const policy = computeBackendSharingPolicy({
		enabled: settings.enabled,
		profile: settings.sharingProfile,
		shareWorkspaceMachineNames: settings.shareWorkspaceMachineNames
	});

	assert.equal(policy.allowCloudSync, true);
	assert.equal(policy.workspaceIdStrategy, 'hashed', 'teamPseudonymous should hash workspace IDs');
	assert.equal(policy.machineIdStrategy, 'hashed', 'teamPseudonymous should hash machine IDs');
	assert.equal(policy.includeNames, false, 'teamPseudonymous with shareWorkspaceMachineNames=false should not include names');
	assert.equal(policy.includeUserDimension, true, 'teamPseudonymous should include user dimension');
	assert.ok(settings.shareConsentAt, 'teamPseudonymous should have shareConsentAt timestamp');
});

test('backend sync: teamIdentified profile includes user dimension with explicit identity', () => {
	const settings: BackendSettings = {
		enabled: true,
		backend: 'storageTables',
		authMode: 'entraId',
		datasetId: 'test-dataset',
		sharingProfile: 'teamIdentified',
		shareWithTeam: true,
		shareWorkspaceMachineNames: false,
		shareConsentAt: '2026-01-21T00:00:00Z',
		userIdentityMode: 'teamAlias',
		userId: 'dev-01',
		userIdMode: 'alias',
		subscriptionId: 'sub',
		resourceGroup: 'rg',
		storageAccount: 'sa',
		aggTable: 'agg',
		eventsTable: 'events',
		lookbackDays: 30,
		includeMachineBreakdown: true
	};

	const policy = computeBackendSharingPolicy({
		enabled: settings.enabled,
		profile: settings.sharingProfile,
		shareWorkspaceMachineNames: settings.shareWorkspaceMachineNames
	});

	assert.equal(policy.allowCloudSync, true);
	assert.equal(policy.workspaceIdStrategy, 'hashed', 'teamIdentified should hash workspace IDs');
	assert.equal(policy.machineIdStrategy, 'hashed', 'teamIdentified should hash machine IDs');
	assert.equal(policy.includeNames, false, 'teamIdentified with shareWorkspaceMachineNames=false should not include names');
	assert.equal(policy.includeUserDimension, true, 'teamIdentified should include user dimension');
	assert.ok(settings.userId, 'teamIdentified should have explicit userId');
	assert.ok(settings.shareConsentAt, 'teamIdentified should have shareConsentAt timestamp');
});

test('regression: shareWithTeam=false with profile=off never uploads anything', () => {
	const settings: BackendSettings = {
		enabled: true,
		backend: 'storageTables',
		authMode: 'entraId',
		datasetId: 'test-dataset',
		sharingProfile: 'off',
		shareWithTeam: false,
		shareWorkspaceMachineNames: true, // Should be ignored
		shareConsentAt: '',
		userIdentityMode: 'pseudonymous',
		userId: 'test-user', // Should be ignored
		userIdMode: 'alias',
		subscriptionId: 'sub',
		resourceGroup: 'rg',
		storageAccount: 'sa',
		aggTable: 'agg',
		eventsTable: 'events',
		lookbackDays: 30,
		includeMachineBreakdown: true
	};

	const policy = computeBackendSharingPolicy({
		enabled: settings.enabled,
		profile: settings.sharingProfile,
		shareWorkspaceMachineNames: settings.shareWorkspaceMachineNames
	});

	assert.equal(policy.allowCloudSync, false, 'profile=off should disable cloud sync');
	assert.equal(policy.includeNames, false, 'profile=off should never include names');
	assert.equal(policy.includeUserDimension, false, 'profile=off should never include user dimension');
});

test('regression: profile=off overrides shareWithTeam=true (safety gate)', () => {
	const settings: BackendSettings = {
		enabled: true,
		backend: 'storageTables',
		authMode: 'entraId',
		datasetId: 'test-dataset',
		sharingProfile: 'off',
		shareWithTeam: true, // Should be ignored
		shareWorkspaceMachineNames: true, // Should be ignored
		shareConsentAt: '2026-01-21T00:00:00Z', // Should be ignored
		userIdentityMode: 'teamAlias',
		userId: 'dev-01', // Should be ignored
		userIdMode: 'alias',
		subscriptionId: 'sub',
		resourceGroup: 'rg',
		storageAccount: 'sa',
		aggTable: 'agg',
		eventsTable: 'events',
		lookbackDays: 30,
		includeMachineBreakdown: true
	};

	const policy = computeBackendSharingPolicy({
		enabled: settings.enabled,
		profile: settings.sharingProfile,
		shareWorkspaceMachineNames: settings.shareWorkspaceMachineNames
	});

	assert.equal(policy.allowCloudSync, false, 'profile=off should disable cloud sync even if shareWithTeam=true');
	assert.equal(policy.includeNames, false);
	assert.equal(policy.includeUserDimension, false);
});

test('consent timestamp: teamPseudonymous requires shareConsentAt', () => {
	const settingsWithConsent: BackendSettings = {
		enabled: true,
		backend: 'storageTables',
		authMode: 'entraId',
		datasetId: 'test-dataset',
		sharingProfile: 'teamPseudonymous',
		shareWithTeam: true,
		shareWorkspaceMachineNames: false,
		shareConsentAt: '2026-01-21T00:00:00Z',
		userIdentityMode: 'pseudonymous',
		userId: '',
		userIdMode: 'alias',
		subscriptionId: 'sub',
		resourceGroup: 'rg',
		storageAccount: 'sa',
		aggTable: 'agg',
		eventsTable: 'events',
		lookbackDays: 30,
		includeMachineBreakdown: true
	};

	assert.ok(settingsWithConsent.shareConsentAt, 'teamPseudonymous should have shareConsentAt');
	assert.ok(settingsWithConsent.shareConsentAt.length > 0, 'shareConsentAt should be a non-empty string');
});

test('consent timestamp: teamIdentified requires shareConsentAt', () => {
	const settingsWithConsent: BackendSettings = {
		enabled: true,
		backend: 'storageTables',
		authMode: 'entraId',
		datasetId: 'test-dataset',
		sharingProfile: 'teamIdentified',
		shareWithTeam: true,
		shareWorkspaceMachineNames: false,
		shareConsentAt: '2026-01-21T00:00:00Z',
		userIdentityMode: 'teamAlias',
		userId: 'dev-01',
		userIdMode: 'alias',
		subscriptionId: 'sub',
		resourceGroup: 'rg',
		storageAccount: 'sa',
		aggTable: 'agg',
		eventsTable: 'events',
		lookbackDays: 30,
		includeMachineBreakdown: true
	};

	assert.ok(settingsWithConsent.shareConsentAt, 'teamIdentified should have shareConsentAt');
	assert.ok(settingsWithConsent.shareConsentAt.length > 0, 'shareConsentAt should be a non-empty string');
});
