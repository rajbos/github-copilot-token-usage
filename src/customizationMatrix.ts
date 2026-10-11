/**
 * Assembles the Usage Analysis view's `customizationMatrix` and `missedPotential` from
 * already-gathered inputs: the grouped workspaces a host saw sessions in, and the
 * customization files it found for each.
 *
 * This is the one place those two payload fields are built. The VS Code extension, the
 * CLI and the desktop app (through the CLI's collectors) all call
 * {@link buildWorkspaceCustomization}; they differ only in how they gather the inputs —
 * the extension runs the full customization-pattern scan on worker threads, the CLI
 * probes the instruction files only so a host waiting on it with a timeout is not held
 * up by a recursive directory walk.
 *
 * Pure: no `vscode`, no filesystem.
 */
import customizationPatternsData from './customizationPatterns.json';
import type {
	CustomizationFileEntry,
	CustomizationTypeStatus,
	MissedPotentialWorkspace,
	WorkspaceCustomizationMatrix,
	WorkspaceCustomizationRow,
} from './types';
import { detectArtefactWorkspaceNames, groupFolders, workspaceBasename, type WorkspaceGroup } from './workspaceGrouping';

/** A customization type the matrix has a column for. */
export interface CustomizationType {
	id: string;
	icon: string;
	label: string;
}

/** A resolved workspace the host saw sessions in; `group` when grouping ran. */
export interface CustomizationWorkspaceInput {
	path: string;
	sessionCount: number;
	interactionCount: number;
	group?: WorkspaceGroup;
}

export interface WorkspaceCustomizationInputs {
	/** The matrix columns: {@link copilotCustomizationTypes} unless the host checks fewer types. */
	customizationTypes: CustomizationType[];
	workspaces: CustomizationWorkspaceInput[];
	/** Customization files found for a workspace (merged across its group); undefined when not scanned. */
	filesFor(workspacePath: string): CustomizationFileEntry[] | undefined;
	/**
	 * VS Code workspace-storage ids whose folder could not be resolved, with their
	 * interaction counts. They get a row each, counted as an issue.
	 */
	unresolvedWorkspaces?: Map<string, number>;
}

export interface WorkspaceCustomization {
	customizationMatrix: WorkspaceCustomizationMatrix;
	missedPotential: MissedPotentialWorkspace[];
}

/** Characters of an unresolved workspace id shown in its row name. */
export const WORKSPACE_ID_DISPLAY_LENGTH = 8;

/** The Copilot customization types in customizationPatterns.json, one column each. */
export function copilotCustomizationTypes(): CustomizationType[] {
	const unique = new Map<string, CustomizationType>();
	for (const pattern of (customizationPatternsData as { patterns?: Array<{ type: string; category?: string; icon?: string; label?: string }> }).patterns ?? []) {
		if (pattern.category && pattern.category !== 'copilot') { continue; }
		if (!unique.has(pattern.type)) {
			unique.set(pattern.type, { id: pattern.type, icon: pattern.icon || '', label: pattern.label || pattern.type });
		}
	}
	return [...unique.values()];
}

function typeStatusesFor(files: CustomizationFileEntry[], types: CustomizationType[]): { [typeId: string]: CustomizationTypeStatus } {
	const statuses: { [typeId: string]: CustomizationTypeStatus } = {};
	for (const type of types) {
		const ofType = files.filter(f => f.type === type.id);
		statuses[type.id] = ofType.length === 0 ? '❌' : ofType.some(f => f.isStale) ? '⚠️' : '✅';
	}
	return statuses;
}

function resolvedRow(ws: CustomizationWorkspaceInput, files: CustomizationFileEntry[], types: CustomizationType[]): WorkspaceCustomizationRow {
	const folders = ws.group ? groupFolders(ws.group) : [];
	return {
		workspacePath: ws.path,
		workspaceName: ws.group?.displayName ?? workspaceBasename(ws.path),
		sessionCount: ws.sessionCount,
		interactionCount: ws.interactionCount,
		typeStatuses: typeStatusesFor(files, types),
		...(folders.length > 1 ? { memberPaths: folders } : {}),
	};
}

function unresolvedRow(workspaceId: string, interactionCount: number, types: CustomizationType[]): WorkspaceCustomizationRow {
	const displayId = workspaceId.length > WORKSPACE_ID_DISPLAY_LENGTH
		? `${workspaceId.substring(0, WORKSPACE_ID_DISPLAY_LENGTH)}...`
		: workspaceId;
	return {
		workspacePath: `<unresolved:${workspaceId}>`,
		workspaceName: `Unresolved (${displayId})`,
		sessionCount: 0,
		interactionCount,
		typeStatuses: typeStatusesFor([], types),
	};
}

/**
 * Missed potential: a workspace with non-Copilot customization files (Cursor rules,
 * GEMINI.md, …) and no Copilot ones. Entries without a category predate it and count as Copilot.
 */
function missedPotentialFor(ws: CustomizationWorkspaceInput, files: CustomizationFileEntry[]): MissedPotentialWorkspace | undefined {
	const nonCopilotFiles = files.filter(f => f.category === 'non-copilot');
	if (nonCopilotFiles.length === 0 || files.some(f => !f.category || f.category === 'copilot')) { return undefined; }
	return {
		workspacePath: ws.path,
		workspaceName: ws.group?.displayName ?? workspaceBasename(ws.path),
		sessionCount: ws.sessionCount,
		interactionCount: ws.interactionCount,
		nonCopilotFiles,
	};
}

/**
 * The customization matrix (busiest workspace first) and the missed-potential list (most
 * interactions first). A workspace counts as an issue when it has none of the types.
 */
export function buildWorkspaceCustomization(inputs: WorkspaceCustomizationInputs): WorkspaceCustomization {
	const types = inputs.customizationTypes;
	const rows: WorkspaceCustomizationRow[] = [];
	const missedPotential: MissedPotentialWorkspace[] = [];
	for (const ws of inputs.workspaces) {
		const files = inputs.filesFor(ws.path) ?? [];
		rows.push(resolvedRow(ws, files, types));
		const missed = missedPotentialFor(ws, files);
		if (missed) { missedPotential.push(missed); }
	}
	for (const [workspaceId, interactions] of inputs.unresolvedWorkspaces ?? []) {
		rows.push(unresolvedRow(workspaceId, interactions, types));
	}
	const workspacesWithIssues = rows.filter(r => types.every(t => r.typeStatuses[t.id] === '❌')).length;
	rows.sort((a, b) => b.interactionCount !== a.interactionCount ? b.interactionCount - a.interactionCount : b.sessionCount - a.sessionCount);
	missedPotential.sort((a, b) => b.interactionCount - a.interactionCount);
	const groups = inputs.workspaces.flatMap(ws => ws.group ? [ws.group] : []);
	const artefactNames = detectArtefactWorkspaceNames(groups);
	return {
		customizationMatrix: {
			customizationTypes: types,
			workspaces: rows,
			totalWorkspaces: rows.length,
			workspacesWithIssues,
			...(artefactNames.length > 0 ? { ungroupedWorkspaceNames: artefactNames.map(a => a.displayName) } : {}),
		},
		missedPotential,
	};
}
