/**
 * `usage` command - Show token usage for today, current month, and last 30 days.
 */
import { Command } from 'commander';
import chalk from 'chalk';
import { discoverSessionFiles, calculateDetailedStats, fmt, formatTokens, modelPricing } from '../helpers';
import type { PeriodStats, ModelUsage } from '../../../src/types';
import { getModelTier } from '../../../src/tokenEstimation';

export const usageCommand = new Command('usage')
	.description('Show token usage for today, current month, last month, and last 30 days')
	.option('-m, --models', 'Show per-model token breakdown')
	.option('-c, --cost', 'Show estimated cost breakdown')
	.action(async (options) => {
		console.log(chalk.bold.cyan('\n📊 Copilot Token Tracker - Usage Report\n'));

		process.stdout.write(chalk.dim('Scanning for session files...'));
		const files = await discoverSessionFiles();
		process.stdout.write('\r' + ' '.repeat(50) + '\r');

		if (files.length === 0) {
			console.log(chalk.yellow('⚠️  No session files found.'));
			return;
		}

		process.stdout.write(chalk.dim('Calculating token usage...'));
		const stats = await calculateDetailedStats(files, (completed, total) => {
			process.stdout.write(`\r${chalk.dim(`Processing: ${completed}/${total} files`)}`);
		});
		process.stdout.write('\r' + ' '.repeat(50) + '\r');

		// Display each period
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
		console.log(`  Estimated cost:        ${chalk.green('$' + stats.estimatedCost.toFixed(4))}`);
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
