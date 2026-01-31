import { createHash } from 'crypto';
import { ValidationMessages } from './ui/messages';

export type BackendUserIdentityMode = 'pseudonymous' | 'teamAlias' | 'entraObjectId';

export type TeamAliasValidationResult =
	| { valid: true; alias: string }
	| { valid: false; error: string };

const TEAM_ALIAS_REGEX = /^[a-z0-9-]+$/;
const MAX_TEAM_ALIAS_LENGTH = 32;
const COMMON_NAME_PATTERNS = /\b(john|jane|smith|doe|admin|user|dev|test|demo)\b/i;

export function validateTeamAlias(input: string): TeamAliasValidationResult {
	const alias = (input ?? '').trim();
	if (!alias) {
		return { 
			valid: false, 
			error: ValidationMessages.required('Team alias', 'alex-dev') + ' ' + ValidationMessages.piiWarning('Do not use email addresses or real names.')
		};
	}
	if (alias.length > MAX_TEAM_ALIAS_LENGTH) {
		return { 
			valid: false, 
			error: `Team alias is too long (maximum ${MAX_TEAM_ALIAS_LENGTH} characters). Use a shorter handle like "alex-dev".`
		};
	}
	if (alias.includes('@')) {
		return { 
			valid: false, 
			error: `Team alias cannot contain @ symbol (looks like an email). Use a handle like "alex-dev" instead. ${ValidationMessages.piiWarning('Do not use email addresses.')}`
		};
	}
	if (alias.includes(' ')) {
		return { 
			valid: false, 
			error: `Team alias cannot contain spaces (looks like a display name). Use dashes instead. Example: "alex-dev". ${ValidationMessages.piiWarning('Do not use real names.')}`
		};
	}
	if (!TEAM_ALIAS_REGEX.test(alias)) {
		return { 
			valid: false, 
			error: ValidationMessages.format('Team alias', 'use only lowercase letters, numbers, and dashes', 'alex-dev') + ' ' + ValidationMessages.piiWarning('Do not use email addresses or real names.')
		};
	}
	if (COMMON_NAME_PATTERNS.test(alias)) {
		return { 
			valid: false, 
			error: `Team alias "${alias}" looks like a real name or common identifier. Use a non-identifying handle like "team-frontend" or "qa-lead".`
		};
	}
	return { valid: true, alias };
}

export interface JwtClaims {
	tenantId?: string;
	objectId?: string;
}

function base64UrlDecodeToString(value: string): string {
	const padded = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
	return Buffer.from(padded, 'base64').toString('utf8');
}

export function tryParseJwtClaims(accessToken: string): JwtClaims {
	const token = (accessToken ?? '').trim();
	const parts = token.split('.');
	if (parts.length < 2) {
		return {};
	}
	try {
		const payloadJson = base64UrlDecodeToString(parts[1]);
		const payload = JSON.parse(payloadJson) as Record<string, unknown>;
		const tenantId = typeof payload.tid === 'string' ? payload.tid : undefined;
		const objectId = typeof payload.oid === 'string' ? payload.oid : undefined;
		return { tenantId, objectId };
	} catch {
		return {};
	}
}

/**
 * Derives a pseudonymous user key from Entra ID claims and dataset ID.
 * Creates a stable, privacy-preserving identifier using SHA-256 hashing.
 * Dataset scoping enables key rotation by changing the dataset ID.
 * 
 * @param args - Object containing tenantId, objectId (from Entra ID JWT), and datasetId
 * @returns 16-character hex string (64-bit hash)
 */
export function derivePseudonymousUserKey(args: { tenantId: string; objectId: string; datasetId: string }): string {
	const input = `tenant:${args.tenantId}|object:${args.objectId}|dataset:${args.datasetId}`;
	return createHash('sha256').update(input).digest('hex').slice(0, 16);
}

export type ResolvedUserIdentity =
	| { userId?: undefined; userKeyType?: undefined }
	| { userId: string; userKeyType: BackendUserIdentityMode };

/**
 * Resolves the effective user identity for backend sync operations.
 * Implements privacy model with multiple sharing modes: personal, team alias,
 * Entra object ID, and pseudonymous. All identifiers are validated before use.
 * 
 * @param args - Configuration for identity resolution
 * @returns Resolved identity with userId and keyType, or empty object if no user dimension
 */
export function resolveUserIdentityForSync(args: {
	shareWithTeam: boolean;
	userIdentityMode: BackendUserIdentityMode;
	configuredUserId: string;
	datasetId: string;
	accessTokenForClaims?: string;
}): ResolvedUserIdentity {
	if (!args.shareWithTeam) {
		return {};
	}

	if (args.userIdentityMode === 'teamAlias') {
		const res = validateTeamAlias(args.configuredUserId);
		if (!res.valid) {
			return {};
		}
		return { userId: res.alias, userKeyType: 'teamAlias' };
	}

	if (args.userIdentityMode === 'entraObjectId') {
		const id = (args.configuredUserId ?? '').trim();
		// Keep it strict: objectId should be a GUID.
		if (!/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(id)) {
			return {};
		}
		return { userId: id, userKeyType: 'entraObjectId' };
	}

	const claims = tryParseJwtClaims(args.accessTokenForClaims ?? '');
	if (!claims.tenantId || !claims.objectId) {
		return {};
	}
	const userId = derivePseudonymousUserKey({ tenantId: claims.tenantId, objectId: claims.objectId, datasetId: args.datasetId });
	return { userId, userKeyType: 'pseudonymous' };
}
