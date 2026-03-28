/**
 * `all` command - Output all view data in a single JSON response.
 * Used by the Visual Studio extension to load every view in one CLI call
 * instead of spawning four separate processes.
 */
import * as fs from 'fs';
import * as path from 'path';
import { Command } from 'commander';
import {
	discoverSessionFiles,
	calculateDetailedStats,
	calculateDailyStats,
	buildChartPayload,
	calculateUsageAnalysisStats,
} from '../helpers';
import { calculateMaturityScores } from '../../../vscode-extension/src/maturityScoring';
import type { WorkspaceCustomizationMatrix } from '../../../vscode-extension/src/types';

/**
 * Builds a WorkspaceCustomizationMatrix by deriving workspace folder paths from
 * VS Code-style session file paths (workspaceStorage/<hash>/chatSessions/<file>),
 * then checking each workspace for .github/copilot-instructions.md or agents.md.
 *
 * Non-VS Code session files (Crush, OpenCode, Copilot CLI, Visual Studio) are skipped.
 */
async function buildCustomizationMatrix(sessionFiles: string[]): Promise<WorkspaceCustomizationMatrix | undefined> {
	const workspacePaths = new Set<string>();

	for (const sessionFile of sessionFiles) {
		// Expected structure: .../workspaceStorage/<hash>/chatSessions/<file>
		const chatSessionsDir = path.dirname(sessionFile);
		if (path.basename(chatSessionsDir) !== 'chatSessions') { continue; }
		const hashDir = path.dirname(chatSessionsDir);
		const workspaceJsonPath = path.join(hashDir, 'workspace.json');

		try {
			if (!fs.existsSync(workspaceJsonPath)) { continue; }
			const content = JSON.parse(await fs.promises.readFile(workspaceJsonPath, 'utf-8'));
			const folderUri: string | undefined = content.folder;
			if (!folderUri || !folderUri.startsWith('file://')) { continue; }

			// Convert file URI to a local path, handling Windows drive letters
			let folderPath = decodeURIComponent(folderUri.replace(/^file:\/\//, ''));
			// On Windows, file:///C:/... becomes /C:/... — strip the leading slash
			if (/^\/[A-Za-z]:/.test(folderPath)) { folderPath = folderPath.slice(1); }
			workspacePaths.add(folderPath);
		} catch {
			// Skip unreadable workspace.json files
		}
	}

	if (workspacePaths.size === 0) { return undefined; }

	let workspacesWithIssues = 0;
	for (const wsPath of workspacePaths) {
		try {
			const hasInstructions = fs.existsSync(path.join(wsPath, '.github', 'copilot-instructions.md'));
			const hasAgentsMd    = fs.existsSync(path.join(wsPath, 'agents.md'));
			if (!hasInstructions && !hasAgentsMd) { workspacesWithIssues++; }
		} catch {
			workspacesWithIssues++; // Count inaccessible workspaces as lacking customization
		}
	}

	return {
		customizationTypes: [],
		workspaces: [],
		totalWorkspaces: workspacePaths.size,
		workspacesWithIssues,
	};
}

export const allCommand = new Command('all')
	.description('Output all view data in a single JSON response (for Visual Studio extension)')
	.option('--json', 'Output raw JSON (required)')
	.action(async (options) => {
		if (!options.json) {
			process.stderr.write('Use --json flag for all data output\n');
			return;
		}

		const now = new Date();
		const files = await discoverSessionFiles();

		if (files.length === 0) {
			const empty = {
				details: {
					today: {}, month: {}, lastMonth: {}, last30Days: {},
					lastUpdated: now.toISOString(), backendConfigured: false,
				},
				chart: {
					labels: [], tokensData: [], sessionsData: [], modelDatasets: [],
					editorDatasets: [], editorTotalsMap: {}, repositoryDatasets: [],
					repositoryTotalsMap: {}, dailyCount: 0, totalTokens: 0,
					avgTokensPerDay: 0, totalSessions: 0,
					lastUpdated: now.toISOString(), backendConfigured: false,
				},
				usage: {
					today: {}, last30Days: {}, month: {},
					locale: Intl.DateTimeFormat().resolvedOptions().locale,
					lastUpdated: now.toISOString(), backendConfigured: false,
				},
				fluency: {},
			};
			process.stdout.write(JSON.stringify(empty));
			return;
		}

		// Run the three independent stat computations in parallel.
		// The in-memory CLI session cache means each file is only parsed once even
		// though all three functions iterate the same session file list.
		const [detailedStats, { labels, days }, usageStats] = await Promise.all([
			calculateDetailedStats(files),
			calculateDailyStats(files),
			calculateUsageAnalysisStats(files),
		]);

		// Build chart payload from daily stats
		const chartPayload = buildChartPayload(labels, days);

		// Build details payload (mirrors the `usage --json` output)
		const detailsPayload = {
			today:      detailedStats.today,
			month:      detailedStats.month,
			lastMonth:  detailedStats.lastMonth,
			last30Days: detailedStats.last30Days,
			lastUpdated: detailedStats.lastUpdated.toISOString(),
			backendConfigured: false,
		};

		// Build usage-analysis payload (mirrors the `usage-analysis --json` output)
		const usagePayload = {
			...usageStats,
			locale: Intl.DateTimeFormat().resolvedOptions().locale,
			lastUpdated: now.toISOString(),
			backendConfigured: false,
		};

		// Build fluency/maturity payload (mirrors the `fluency --json` output)
		const customizationMatrix = await buildCustomizationMatrix(files);
		const scores = await calculateMaturityScores(
			customizationMatrix,
			async () => usageStats,
			false
		);
		const fluencyPayload = {
			overallStage: scores.overallStage,
			overallLabel: scores.overallLabel,
			categories:   scores.categories,
			period:       scores.period,
			lastUpdated:  scores.lastUpdated,
			backendConfigured: false,
		};

		const payload = {
			details: detailsPayload,
			chart:   chartPayload,
			usage:   usagePayload,
			fluency: fluencyPayload,
		};

		process.stdout.write(JSON.stringify(payload));
	});
