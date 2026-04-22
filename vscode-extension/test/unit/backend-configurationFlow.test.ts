import './vscode-shim-register';
import test from 'node:test';
import * as assert from 'node:assert/strict';

import {
	toDraft,
	clampLookback,
	deriveShareWithTeam,
	sharingLevel,
	needsConsent,
	validateDraft,
	applyDraftToSettings,
	getPrivacyBadge,
	ALIAS_REGEX,
	type BackendConfigDraft
} from '../../src/backend/configurationFlow';
import type { BackendSettings } from '../../src/backend/settings';

const baseSettings: BackendSettings = {
	enabled: true,
	backend: 'storageTables',
	authMode: 'entraId',
	datasetId: 'default',
	sharingProfile: 'teamAnonymized',
	shareWithTeam: false,
	shareWorkspaceMachineNames: false,
	shareConsentAt: '',
	userIdentityMode: 'pseudonymous',
	userId: '',
	userIdMode: 'alias',
	subscriptionId: 'sub-1',
	resourceGroup: 'rg-1',
	storageAccount: 'stor1',
	aggTable: 'usageAggDaily',
	eventsTable: 'usageEvents',
	lookbackDays: 30,
	includeMachineBreakdown: false,
	blobUploadEnabled: false,
	blobContainerName: 'copilot-session-logs',
	blobUploadFrequencyHours: 24,
	blobCompressFiles: true,
	sharingServerEndpointUrl: ''
};

// ── toDraft ──────────────────────────────────────────────────────────────

test('toDraft maps all settings fields to draft object', () => {
	const draft = toDraft(baseSettings);
	assert.equal(draft.enabled, true);
	assert.equal(draft.authMode, 'entraId');
	assert.equal(draft.sharingProfile, 'teamAnonymized');
	assert.equal(draft.shareWorkspaceMachineNames, false);
	assert.equal(draft.includeMachineBreakdown, false);
	assert.equal(draft.datasetId, 'default');
	assert.equal(draft.lookbackDays, 30);
	assert.equal(draft.subscriptionId, 'sub-1');
	assert.equal(draft.resourceGroup, 'rg-1');
	assert.equal(draft.storageAccount, 'stor1');
	assert.equal(draft.aggTable, 'usageAggDaily');
	assert.equal(draft.eventsTable, 'usageEvents');
	assert.equal(draft.userIdentityMode, 'pseudonymous');
	assert.equal(draft.userId, '');
	assert.equal(draft.blobUploadEnabled, false);
	assert.equal(draft.blobContainerName, 'copilot-session-logs');
	assert.equal(draft.blobUploadFrequencyHours, 24);
	assert.equal(draft.blobCompressFiles, true);
});

test('toDraft clamps lookbackDays', () => {
	const draft = toDraft({ ...baseSettings, lookbackDays: 0 });
	assert.equal(draft.lookbackDays, 1);

	const draft2 = toDraft({ ...baseSettings, lookbackDays: 200 });
	assert.equal(draft2.lookbackDays, 90);
});

// ── clampLookback ────────────────────────────────────────────────────────

test('clampLookback returns value within bounds', () => {
	assert.equal(clampLookback(30), 30);
	assert.equal(clampLookback(1), 1);
	assert.equal(clampLookback(90), 90);
});

test('clampLookback clamps to min', () => {
	assert.equal(clampLookback(0), 1);
	assert.equal(clampLookback(-10), 1);
});

test('clampLookback clamps to max', () => {
	assert.equal(clampLookback(100), 90);
	assert.equal(clampLookback(999), 90);
});

test('clampLookback rounds fractional values', () => {
	assert.equal(clampLookback(30.6), 31);
	assert.equal(clampLookback(7.2), 7);
});

test('clampLookback falls back to min for non-finite values', () => {
	assert.equal(clampLookback(NaN), 1);
	assert.equal(clampLookback(Infinity), 1);
	assert.equal(clampLookback(-Infinity), 1);
});

// ── deriveShareWithTeam ──────────────────────────────────────────────────

test('deriveShareWithTeam returns true for team sharing profiles', () => {
	assert.equal(deriveShareWithTeam('teamPseudonymous'), true);
	assert.equal(deriveShareWithTeam('teamIdentified'), true);
});

test('deriveShareWithTeam returns false for non-team profiles', () => {
	assert.equal(deriveShareWithTeam('off'), false);
	assert.equal(deriveShareWithTeam('soloFull'), false);
	assert.equal(deriveShareWithTeam('teamAnonymized'), false);
});

// ── sharingLevel ─────────────────────────────────────────────────────────

test('sharingLevel returns correct numeric levels', () => {
	assert.equal(sharingLevel('off'), 0);
	assert.equal(sharingLevel('teamAnonymized'), 1);
	assert.equal(sharingLevel('teamPseudonymous'), 2);
	assert.equal(sharingLevel('soloFull'), 2.5);
	assert.equal(sharingLevel('teamIdentified'), 3);
});

test('sharingLevel returns 0 for unknown profiles', () => {
	assert.equal(sharingLevel('unknown' as any), 0);
});

// ── needsConsent ─────────────────────────────────────────────────────────

test('needsConsent detects more permissive sharing profile', () => {
	const prev = toDraft({ ...baseSettings, sharingProfile: 'teamAnonymized' });
	const next = { ...prev, sharingProfile: 'teamIdentified' as const };
	const result = needsConsent(prev, next);
	assert.equal(result.required, true);
	assert.ok(result.reasons.some(r => r.includes('more permissive')));
});

test('needsConsent detects name sharing enabled', () => {
	const prev = toDraft({ ...baseSettings, shareWorkspaceMachineNames: false });
	const next = { ...prev, shareWorkspaceMachineNames: true };
	const result = needsConsent(prev, next);
	assert.equal(result.required, true);
	assert.ok(result.reasons.some(r => r.includes('names')));
});

test('needsConsent detects both changes simultaneously', () => {
	const prev = toDraft({ ...baseSettings, sharingProfile: 'off', shareWorkspaceMachineNames: false });
	const next = { ...prev, sharingProfile: 'teamIdentified' as const, shareWorkspaceMachineNames: true };
	const result = needsConsent(prev, next);
	assert.equal(result.required, true);
	assert.equal(result.reasons.length, 2);
});

test('needsConsent returns not required when downgrading', () => {
	const prev = toDraft({ ...baseSettings, sharingProfile: 'teamIdentified' });
	const next = { ...prev, sharingProfile: 'teamAnonymized' as const };
	const result = needsConsent(prev, next);
	assert.equal(result.required, false);
	assert.equal(result.reasons.length, 0);
});

test('needsConsent returns not required when no changes', () => {
	const prev = toDraft(baseSettings);
	const result = needsConsent(prev, { ...prev });
	assert.equal(result.required, false);
});

// ── validateDraft ────────────────────────────────────────────────────────

test('validateDraft returns valid for well-formed enabled draft', () => {
	const draft = toDraft(baseSettings);
	const result = validateDraft(draft);
	assert.equal(result.valid, true);
	assert.deepEqual(result.errors, {});
});

test('validateDraft requires datasetId', () => {
	const draft = { ...toDraft(baseSettings), datasetId: '' };
	const result = validateDraft(draft);
	assert.equal(result.valid, false);
	assert.ok(result.errors.datasetId);
});

test('validateDraft rejects invalid datasetId characters', () => {
	const draft = { ...toDraft(baseSettings), datasetId: 'bad dataset!' };
	const result = validateDraft(draft);
	assert.equal(result.valid, false);
	assert.ok(result.errors.datasetId?.includes('letters'));
});

test('validateDraft requires Azure fields when enabled', () => {
	const draft = {
		...toDraft(baseSettings),
		enabled: true,
		subscriptionId: '',
		resourceGroup: '',
		storageAccount: '',
		aggTable: ''
	};
	const result = validateDraft(draft);
	assert.equal(result.valid, false);
	assert.ok(result.errors.subscriptionId);
	assert.ok(result.errors.resourceGroup);
	assert.ok(result.errors.storageAccount);
	assert.ok(result.errors.aggTable);
});

test('validateDraft skips Azure fields when disabled', () => {
	const draft = {
		...toDraft(baseSettings),
		enabled: false,
		subscriptionId: '',
		resourceGroup: '',
		storageAccount: ''
	};
	const result = validateDraft(draft);
	// datasetId is still required
	assert.equal(result.errors.subscriptionId, undefined);
	assert.equal(result.errors.resourceGroup, undefined);
	assert.equal(result.errors.storageAccount, undefined);
});

test('validateDraft rejects invalid table names', () => {
	const draft = { ...toDraft(baseSettings), aggTable: 'bad table!', eventsTable: 'bad#events' };
	const result = validateDraft(draft);
	assert.ok(result.errors.aggTable?.includes('letters'));
	assert.ok(result.errors.eventsTable?.includes('letters'));
});

test('validateDraft rejects non-numeric lookbackDays', () => {
	const draft = { ...toDraft(baseSettings), lookbackDays: NaN };
	const result = validateDraft(draft);
	assert.ok(result.errors.lookbackDays?.includes('number'));
});

test('validateDraft rejects out-of-range lookbackDays', () => {
	const draft = { ...toDraft(baseSettings), lookbackDays: 0 };
	const result = validateDraft(draft);
	assert.ok(result.errors.lookbackDays);
});

test('validateDraft validates teamAlias userId for teamIdentified', () => {
	const draft = {
		...toDraft(baseSettings),
		sharingProfile: 'teamIdentified' as const,
		userIdentityMode: 'teamAlias' as const,
		userId: 'John Doe'  // should fail - has uppercase and space
	};
	const result = validateDraft(draft);
	assert.ok(result.errors.userId);
});

test('validateDraft validates entraObjectId for teamIdentified', () => {
	const draft = {
		...toDraft(baseSettings),
		sharingProfile: 'teamIdentified' as const,
		userIdentityMode: 'entraObjectId' as const,
		userId: 'not-a-guid'
	};
	const result = validateDraft(draft);
	assert.ok(result.errors.userId);
});

test('validateDraft accepts valid GUID for entraObjectId', () => {
	const draft = {
		...toDraft(baseSettings),
		sharingProfile: 'teamIdentified' as const,
		userIdentityMode: 'entraObjectId' as const,
		userId: '12345678-1234-1234-1234-123456789abc'
	};
	const result = validateDraft(draft);
	assert.equal(result.errors.userId, undefined);
});

test('validateDraft requires entraObjectId when empty', () => {
	const draft = {
		...toDraft(baseSettings),
		sharingProfile: 'teamIdentified' as const,
		userIdentityMode: 'entraObjectId' as const,
		userId: ''
	};
	const result = validateDraft(draft);
	assert.ok(result.errors.userId);
});

test('validateDraft rejects invalid authMode', () => {
	const draft = { ...toDraft(baseSettings), authMode: 'invalid' as any };
	const result = validateDraft(draft);
	assert.ok(result.errors.authMode);
});

test('validateDraft validates blob upload fields when enabled', () => {
	const draft = {
		...toDraft(baseSettings),
		blobUploadEnabled: true,
		blobUploadFrequencyHours: 0,
		blobContainerName: ''
	};
	const result = validateDraft(draft);
	assert.ok(result.errors.blobUploadFrequencyHours);
	assert.ok(result.errors.blobContainerName);
});

test('validateDraft accepts valid blob upload settings', () => {
	const draft = {
		...toDraft(baseSettings),
		blobUploadEnabled: true,
		blobUploadFrequencyHours: 24,
		blobContainerName: 'my-logs'
	};
	const result = validateDraft(draft);
	assert.equal(result.errors.blobUploadFrequencyHours, undefined);
	assert.equal(result.errors.blobContainerName, undefined);
});

test('validateDraft skips blob validation when disabled', () => {
	const draft = {
		...toDraft(baseSettings),
		blobUploadEnabled: false,
		blobUploadFrequencyHours: 0,
		blobContainerName: ''
	};
	const result = validateDraft(draft);
	assert.equal(result.errors.blobUploadFrequencyHours, undefined);
	assert.equal(result.errors.blobContainerName, undefined);
});

// ── applyDraftToSettings ─────────────────────────────────────────────────

test('applyDraftToSettings merges draft into settings', () => {
	const draft = toDraft(baseSettings);
	const applied = applyDraftToSettings(baseSettings, draft, undefined);
	assert.equal(applied.enabled, true);
	assert.equal(applied.datasetId, 'default');
	assert.equal(applied.lookbackDays, 30);
});

test('applyDraftToSettings derives shareWithTeam from profile', () => {
	const draft = { ...toDraft(baseSettings), sharingProfile: 'teamPseudonymous' as const };
	const applied = applyDraftToSettings(baseSettings, draft, '2024-01-01');
	assert.equal(applied.shareWithTeam, true);
});

test('applyDraftToSettings clears consent when not team sharing', () => {
	const settingsWithConsent = { ...baseSettings, shareConsentAt: '2024-01-01', shareWithTeam: true };
	const draft = { ...toDraft(settingsWithConsent), sharingProfile: 'off' as const };
	const applied = applyDraftToSettings(settingsWithConsent, draft, undefined);
	assert.equal(applied.shareConsentAt, '');
	assert.equal(applied.shareWithTeam, false);
});

test('applyDraftToSettings preserves existing consent when team sharing continues', () => {
	const settingsWithConsent = { ...baseSettings, shareConsentAt: '2024-01-01', shareWithTeam: true };
	const draft = { ...toDraft(settingsWithConsent), sharingProfile: 'teamPseudonymous' as const };
	const applied = applyDraftToSettings(settingsWithConsent, draft, undefined);
	assert.equal(applied.shareConsentAt, '2024-01-01');
});

test('applyDraftToSettings trims string fields', () => {
	const draft = {
		...toDraft(baseSettings),
		subscriptionId: '  sub-1  ',
		resourceGroup: '  rg  ',
		storageAccount: '  stor  ',
		aggTable: '  table  ',
		eventsTable: '  events  ',
		userId: '  user  '
	};
	const applied = applyDraftToSettings(baseSettings, draft, undefined);
	assert.equal(applied.subscriptionId, 'sub-1');
	assert.equal(applied.resourceGroup, 'rg');
	assert.equal(applied.storageAccount, 'stor');
	assert.equal(applied.aggTable, 'table');
	assert.equal(applied.eventsTable, 'events');
	assert.equal(applied.userId, 'user');
});

test('applyDraftToSettings defaults empty dataset to "default"', () => {
	const draft = { ...toDraft(baseSettings), datasetId: '   ' };
	const applied = applyDraftToSettings(baseSettings, draft, undefined);
	assert.equal(applied.datasetId, 'default');
});

test('applyDraftToSettings clamps lookbackDays', () => {
	const draft = { ...toDraft(baseSettings), lookbackDays: 200 };
	const applied = applyDraftToSettings(baseSettings, draft, undefined);
	assert.equal(applied.lookbackDays, 90);
});

test('applyDraftToSettings clamps blobUploadFrequencyHours', () => {
	const draft = { ...toDraft(baseSettings), blobUploadFrequencyHours: 0 };
	const applied = applyDraftToSettings(baseSettings, draft, undefined);
	assert.equal(applied.blobUploadFrequencyHours, 24);  // 0 is falsy, defaults to 24

	const draft2 = { ...toDraft(baseSettings), blobUploadFrequencyHours: 500 };
	const applied2 = applyDraftToSettings(baseSettings, draft2, undefined);
	assert.equal(applied2.blobUploadFrequencyHours, 168);
});

test('applyDraftToSettings defaults blobCompressFiles to true when missing', () => {
	const draft = { ...toDraft(baseSettings) };
	(draft as any).blobCompressFiles = undefined;
	const applied = applyDraftToSettings(baseSettings, draft, undefined);
	assert.equal(applied.blobCompressFiles, true);
});

test('applyDraftToSettings sets userIdMode based on userIdentityMode', () => {
	const draft1 = { ...toDraft(baseSettings), userIdentityMode: 'entraObjectId' as const };
	const applied1 = applyDraftToSettings(baseSettings, draft1, undefined);
	assert.equal(applied1.userIdMode, 'custom');

	const draft2 = { ...toDraft(baseSettings), userIdentityMode: 'teamAlias' as const };
	const applied2 = applyDraftToSettings(baseSettings, draft2, undefined);
	assert.equal(applied2.userIdMode, 'alias');
});

test('applyDraftToSettings defaults blobContainerName when empty', () => {
	const draft = { ...toDraft(baseSettings), blobContainerName: '' };
	const applied = applyDraftToSettings(baseSettings, draft, undefined);
	assert.equal(applied.blobContainerName, 'copilot-session-logs');
});

// ── getPrivacyBadge ──────────────────────────────────────────────────────

test('getPrivacyBadge returns correct labels for all profiles', () => {
	assert.equal(getPrivacyBadge('off', false), 'Local-only');
	assert.equal(getPrivacyBadge('soloFull', false), 'Solo');
	assert.equal(getPrivacyBadge('soloFull', true), 'Solo');
	assert.equal(getPrivacyBadge('teamAnonymized', false), 'Team Anonymized');
	assert.equal(getPrivacyBadge('teamAnonymized', true), 'Team (Names)');
	assert.equal(getPrivacyBadge('teamPseudonymous', false), 'Team Pseudonymous');
	assert.equal(getPrivacyBadge('teamPseudonymous', true), 'Team Pseudonymous (Names)');
	assert.equal(getPrivacyBadge('teamIdentified', false), 'Team Identified');
	assert.equal(getPrivacyBadge('teamIdentified', true), 'Team Identified (Names)');
});

// ── ALIAS_REGEX ──────────────────────────────────────────────────────────

test('ALIAS_REGEX accepts valid names', () => {
	assert.ok(ALIAS_REGEX.test('my-team'));
	assert.ok(ALIAS_REGEX.test('team_alpha'));
	assert.ok(ALIAS_REGEX.test('Project1'));
	assert.ok(ALIAS_REGEX.test('a'));
	assert.ok(ALIAS_REGEX.test('A'));
	assert.ok(ALIAS_REGEX.test('1abc'));
});

test('ALIAS_REGEX rejects invalid names', () => {
	assert.ok(!ALIAS_REGEX.test(''));
	assert.ok(!ALIAS_REGEX.test('-starts-with-dash'));
	assert.ok(!ALIAS_REGEX.test('_starts-with-underscore'));
	assert.ok(!ALIAS_REGEX.test('has space'));
	assert.ok(!ALIAS_REGEX.test('has@symbol'));
});
