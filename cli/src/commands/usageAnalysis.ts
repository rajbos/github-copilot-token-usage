/**
 * `usage-analysis` command - Output full usage analysis stats for the usage webview.
 */
import { Command } from 'commander';
import { discoverSessionFiles, calculateUsageAnalysisStats } from '../helpers';
import { shouldOutputJson } from '../commandUtils';
import { createEmptyUsageAnalysisPayload, createUsageAnalysisPayload } from './payloads';

export const usageAnalysisCommand = new Command('usage-analysis')
	.description('Output usage analysis stats for the usage analysis webview')
	.option('--json', 'Output raw JSON (for machine consumption)')
	.option('--repeated-tasks', 'Include the repeated-task (Skill Suggestions) report, which carries prompt text')
	.action(async (options) => {
		if (!shouldOutputJson(options)) {
			process.stderr.write('Use --json flag for usage analysis data output\n');
			return;
		}

		const files = await discoverSessionFiles();
		const now = new Date();
		if (files.length === 0) {
			process.stdout.write(JSON.stringify(createEmptyUsageAnalysisPayload(now)));
			return;
		}

		const stats = await calculateUsageAnalysisStats(files, { includeRepeatedTasks: Boolean(options.repeatedTasks) });
		const payload = createUsageAnalysisPayload(stats, now);
		process.stdout.write(JSON.stringify(payload));
	});
