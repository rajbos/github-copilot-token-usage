/**
 * The CLI's inputs to the shared Usage Analysis payload builder
 * (`buildUsageAnalysisViewData()` in src/usageAnalysisViewBuilder.ts), used by the
 * `usage-analysis` and `all` commands and by the desktop app.
 *
 * `calculateUsageAnalysisStats()` covers the per-session analysis; the fields gathered
 * here come from outside the session logs — the workspaces' customization files and the
 * MCP servers and skills on disk — and are filled in the way the extension fills them,
 * from whatever this host can read.
 */
import type { UsageAnalysisStats } from '../../src/types';
import { buildCurationAnalysis, buildMcpEntriesFromJson, discoverSkillEntries } from '../../src/toolCuration';
import type { WorkspaceCustomization } from '../../src/customizationMatrix';
import type { UsageAnalysisViewInputs } from '../../src/usageAnalysisViewBuilder';
import { createTranslator } from '../../vscode-extension/src/l10nCore';
import { buildWorkspaceCustomizationForSessions } from './helpers';

/** Look-back window for tool curation; the extension's `curation.timeWindowDays` default. */
export const CURATION_WINDOW_DAYS = 30;

export interface UsageAnalysisViewStatsOptions {
	/**
	 * Folders whose `.vscode/mcp.json` and skill directories count as available tools. The
	 * CLI passes the current directory; the desktop app has no workspace and passes none,
	 * leaving the user-level skills.
	 */
	workspaceFolderPaths: string[];
	/** Already computed for these sessions (the `all` command also scores it); built when absent. */
	customization?: WorkspaceCustomization;
}

/** `stats` with the customization matrix, missed potential and tool curation filled in. */
export async function withUsageAnalysisViewStats(
	sessionFiles: string[],
	stats: UsageAnalysisStats,
	options: UsageAnalysisViewStatsOptions,
): Promise<UsageAnalysisStats> {
	const customization = options.customization ?? await buildWorkspaceCustomizationForSessions(sessionFiles);
	const curationAnalysis = buildCurationAnalysis({
		mcpJson: buildMcpEntriesFromJson(options.workspaceFolderPaths),
		skills: discoverSkillEntries(options.workspaceFolderPaths),
	}, stats.last30Days, CURATION_WINDOW_DAYS);
	return {
		...stats,
		customizationMatrix: customization?.customizationMatrix,
		missedPotential: customization?.missedPotential ?? [],
		curationAnalysis,
	};
}

/**
 * Settings of a host without VS Code's: no backend, no persisted insight state (every
 * applicable insight is `new`), no Dark Factory readiness checks, no open workspace.
 */
export function standaloneUsageAnalysisViewInputs(locale: string, language: string = locale): UsageAnalysisViewInputs {
	return {
		locale,
		backendConfigured: false,
		readinessAvailable: false,
		currentWorkspacePaths: [],
		// The extension setting's default; the view also treats a missing value as true.
		hideAutomaticToolCalls: true,
		use24HourTime: false,
		suppressedUnknownTools: [],
		insights: { translate: createTranslator(language) },
	};
}
