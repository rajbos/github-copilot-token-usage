import * as vscode from 'vscode';
import { MIN_LOOKBACK_DAYS, MAX_LOOKBACK_DAYS, DEFAULT_LOOKBACK_DAYS } from './constants';
import type { BackendUserIdentityMode } from './identity';
import { parseBackendSharingProfile, type BackendSharingProfile } from './sharingProfile';

export type BackendType = 'storageTables';

export type BackendAuthMode = 'entraId' | 'sharedKey';

export type BackendShareConsentAt = string;

export function shouldPromptToSetSharedKey(authMode: BackendAuthMode, storageAccount: string, sharedKey: string | undefined): boolean {
	if (authMode !== 'sharedKey') {
		return false;
	}
	if (!storageAccount || !storageAccount.trim()) {
		return false;
	}
	return !(sharedKey && sharedKey.trim());
}

export interface BackendSettings {
	enabled: boolean;
	backend: BackendType;
	authMode: BackendAuthMode;
	datasetId: string;
	sharingProfile: BackendSharingProfile;
	shareWithTeam: boolean;
	shareWorkspaceMachineNames: boolean;
	shareConsentAt: BackendShareConsentAt;
	userIdentityMode: BackendUserIdentityMode;
	userId: string;
	userIdMode: 'alias' | 'custom';
	subscriptionId: string;
	resourceGroup: string;
	storageAccount: string;
	aggTable: string;
	eventsTable: string;
	rawContainer: string;
	lookbackDays: number;
	includeMachineBreakdown: boolean;
}

export interface BackendQueryFilters {
	lookbackDays: number;
	model?: string;
	workspaceId?: string;
	machineId?: string;
	userId?: string;
}

export function getBackendSettings(): BackendSettings {
	const config = vscode.workspace.getConfiguration('copilotTokenTracker');
	const sharingProfileInspect = typeof (config as any).inspect === 'function'
		? config.inspect<string>('backend.sharingProfile')
		: undefined;
	const sharingProfileRaw = sharingProfileInspect?.globalValue ?? sharingProfileInspect?.workspaceValue ?? sharingProfileInspect?.workspaceFolderValue;

	const userId = config.get<string>('backend.userId', '').trim();
	const userIdMode = config.get<'alias' | 'custom'>('backend.userIdMode', 'alias');
	const userIdentityMode = config.get<BackendUserIdentityMode>('backend.userIdentityMode', 'pseudonymous');
	const shareWithTeam = config.get<boolean>('backend.shareWithTeam', false);

	const parsedSharingProfile = parseBackendSharingProfile(sharingProfileRaw);
	// Default posture is minimizing: when backend is enabled without explicit profile,
	// always default to teamAnonymized (hashed IDs, no user dimension, names off).
	// Legacy shareWithTeam only affects the profile when an explicit userIdentityMode is set.
	const backendEnabled = config.get<boolean>('backend.enabled', false);
	const inferredSharingProfile: BackendSharingProfile = parsedSharingProfile
		?? (
			!backendEnabled
				? 'off'
				: (shareWithTeam && userIdentityMode !== 'pseudonymous'
					? 'teamIdentified'
					: (shareWithTeam && userIdentityMode === 'pseudonymous'
						? 'teamPseudonymous'
						: 'teamAnonymized'))
		);

	return {
		enabled: config.get<boolean>('backend.enabled', false),
		backend: config.get<BackendType>('backend.backend', 'storageTables'),
		authMode: config.get<BackendAuthMode>('backend.authMode', 'entraId'),
		datasetId: config.get<string>('backend.datasetId', 'default').trim() || 'default',
		sharingProfile: inferredSharingProfile,
		shareWithTeam,
		shareWorkspaceMachineNames: config.get<boolean>('backend.shareWorkspaceMachineNames', false),
		shareConsentAt: config.get<string>('backend.shareConsentAt', ''),
		userIdentityMode,
		userId,
		userIdMode,
		subscriptionId: config.get<string>('backend.subscriptionId', ''),
		resourceGroup: config.get<string>('backend.resourceGroup', ''),
		storageAccount: config.get<string>('backend.storageAccount', ''),
		aggTable: config.get<string>('backend.aggTable', 'usageAggDaily'),
		eventsTable: config.get<string>('backend.eventsTable', 'usageEvents'),
		rawContainer: config.get<string>('backend.rawContainer', 'raw-usage'),
		lookbackDays: Math.max(MIN_LOOKBACK_DAYS, Math.min(MAX_LOOKBACK_DAYS, config.get<number>('backend.lookbackDays', DEFAULT_LOOKBACK_DAYS))),
		includeMachineBreakdown: config.get<boolean>('backend.includeMachineBreakdown', false)
	};
}

export function isBackendConfigured(settings: BackendSettings): boolean {
	return !!(settings.subscriptionId && settings.resourceGroup && settings.storageAccount && settings.aggTable);
}
