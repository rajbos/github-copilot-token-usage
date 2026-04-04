import { createHmac } from 'crypto';

export type BackendSharingProfile = 'off' | 'soloFull' | 'teamAnonymized' | 'teamPseudonymous' | 'teamIdentified';

export interface BackendSharingPolicy {
	profile: BackendSharingProfile;
	allowCloudSync: boolean;
	includeUserDimension: boolean;
	includeNames: boolean;
	workspaceIdStrategy: 'raw' | 'hashed';
	machineIdStrategy: 'raw' | 'hashed';
}

export function parseBackendSharingProfile(value: unknown): BackendSharingProfile | undefined {
	if (value === 'off' || value === 'soloFull' || value === 'teamAnonymized' || value === 'teamPseudonymous' || value === 'teamIdentified') {
		return value;
	}
	return undefined;
}

/**
 * Computes the effective sharing policy based on settings and sharing profile.
 * Implements five privacy profiles: off, soloFull, teamAnonymized, teamPseudonymous, teamIdentified.
 * Privacy by default: team modes use hashed IDs, names only included when explicitly enabled.
 * 
 * @param args - Configuration including enabled flag, profile, and name sharing preference
 * @returns Concrete policy object that controls sync behavior
 */
export function computeBackendSharingPolicy(args: {
	enabled: boolean;
	profile: BackendSharingProfile;
	shareWorkspaceMachineNames: boolean;
}): BackendSharingPolicy {
	const allowCloudSync = args.enabled && args.profile !== 'off';

	if (args.profile === 'off') {
		return {
			profile: 'off',
			allowCloudSync,
			includeUserDimension: false,
			includeNames: false,
			workspaceIdStrategy: 'raw',
			machineIdStrategy: 'raw'
		};
	}

	if (args.profile === 'soloFull') {
		return {
			profile: 'soloFull',
			allowCloudSync,
			includeUserDimension: false,
			includeNames: true,
			workspaceIdStrategy: 'raw',
			machineIdStrategy: 'raw'
		};
	}

	if (args.profile === 'teamAnonymized') {
		return {
			profile: 'teamAnonymized',
			allowCloudSync,
			includeUserDimension: false,
			includeNames: false,
			workspaceIdStrategy: 'hashed',
			machineIdStrategy: 'hashed'
		};
	}

	return {
		profile: args.profile,
		allowCloudSync,
		includeUserDimension: true,
		includeNames: args.shareWorkspaceMachineNames,
		workspaceIdStrategy: 'hashed',
		machineIdStrategy: 'hashed'
	};
}

function hmacHexTruncated(args: { key: string; input: string; hexChars: number }): string {
	return createHmac('sha256', args.key).update(args.input).digest('hex').slice(0, args.hexChars);
}

export function hashWorkspaceIdForTeam(args: { datasetId: string; workspaceId: string }): string {
	const datasetKey = (args.datasetId ?? '').trim() || 'default';
	return hmacHexTruncated({ key: datasetKey, input: `workspace:${args.workspaceId}`, hexChars: 16 });
}

export function hashMachineIdForTeam(args: { datasetId: string; machineId: string }): string {
	const datasetKey = (args.datasetId ?? '').trim() || 'default';
	return hmacHexTruncated({ key: datasetKey, input: `machine:${args.machineId}`, hexChars: 16 });
}
