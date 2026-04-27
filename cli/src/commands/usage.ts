/**
 * `usage` command - Show token usage for today, current month, and last 30 days.
 */
import { Command } from 'commander';
import chalk from 'chalk';
import { discoverSessionFiles, calculateDetailedStats, fmt, formatTokens, modelPricing } from '../helpers';
import type { PeriodStats, ModelUsage } from '../../../vscode-extension/src/types';
import { getModelTier } from '../../../vscode-extension/src/tokenEstimation';

export const usageCommand = new Command('usage')
	.description('Show token usage for today, current month, last month, and last 30 days')
	.option('-m, --models', 'Show per-model token breakdown')
	.option('-c, --cost', 'Show estimated cost breakdown')
	.option('--json', 'Output raw JSON (for machine consumption)')
	.action(async (options) => {
		const files = await discoverFiles(options);
		if (!files) { return; }

		const stats = await calculateStats(files, options);

		if (options.json) {
			// Machine-readable output: emit pure JSON to stdout and exit
			const payload = {
				today: stats.today,
				month: stats.month,
				lastMonth: stats.lastMonth,
				last30Days: stats.last30Days,
				lastUpdated: stats.lastUpdated.toISOString(),
				backendConfigured: false,
			};
			process.stdout.write(JSON.stringify(payload));
			return;
		}

		// Human-readable output
		console.log(chalk.bold.cyan('\n📊 Copilot Token Tracker - Usage Report\n'));

		const periods: { label: string; emoji: string; stats: PeriodStats }[] = [
			{ label: 'Today', emoji: '📅', stats: stats.today },
			{ label: 'This Month', emoji: '📆', stats: stats.month },
			{ label: 'Last Month', emoji: '🗓️', stats: stats.lastMonth },
			{ label: 'Last 30 Days', emoji: '📈', stats: stats.last30Days },
		];

		for (const period of periods) {
			printPeriodStats(period.label, period.emoji, period.stats, options);
		}

		console.log(chalk.dim(`Last updated: ${stats.lastUpdated.toLocaleString()}\n`));
	});

/** Discover session files (quiet when --json is set). */
async function discoverFiles(options: { json?: boolean }) {
	if (!options.json) {
		process.stdout.write(chalk.dim('Scanning for session files...'));
	}
	const files = await discoverSessionFiles();
	if (!options.json) {
		process.stdout.write('\r' + ' '.repeat(50) + '\r');
	}
	if (files.length === 0) {
		if (options.json) {
			process.stdout.write('{}');
		} else {
			console.log(chalk.yellow('⚠️  No session files found.'));
		}
		return null;
	}
	return files;
}

/** Calculate detailed stats (quiet when --json is set). */
async function calculateStats(files: string[], options: { json?: boolean }) {
	if (!options.json) {
		process.stdout.write(chalk.dim('Calculating token usage...'));
	}
	const stats = await calculateDetailedStats(files, options.json ? undefined : (completed, total) => {
		process.stdout.write(`\r${chalk.dim(`Processing: ${completed}/${total} files`)}`);
	});
	if (!options.json) {
		process.stdout.write('\r' + ' '.repeat(50) + '\r');
	}
	return stats;
}

function printPeriodStats(
	label: string,
	emoji: string,
	stats: PeriodStats,
	options: { models?: boolean; cost?: boolean }
): void {
	console.log(chalk.bold(`${emoji} ${label}`));
	console.log(chalk.dim('─'.repeat(55)));

	if (stats.sessions === 0) {
		console.log(chalk.dim('  No activity in this period'));
		console.log();
		return;
	}

	console.log(`  Sessions:              ${chalk.bold(fmt(stats.sessions))}`);
	console.log(`  Avg interactions/sess: ${chalk.bold(stats.avgInteractionsPerSession.toFixed(1))}`);
	console.log(`  Total tokens:          ${chalk.bold.yellow(formatTokens(stats.tokens))}`);
	if (stats.thinkingTokens > 0) {
		console.log(`  Thinking tokens:       ${chalk.dim(formatTokens(stats.thinkingTokens))} (included in total)`);
	}
	console.log(`  Avg tokens/session:    ${chalk.bold(formatTokens(stats.avgTokensPerSession))}`);

	if (options.cost && stats.estimatedCost > 0) {
		console.log(`  Estimated cost (est.): ${chalk.green('$' + stats.estimatedCost.toFixed(4))}  ${chalk.dim('(provider API rates)')}`);
		if ((stats.estimatedCostCopilot ?? 0) > 0) {
			console.log(`  Estimated cost (TBB):  ${chalk.green('$' + (stats.estimatedCostCopilot ?? 0).toFixed(4))}  ${chalk.dim('(Copilot AI Credits)')}`);
		}
	}

	// Model breakdown
	if (options.models && Object.keys(stats.modelUsage).length > 0) {
		console.log();
		console.log(chalk.dim('  Model Breakdown:'));
		const models = Object.entries(stats.modelUsage)
			.sort((a, b) => (b[1].inputTokens + b[1].outputTokens) - (a[1].inputTokens + a[1].outputTokens));

		for (const [model, usage] of models) {
			const total = usage.inputTokens + usage.outputTokens;
			const tier = getModelTier(model, modelPricing);
			const tierBadge = tier === 'premium'
				? chalk.yellow(' ⭐')
				: tier === 'standard'
					? chalk.dim(' ○')
					: '';
			console.log(`    ${(model + tierBadge).padEnd(35)} ${formatTokens(usage.inputTokens).padStart(8)} in  ${formatTokens(usage.outputTokens).padStart(8)} out  ${formatTokens(total).padStart(8)} total`);
		}
	}

	// Editor breakdown
	if (Object.keys(stats.editorUsage).length > 1) {
		console.log();
		console.log(chalk.dim('  Editor Breakdown:'));
		const editors = Object.entries(stats.editorUsage)
			.sort((a, b) => b[1].tokens - a[1].tokens);
		for (const [editor, usage] of editors) {
			console.log(`    ${editor.padEnd(25)} ${fmt(usage.sessions).padStart(5)} sessions  ${formatTokens(usage.tokens).padStart(8)} tokens`);
		}
	}

	console.log();
}
