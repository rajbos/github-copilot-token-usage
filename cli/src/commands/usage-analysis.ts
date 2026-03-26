/**
 * `usage-analysis` command - Output full usage analysis stats for the usage webview.
 */
import { Command } from 'commander';
import { discoverSessionFiles, calculateUsageAnalysisStats } from '../helpers';

export const usageAnalysisCommand = new Command('usage-analysis')
	.description('Output usage analysis stats for the usage analysis webview')
	.option('--json', 'Output raw JSON (for machine consumption)')
	.action(async (options) => {
		if (!options.json) {
			process.stderr.write('Use --json flag for usage analysis data output\n');
			return;
		}

		const files = await discoverSessionFiles();
		const now = new Date();
		if (files.length === 0) {
			process.stdout.write(JSON.stringify({
				today: {}, last30Days: {}, month: {},
				locale: Intl.DateTimeFormat().resolvedOptions().locale,
				lastUpdated: now.toISOString(),
				backendConfigured: false,
			}));
			return;
		}

		const stats = await calculateUsageAnalysisStats(files);
		const payload = {
			...stats,
			locale: Intl.DateTimeFormat().resolvedOptions().locale,
			lastUpdated: now.toISOString(),
			backendConfigured: false,
		};
		process.stdout.write(JSON.stringify(payload));
	});
