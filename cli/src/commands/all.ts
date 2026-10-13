/**
 * `all` command - Output all view data in a single JSON response.
 * Used by the Visual Studio extension to load every view in one CLI call
 * instead of spawning four separate processes.
 */
import { Command } from 'commander';
import {
	discoverSessionFiles,
	calculateDetailedStats,
	calculateDailyStats,
	recentAnalysisCutoff,
	buildChartPayload,
	calculateUsageAnalysisStats,
	buildWorkspaceCustomizationForSessions,
} from '../helpers';
import { withUsageAnalysisViewStats } from '../usageAnalysisView';
import { calculateMaturityScores } from '../../../src/maturityScoring';
import { shouldOutputJson } from '../commandUtils';
import {
	createEmptyDetailsPayload,
	createEmptyChartPayload,
	createEmptyUsageAnalysisPayload,
	createEmptyFluencyPayload,
	createDetailsPayload,
	createUsageAnalysisPayload,
	createFluencyPayload,
} from './payloads';
import {
	createEmptyCurationPayload,
	createCurationPayload,
} from './curation';

export const allCommand = new Command('all')
	.description('Output all view data in a single JSON response (for Visual Studio extension)')
	.option('--json', 'Output raw JSON (required)')
	.action(async (options) => {
		if (!shouldOutputJson(options)) {
			process.stderr.write('Use --json flag for all data output\n');
			return;
		}

		const now = new Date();
		const files = await discoverSessionFiles();

		if (files.length === 0) {
			const empty = {
			details: createEmptyDetailsPayload(now),
				chart:   createEmptyChartPayload(now),
				usage:   createEmptyUsageAnalysisPayload(now),
				fluency: createEmptyFluencyPayload(),
				curation: createEmptyCurationPayload(),
			};
			process.stdout.write(JSON.stringify(empty));
			return;
		}

		// Run the three independent stat computations in parallel.
		// The in-memory CLI session cache means each file is only parsed once even
		// though all three functions iterate the same session file list.
		const [detailedStats, dailyStats, usageStats] = await Promise.all([
			calculateDetailedStats(files),
			// Enrichment only for the recent window Usage Analysis analyzes anyway: hosts such as
			// Visual Studio wait on this command with a timeout, and a full-history enrichment
			// walk would repeat on every run of a large history (the session cache is bounded).
			calculateDailyStats(files, false, { enrichSince: recentAnalysisCutoff() }),
			calculateUsageAnalysisStats(files),
		]);

		// Build chart payload from daily stats
		const chartPayload = buildChartPayload(dailyStats);

		// Build details payload (mirrors the `usage --json` output)
		const detailsPayload = createDetailsPayload(detailedStats);

		// Customization and curation (mcp.json + skills from cwd; no vscode.lm.tools in the CLI),
		// gathered once for the usage-analysis, fluency and curation payloads.
		const customization = await buildWorkspaceCustomizationForSessions(files);
		const viewStats = await withUsageAnalysisViewStats(files, usageStats, { workspaceFolderPaths: [process.cwd()], customization });

		// Build usage-analysis payload (mirrors the `usage-analysis --json` output)
		const usagePayload = createUsageAnalysisPayload(viewStats, now);

		// Build fluency/maturity payload (mirrors the `fluency --json` output)
		const scores = await calculateMaturityScores(
			customization?.customizationMatrix,
			async () => usageStats,
			false
		);
		const fluencyPayload = createFluencyPayload(scores);

		const curationPayload = viewStats.curationAnalysis
			? createCurationPayload(viewStats.curationAnalysis)
			: createEmptyCurationPayload();

		const payload = {
			details: detailsPayload,
			chart:   chartPayload,
			usage:   usagePayload,
			fluency: fluencyPayload,
			curation: curationPayload,
		};

		process.stdout.write(JSON.stringify(payload));
	});
