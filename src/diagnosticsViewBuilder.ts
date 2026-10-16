/**
 * Assembles the Diagnostics view's payload (`window.__INITIAL_DIAGNOSTICS__`) from
 * inputs the host has already gathered.
 *
 * This is the one place that payload is built: the VS Code extension and the desktop
 * app both call {@link buildDiagnosticsViewData}. They differ only in how they gather
 * the inputs (the extension reads VS Code state, the desktop app reads the CLI's
 * session walk) and in host settings. A field the host cannot produce is passed as its
 * explicit "not available in this host" value (see {@link DiagnosticsViewInputs}), never
 * left out, so the view always reads the same shape (see #2304, #2316, #2418).
 *
 * The pure helpers the hosts used to carry copies of live here too:
 * {@link buildSessionFolderData}, {@link buildCacheInfo}, {@link diagnosticsToolCallStats}.
 *
 * No `vscode`, no filesystem, no caching.
 */
import * as path from 'path';
import type { IEcosystemAdapter } from './ecosystemAdapter';
import { getEcosystemDisplayName } from './ecosystemAdapter';
import { getEditorNameFromRoot } from './workspaceHelpers';
import type { UsageAnalysisStats } from './types';

/** One row of the Diagnostics "session folders" table. */
export interface SessionFolderEntry {
	dir: string;
	count: number;
	editorName: string;
}

/** The cache summary cards on the Diagnostics Cache tab. */
export interface DiagnosticsCacheInfo {
	size: number;
	sizeInMB: number;
	lastUpdated: string | null;
	location: string;
	storagePath: string | null;
}

export type DiagnosticsToolCallStats = UsageAnalysisStats['last30Days']['toolCalls'];

/** Host inputs for {@link buildSessionFolderData}. */
export interface SessionFolderDeps {
	/** The adapter that owns a session path, or null for plain VS Code Copilot Chat files. */
	findEcosystem: (sessionFile: string) => IEcosystemAdapter | null;
	/** The user's home directory; Copilot CLI session-state folders are collapsed to one row. */
	homeDir: string;
}

/**
 * Groups session files by the editor root folder that holds them, counting files per
 * folder and naming the editor each folder belongs to.
 */
export function buildSessionFolderData(sessionFiles: string[], deps: SessionFolderDeps): SessionFolderEntry[] {
	const dirCounts = new Map<string, number>();
	const dirEditorNames = new Map<string, string>();
	const copilotSessionStateDir = path.join(deps.homeDir, '.copilot', 'session-state');
	for (const file of sessionFiles) {
		const eco = deps.findEcosystem(file);
		if (eco) {
			const editorRoot = eco.getEditorRoot(file);
			dirCounts.set(editorRoot, (dirCounts.get(editorRoot) || 0) + 1);
			dirEditorNames.set(editorRoot, getEcosystemDisplayName(eco, file));
			continue;
		}
		const parts = file.split(/[\\/]/);
		const userIdx = parts.findIndex(p => p.toLowerCase() === 'user');
		let editorRoot = userIdx > 0
			? path.join(...parts.slice(0, Math.min(parts.length, userIdx + 2)))
			: path.dirname(file);
		if (editorRoot.startsWith(copilotSessionStateDir) && editorRoot !== copilotSessionStateDir) {
			editorRoot = copilotSessionStateDir;
		}
		dirCounts.set(editorRoot, (dirCounts.get(editorRoot) || 0) + 1);
	}
	return Array.from(dirCounts.entries()).map(([dir, count]) => ({
		dir, count, editorName: dirEditorNames.get(dir) || getEditorNameFromRoot(dir),
	}));
}

/** Cache summary: `lastUpdated` is only reported when the cache holds entries. */
export function buildCacheInfo(entries: number, sizeInMB: number, location: string, storagePath: string | null, now = new Date()): DiagnosticsCacheInfo {
	return {
		size: entries,
		sizeInMB,
		lastUpdated: entries > 0 ? now.toISOString() : null,
		location,
		storagePath,
	};
}

/** Tool-call totals for the Tool Analysis tab: the last-30-days period, or null without stats. */
export function diagnosticsToolCallStats(stats: UsageAnalysisStats | null | undefined): DiagnosticsToolCallStats | null {
	return stats?.last30Days?.toolCalls ?? null;
}

/** Skill invocation totals for the Skill Usage tab: the last-30-days period, or null without stats. */
export function diagnosticsSkillCallStats(stats: UsageAnalysisStats | null | undefined): UsageAnalysisStats['last30Days']['skillCalls'] | null {
	return stats?.last30Days?.skillCalls ?? null;
}

/** Skill name -> description from the curation analysis' discovered skills. */
export function skillDescriptionsFromStats(stats: UsageAnalysisStats | null | undefined): Record<string, string> {
	const descriptions: Record<string, string> = {};
	for (const t of stats?.curationAnalysis?.availableTools ?? []) {
		if (t.source === 'skill' && t.description) { descriptions[t.name] = t.description; }
	}
	return descriptions;
}

/**
 * Everything a host passes to {@link buildDiagnosticsViewData}. Fields marked "host
 * state" exist only where the host has the state; other hosts pass the documented
 * empty value.
 */
export interface DiagnosticsViewInputs {
	report: string;
	sessionFiles: { file: string; size: number; modified: string }[];
	detailedSessionFiles: unknown[];
	sessionFolders: SessionFolderEntry[];
	cacheInfo: DiagnosticsCacheInfo;
	/** Host state: Azure backend sync info. null where no backend exists (the desktop app). */
	backendStorageInfo: unknown | null;
	backendConfigured: boolean;
	isDebugMode: boolean;
	/** Host state: VS Code globalState counters. Other hosts pass zero/false/''. */
	globalStateCounters: {
		openCount: number;
		unknownMcpOpenCount: number;
		fluencyBannerDismissed: boolean;
		unknownMcpDismissedVersion: string;
		efficiencyTabBannerDismissed?: boolean;
	};
	displaySettings: { showTokens: unknown; showCost: unknown; monthlyBudget: number };
	/** Host state: Copilot quota from the signed-in GitHub account. null elsewhere. */
	quotaEntitlements: unknown | null;
	/** Host state: per-account budgets. Empty list elsewhere. */
	accountBudgets: unknown[];
	/** The host's usage-analysis stats; drives tool, skill and skill-description fields. */
	usageStats: UsageAnalysisStats | null | undefined;
	/** Host state: per-skill, per-editor counts. null where only the extension tracks them. */
	skillCallsByEditor: Record<string, Record<string, number>> | null;
	/** Extra skill descriptions the host can resolve (workspace SKILL.md files, built-ins). */
	extraSkillDescriptions?: Record<string, string>;
	toolFamilies: unknown[];
}

export interface DiagnosticsViewData {
	report: string;
	sessionFiles: DiagnosticsViewInputs['sessionFiles'];
	detailedSessionFiles: unknown[];
	sessionFolders: SessionFolderEntry[];
	cacheInfo: DiagnosticsCacheInfo;
	backendStorageInfo: unknown | null;
	backendConfigured: boolean;
	isDebugMode: boolean;
	globalStateCounters: DiagnosticsViewInputs['globalStateCounters'];
	displaySettings: DiagnosticsViewInputs['displaySettings'];
	quotaEntitlements: unknown | null;
	accountBudgets: unknown[];
	toolCallStats: DiagnosticsToolCallStats | null;
	skillCallStats: UsageAnalysisStats['last30Days']['skillCalls'] | null;
	skillCallsByEditor: Record<string, Record<string, number>> | null;
	skillDescriptions: Record<string, string>;
	toolFamilies: unknown[];
}

/** Every key {@link buildDiagnosticsViewData} emits; tests pin hosts against it. */
export const DIAGNOSTICS_VIEW_KEYS: ReadonlyArray<keyof DiagnosticsViewData> = [
	'report', 'sessionFiles', 'detailedSessionFiles', 'sessionFolders', 'cacheInfo',
	'backendStorageInfo', 'backendConfigured', 'isDebugMode', 'globalStateCounters',
	'displaySettings', 'quotaEntitlements', 'accountBudgets', 'toolCallStats', 'skillCallStats',
	'skillCallsByEditor', 'skillDescriptions', 'toolFamilies',
];

export function buildDiagnosticsViewData(inputs: DiagnosticsViewInputs): DiagnosticsViewData {
	return {
		report: inputs.report,
		sessionFiles: inputs.sessionFiles,
		detailedSessionFiles: inputs.detailedSessionFiles,
		sessionFolders: inputs.sessionFolders,
		cacheInfo: inputs.cacheInfo,
		backendStorageInfo: inputs.backendStorageInfo,
		backendConfigured: inputs.backendConfigured,
		isDebugMode: inputs.isDebugMode,
		globalStateCounters: inputs.globalStateCounters,
		displaySettings: inputs.displaySettings,
		quotaEntitlements: inputs.quotaEntitlements,
		accountBudgets: inputs.accountBudgets,
		toolCallStats: diagnosticsToolCallStats(inputs.usageStats),
		skillCallStats: diagnosticsSkillCallStats(inputs.usageStats),
		skillCallsByEditor: inputs.skillCallsByEditor,
		skillDescriptions: { ...skillDescriptionsFromStats(inputs.usageStats), ...inputs.extraSkillDescriptions },
		toolFamilies: inputs.toolFamilies,
	};
}
