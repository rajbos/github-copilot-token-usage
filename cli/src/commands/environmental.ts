/**
 * `environmental` command - Show environmental impact of Copilot usage.
 */
import { Command } from 'commander';
import chalk from 'chalk';
import { discoverSessionFiles, calculateDetailedStats, fmt, formatTokens, ENVIRONMENTAL } from '../helpers';
import type { PeriodStats } from '../../../src/types';

export const environmentalCommand = new Command('environmental')
	.alias('env')
	.description('Show environmental impact of your Copilot usage (CO2, water, trees)')
	.action(async () => {
		console.log(chalk.bold.cyan('\n🌍 Copilot Token Tracker - Environmental Impact\n'));

		process.stdout.write(chalk.dim('Scanning for session files...'));
		const files = await discoverSessionFiles();
		process.stdout.write('\r' + ' '.repeat(50) + '\r');

		if (files.length === 0) {
			console.log(chalk.yellow('⚠️  No session files found.'));
			return;
		}

		process.stdout.write(chalk.dim('Calculating usage...'));
		const stats = await calculateDetailedStats(files, (completed, total) => {
			process.stdout.write(`\r${chalk.dim(`Processing: ${completed}/${total} files`)}`);
		});
		process.stdout.write('\r' + ' '.repeat(50) + '\r');

		const periods: { label: string; emoji: string; stats: PeriodStats }[] = [
			{ label: 'Today', emoji: '📅', stats: stats.today },
			{ label: 'This Month', emoji: '📆', stats: stats.month },
			{ label: 'Last Month', emoji: '🗓️', stats: stats.lastMonth },
			{ label: 'Last 30 Days', emoji: '📈', stats: stats.last30Days },
		];

		// Environmental impact methodology
		console.log(chalk.dim('Methodology: Estimates based on industry averages for AI inference'));
		console.log(chalk.dim(`  CO₂: ${ENVIRONMENTAL.CO2_PER_1K_TOKENS} gCO₂e per 1K tokens`));
		console.log(chalk.dim(`  Water: ${ENVIRONMENTAL.WATER_USAGE_PER_1K_TOKENS} L per 1K tokens`));
		console.log(chalk.dim(`  Tree absorption: ${fmt(ENVIRONMENTAL.CO2_ABSORPTION_PER_TREE_PER_YEAR)} g CO₂/year\n`));

		for (const period of periods) {
			printEnvironmentalStats(period.label, period.emoji, period.stats);
		}

		// Context comparisons for last 30 days
		const last30 = stats.last30Days;
		if (last30.tokens > 0) {
			console.log(chalk.bold('🔄 Context Comparisons (Last 30 Days)'));
			console.log(chalk.dim('─'.repeat(55)));

			const co2 = last30.co2;
			const water = last30.waterUsage;

			// Driving comparison: ~120g CO2 per km for average car
			const drivingKm = co2 / 120;
			console.log(`  🚗 Equivalent to driving:    ${drivingKm.toFixed(3)} km`);

			// Smartphone charges: ~8.22g CO2 per full charge
			const phoneCharges = co2 / 8.22;
			console.log(`  📱 Smartphone charges:        ${phoneCharges.toFixed(1)}`);

			// Cups of coffee water: ~140 liters per cup
			const coffeeCups = water / 140;
			console.log(`  ☕ Cups of coffee (water):     ${coffeeCups.toFixed(4)}`);

			// LED bulb hours: ~20g CO2 per hour for 10W LED
			const ledHours = co2 / 20;
			console.log(`  💡 LED bulb hours:            ${ledHours.toFixed(2)}`);

			console.log();
		}

		console.log(chalk.dim(`Last updated: ${stats.lastUpdated.toLocaleString()}\n`));
	});

function printEnvironmentalStats(label: string, emoji: string, stats: PeriodStats): void {
	console.log(chalk.bold(`${emoji} ${label}`));
	console.log(chalk.dim('─'.repeat(55)));

	if (stats.sessions === 0) {
		console.log(chalk.dim('  No activity in this period'));
		console.log();
		return;
	}

	console.log(`  Tokens used:          ${chalk.bold.yellow(formatTokens(stats.tokens))}`);
	console.log(`  CO₂ emissions:        ${chalk.bold(stats.co2.toFixed(3))} gCO₂e`);
	console.log(`  Water usage:          ${chalk.bold(stats.waterUsage.toFixed(3))} liters`);

	if (stats.treesEquivalent > 0) {
		const treeStr = stats.treesEquivalent < 0.001
			? stats.treesEquivalent.toExponential(2)
			: stats.treesEquivalent.toFixed(6);
		console.log(`  Trees to offset:      ${chalk.green(treeStr)} trees/year`);
	}

	console.log();
}
