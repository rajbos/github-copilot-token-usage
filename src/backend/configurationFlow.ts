import { MIN_LOOKBACK_DAYS, MAX_LOOKBACK_DAYS } from './constants';
import type { BackendSettings, BackendAuthMode } from './settings';
import type { BackendSharingProfile } from './sharingProfile';
import type { BackendUserIdentityMode } from './identity';
import { validateTeamAlias } from './identity';
import { ValidationMessages } from './ui/messages';

export interface BackendConfigDraft {
	enabled: boolean;
	authMode: BackendAuthMode;
	sharingProfile: BackendSharingProfile;
	shareWorkspaceMachineNames: boolean;
	includeMachineBreakdown: boolean;
	datasetId: string;
	lookbackDays: number;
	subscriptionId: string;
	resourceGroup: string;
	storageAccount: string;
	aggTable: string;
	eventsTable: string;
	userIdentityMode: BackendUserIdentityMode;
	userId: string;
}

export interface DraftValidationResult {
	valid: boolean;
	errors: Record<string, string>;
}

export const ALIAS_REGEX = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export function toDraft(settings: BackendSettings): BackendConfigDraft {
	return {
		enabled: settings.enabled,
		authMode: settings.authMode,
		sharingProfile: settings.sharingProfile,
		shareWorkspaceMachineNames: settings.shareWorkspaceMachineNames,
		includeMachineBreakdown: settings.includeMachineBreakdown,
		datasetId: settings.datasetId,
		lookbackDays: clampLookback(settings.lookbackDays),
		subscriptionId: settings.subscriptionId,
		resourceGroup: settings.resourceGroup,
		storageAccount: settings.storageAccount,
		aggTable: settings.aggTable,
		eventsTable: settings.eventsTable,
		userIdentityMode: settings.userIdentityMode,
		userId: settings.userId
	};
}

export function clampLookback(value: number): number {
	const numeric = Number.isFinite(value) ? Number(value) : MIN_LOOKBACK_DAYS;
	return Math.max(MIN_LOOKBACK_DAYS, Math.min(MAX_LOOKBACK_DAYS, Math.round(numeric)));
}

export function deriveShareWithTeam(profile: BackendSharingProfile): boolean {
	return profile === 'teamPseudonymous' || profile === 'teamIdentified';
}

export function sharingLevel(profile: BackendSharingProfile): number {
	// Higher number => more permissive.
	switch (profile) {
		case 'off':
			return 0;
		case 'teamAnonymized':
			return 1;
		case 'teamPseudonymous':
			return 2;
		case 'teamIdentified':
			return 3;
		case 'soloFull':
			return 2.5; // personal but includes readable names
		default:
			return 0;
	}
}

export function needsConsent(previous: BackendConfigDraft, next: BackendConfigDraft): { required: boolean; reasons: string[] } {
	const reasons: string[] = [];
	if (sharingLevel(next.sharingProfile) > sharingLevel(previous.sharingProfile)) {
		reasons.push('Sharing profile becomes more permissive');
	}
	if (!previous.shareWorkspaceMachineNames && next.shareWorkspaceMachineNames) {
		reasons.push('Readable workspace/machine names will be uploaded');
	}
	return { required: reasons.length > 0, reasons };
}

export function validateDraft(draft: BackendConfigDraft): DraftValidationResult {
	const errors: Record<string, string> = {};
	const requireAzure = draft.enabled;

	const requireString = (value: string, field: string, fieldLabel: string, example?: string) => {
		if (!value || !value.trim()) {
			errors[field] = ValidationMessages.required(fieldLabel, example);
		}
	};

	if (!draft.datasetId || !draft.datasetId.trim()) {
		errors.datasetId = ValidationMessages.required('Dataset ID', '"my-team-copilot"');
	} else if (!ALIAS_REGEX.test(draft.datasetId.trim())) {
		errors.datasetId = ValidationMessages.alphanumeric('Dataset ID', 'my-team-copilot');
	}

	if (requireAzure) {
		requireString(draft.subscriptionId, 'subscriptionId', 'Subscription ID');
		requireString(draft.resourceGroup, 'resourceGroup', 'Resource Group', 'copilot-tokens-rg');
		requireString(draft.storageAccount, 'storageAccount', 'Storage Account', 'copilottokensrg');
		requireString(draft.aggTable, 'aggTable', 'Aggregate Table', 'usageAggDaily');
	}

	const tableFields: Array<['aggTable' | 'eventsTable', string, string]> = [
		['aggTable', draft.aggTable, 'Aggregate Table'],
		['eventsTable', draft.eventsTable, 'Events Table']
	];
	for (const [key, value, label] of tableFields) {
		if (value && !ALIAS_REGEX.test(value.trim())) {
			errors[key] = ValidationMessages.alphanumeric(label, 'usageAggDaily');
		}
	}

	const lookback = Number(draft.lookbackDays);
	if (!Number.isFinite(lookback)) {
		errors.lookbackDays = 'Lookback days must be a number. Enter a value between 1 and 90.';
	} else if (lookback < MIN_LOOKBACK_DAYS || lookback > MAX_LOOKBACK_DAYS) {
		errors.lookbackDays = ValidationMessages.range('Lookback days', MIN_LOOKBACK_DAYS, MAX_LOOKBACK_DAYS);
	}

	if (draft.sharingProfile === 'teamIdentified') {
		if (draft.userIdentityMode === 'teamAlias') {
			const res = validateTeamAlias(draft.userId);
			if (!res.valid) {
				errors.userId = res.error;
			}
		} else if (draft.userIdentityMode === 'entraObjectId') {
			const trimmed = (draft.userId ?? '').trim();
			if (!trimmed) {
				errors.userId = ValidationMessages.required('Entra object ID');
			} else if (!/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(trimmed)) {
				errors.userId = ValidationMessages.guidFormat('Entra object ID');
			}
		}
	}

	if (draft.authMode !== 'entraId' && draft.authMode !== 'sharedKey') {
		errors.authMode = ValidationMessages.required('Auth mode');
	}

	return { valid: Object.keys(errors).length === 0, errors };
}

export function applyDraftToSettings(
	previous: BackendSettings,
	draft: BackendConfigDraft,
	consentAt: string | undefined
): BackendSettings {
	const shareWithTeam = deriveShareWithTeam(draft.sharingProfile);
	const sanitizedDataset = draft.datasetId.trim() || 'default';
	const sanitizedUserId = draft.userId.trim();

	return {
		...previous,
		enabled: draft.enabled,
		authMode: draft.authMode,
		datasetId: sanitizedDataset,
		sharingProfile: draft.sharingProfile,
		shareWithTeam,
		shareWorkspaceMachineNames: draft.shareWorkspaceMachineNames,
		shareConsentAt: shareWithTeam ? (consentAt ?? previous.shareConsentAt) : '',
		userIdentityMode: draft.userIdentityMode,
		userId: sanitizedUserId,
		userIdMode: draft.userIdentityMode === 'entraObjectId' ? 'custom' : 'alias',
		subscriptionId: draft.subscriptionId.trim(),
		resourceGroup: draft.resourceGroup.trim(),
		storageAccount: draft.storageAccount.trim(),
		aggTable: draft.aggTable.trim(),
		eventsTable: draft.eventsTable.trim(),
		lookbackDays: clampLookback(draft.lookbackDays),
		includeMachineBreakdown: !!draft.includeMachineBreakdown
	};
}

export function getPrivacyBadge(profile: BackendSharingProfile, includeNames: boolean): string {
	if (profile === 'off') {
		return 'Local-only';
	}
	if (profile === 'soloFull') {
		return 'Solo';
	}
	if (profile === 'teamAnonymized') {
		return includeNames ? 'Team (Names)' : 'Team Anonymized';
	}
	if (profile === 'teamPseudonymous') {
		return includeNames ? 'Team Pseudonymous (Names)' : 'Team Pseudonymous';
	}
	return includeNames ? 'Team Identified (Names)' : 'Team Identified';
}
