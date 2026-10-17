/**
 * `chart` command - Output pre-computed chart data (daily token usage for the last 30 days).
 */
import { Command } from 'commander';
import chalk from 'chalk';
import { discoverSessionFiles, calculateDailyStats, recentAnalysisCutoff, buildChartPayload, fmt } from '../helpers';
import { shouldOutputJson } from '../commandUtils';
import { createEmptyChartPayload } from './payloads';

export const chartCommand = new Command('chart')
	.description('Output daily token usage data for the chart webview')
	.option('--json', 'Output raw JSON (for machine consumption)')
	.option('-v, --verbose', 'Show debug log discovery details')
	.action(async (options) => {
		const files = await discoverSessionFiles();
		if (files.length === 0) {
			if (shouldOutputJson(options)) {
				process.stdout.write(JSON.stringify(createEmptyChartPayload()));
			} else {
				console.log(chalk.yellow('⚠️  No session files found.'));
			}
			return;
		}

		const verbose = options.verbose === true;
		// Bounded like `all`: hosts call this too, and enriching the whole history on every run
		// is the slow path. See DailyStatsOptions.enrichSince.
		const payload = buildChartPayload(await calculateDailyStats(files, verbose, { enrichSince: recentAnalysisCutoff() }));

		if (shouldOutputJson(options)) {
			process.stdout.write(JSON.stringify(payload));
			return;
		}

		// Human-readable output
		console.log(chalk.bold.cyan('\n📊 Token Usage Summary\n'));

		// The shared payload's periods reach back to the earliest session (for the webview's
		// "All time" window); the summary shows the recent window each heading names.
		const periodNames = [
			{ key: 'day', label: 'Daily (last 30 days)', recent: 30 },
			{ key: 'week', label: 'Weekly (last 6 weeks)', recent: 6 },
			{ key: 'month', label: 'Monthly (last 12 months)', recent: 12 },
		] as const;

		for (const { key, label, recent } of periodNames) {
			const period = payload.periods[key];
			const labels = period.labels.slice(-recent);
			const tokensData = period.tokensData.slice(-recent);
			const costData = period.costData.slice(-recent);

			console.log(chalk.bold(label));
			console.log(chalk.dim('─'.repeat(60)));

			const rows = labels.map((periodLabel, idx) => ({
				Period: periodLabel,
				Tokens: fmt(tokensData[idx] ?? 0),
				Cost: `$${(costData[idx] ?? 0).toFixed(2)}`,
			}));

			// Print table
			if (rows.length > 0) {
				console.table(rows);
			}

			// Print totals
			const totalTokens = tokensData.reduce((a, b) => a + b, 0);
			const totalCost = costData.reduce((a, b) => a + b, 0);
			const periodCount = labels.length;
			const avgTokens = periodCount > 0 ? Math.round(totalTokens / periodCount) : 0;
			const avgCost = periodCount > 0 ? totalCost / periodCount : 0;

			console.log(chalk.bold('Totals:'));
			console.log(`  Total Tokens: ${fmt(totalTokens)}`);
			console.log(`  Total Cost:   $${totalCost.toFixed(2)}`);
			console.log(`  Avg per Period: ${fmt(avgTokens)} tokens, $${avgCost.toFixed(2)} cost`);
			console.log();
		}
	});
