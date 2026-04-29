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
	buildChartPayload,
	calculateUsageAnalysisStats,
	buildCustomizationMatrix,
} from '../helpers';
import { calculateMaturityScores } from '../../../vscode-extension/src/maturityScoring';

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
