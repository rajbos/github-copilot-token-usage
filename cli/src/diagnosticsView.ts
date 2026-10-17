/**
 * The CLI's inputs to the shared Diagnostics payload builder
 * (`buildDiagnosticsViewData()` in src/diagnosticsViewBuilder.ts), used by
 * `diagnostics --json`.
 *
 * Fields that are VS Code state (backend sync, globalState counters, Copilot quota,
 * budgets, per-editor skill counts) and the per-session detail table (the CLI has no
 * Diagnostics webview to feed) are passed as the builder's documented "not available in
 * this host" values, never omitted.
 */
import * as fs from 'fs';
import * as os from 'os';
import type { UsageAnalysisStats } from '../../src/types';
import { buildCacheInfo, buildDiagnosticsViewData, buildSessionFolderData } from '../../src/diagnosticsViewBuilder';
import type { DiagnosticsViewData } from '../../src/diagnosticsViewBuilder';
import { mergeToolFamilies } from '../../src/toolFamilies';
import { getEcosystems } from './sessionProcessing';
import { getCacheStats, getSessionBackingPath } from './helpers';

/** Same preview size the extension's Diagnostics session table starts with. */
const SESSION_FILE_PREVIEW_LIMIT = 20;

export async function createDiagnosticsPayload(
	sessionFiles: string[],
	usageStats: UsageAnalysisStats | null,
	report: string,
	diagnosticPaths: { path: string; exists: boolean; source: string }[],
): Promise<DiagnosticsViewData & { diagnosticPaths: { path: string; exists: boolean; source: string }[] }> {
	const preview: { file: string; size: number; modified: string }[] = [];
	for (const file of sessionFiles.slice(0, SESSION_FILE_PREVIEW_LIMIT)) {
		try {
			// Stat the backing file: DB-backed sessions use virtual paths.
			const s = await fs.promises.stat(getSessionBackingPath(file));
			preview.push({ file, size: s.size, modified: s.mtime.toISOString() });
		} catch {
			// Skip inaccessible files, as the extension does.
		}
	}
	const cache = getCacheStats();
	return {
		...buildDiagnosticsViewData({
			report,
			sessionFiles: preview,
			detailedSessionFiles: [],
			sessionFolders: buildSessionFolderData(sessionFiles, {
				findEcosystem: f => getEcosystems().find(e => e.handles(f)) ?? null,
				homeDir: os.homedir(),
			}),
			cacheInfo: buildCacheInfo(cache.entries, 0, 'CLI session cache', null),
			backendStorageInfo: null,
			backendConfigured: false,
			isDebugMode: false,
			globalStateCounters: { openCount: 0, unknownMcpOpenCount: 0, fluencyBannerDismissed: false, unknownMcpDismissedVersion: '' },
			displaySettings: { showTokens: true, showCost: true, monthlyBudget: 0 },
			quotaEntitlements: null,
			accountBudgets: [],
			usageStats,
			skillCallsByEditor: null,
			toolFamilies: mergeToolFamilies([]),
		}),
		diagnosticPaths,
	};
}
