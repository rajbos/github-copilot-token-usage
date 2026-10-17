/**
 * Pure data-sanitization helper for WorkspaceCustomizationMatrix objects received via postMessage.
 * Extracted into its own module (no DOM / CSS dependencies) so it can be unit-tested in Node.js.
 *
 * Types are imported directly from types.ts (the extension's canonical source), so any schema
 * change there will cause an immediate compile error here — preventing schema drift.
 */
import type { CustomizationTypeStatus, WorkspaceCustomizationMatrix, WorkspaceCustomizationRow } from '../../../../src/types';

// Re-export for consumers (tests etc.) so they don't need to depend on types.ts directly
export type { CustomizationTypeStatus, WorkspaceCustomizationMatrix as SanitizedCustomizationMatrix, WorkspaceCustomizationRow as SanitizedCustomizationRow } from '../../../../src/types';

const VALID_STATUSES = new Set<string>(['✅', '⚠️', '❌']);

function coerceStringArray(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) { return undefined; }
	const strings = value.filter((v): v is string => typeof v === 'string');
	return strings.length > 0 ? strings : undefined;
}

function coerceNumber(value: unknown): number {
	const n = Number(value);
	return Number.isFinite(n) ? n : 0;
}

/**
 * Sanitizes a raw (untrusted) customization matrix from postMessage.
 * Returns undefined when the input is not a valid object.
 */
export function sanitizeCustomizationMatrix(rawMatrix: unknown): WorkspaceCustomizationMatrix | undefined {
	if (!rawMatrix || typeof rawMatrix !== 'object') { return undefined; }
	const m = rawMatrix as Record<string, unknown>;

	const customizationTypes: WorkspaceCustomizationMatrix['customizationTypes'] = Array.isArray(m.customizationTypes)
		? (m.customizationTypes as unknown[])
			.filter((t): t is Record<string, unknown> => !!t && typeof t === 'object')
			.map(t => ({
				id: typeof t.id === 'string' ? t.id : '',
				icon: typeof t.icon === 'string' ? t.icon : '',
				label: typeof t.label === 'string' ? t.label : '',
			}))
			.filter(t => t.id !== '')
		: [];

	const workspaces: WorkspaceCustomizationRow[] = Array.isArray(m.workspaces)
		? (m.workspaces as unknown[])
			.filter((w): w is Record<string, unknown> => !!w && typeof w === 'object')
			.map(w => {
				const rawStatuses = (w.typeStatuses && typeof w.typeStatuses === 'object')
					? w.typeStatuses as Record<string, unknown>
					: {};
				const typeStatuses: { [typeId: string]: CustomizationTypeStatus } = {};
				for (const [key, val] of Object.entries(rawStatuses)) {
					typeStatuses[key] = VALID_STATUSES.has(val as string) ? (val as CustomizationTypeStatus) : '❌';
				}
				const memberPaths = coerceStringArray(w.memberPaths);
				return {
					workspacePath: typeof w.workspacePath === 'string' ? w.workspacePath : '',
					workspaceName: typeof w.workspaceName === 'string' ? w.workspaceName : '',
					sessionCount: coerceNumber(w.sessionCount),
					interactionCount: coerceNumber(w.interactionCount),
					typeStatuses,
					...(memberPaths ? { memberPaths } : {}),
				};
			})
		: [];

	const ungroupedWorkspaceNames = coerceStringArray(m.ungroupedWorkspaceNames);
	return {
		customizationTypes,
		workspaces,
		totalWorkspaces: coerceNumber(m.totalWorkspaces),
		workspacesWithIssues: coerceNumber(m.workspacesWithIssues),
		...(ungroupedWorkspaceNames ? { ungroupedWorkspaceNames } : {}),
	};
}
