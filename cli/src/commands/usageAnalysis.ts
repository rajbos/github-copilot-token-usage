/**
 * `usage-analysis` command - Output full usage analysis stats for the usage webview.
 */
import { Command } from 'commander';
import { discoverSessionFiles, calculateUsageAnalysisStats } from '../helpers';
import { shouldOutputJson } from '../commandUtils';
import { createEmptyUsageAnalysisStats, createUsageAnalysisPayload } from './payloads';
import { withUsageAnalysisViewStats } from '../usageAnalysisView';

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
		// No session files still runs the shared view enrichment: the workspace's configured MCP
		// servers and skills belong in the curation analysis without any session data.
		const sessionStats = files.length === 0
			? createEmptyUsageAnalysisStats(now)
			: await calculateUsageAnalysisStats(files, { includeRepeatedTasks: Boolean(options.repeatedTasks) });
		const stats = await withUsageAnalysisViewStats(files, sessionStats, { workspaceFolderPaths: [process.cwd()] });
		const payload = createUsageAnalysisPayload(stats, now);
		process.stdout.write(JSON.stringify(payload));
	});
