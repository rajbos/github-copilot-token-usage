/**
 * `environmental` command - Show environmental impact of Copilot usage.
 */
import { Command } from 'commander';
import chalk from 'chalk';
import { discoverSessionFiles, calculateDetailedStats, formatTokens, ENVIRONMENTAL } from '../helpers';
import type { PeriodStats } from '../../../vscode-extension/src/types';

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
		console.log(chalk.dim(`  Tree absorption: ${formatCo2(ENVIRONMENTAL.CO2_ABSORPTION_PER_TREE_PER_YEAR)} CO₂/year\n`));

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

			// Driving comparison
			const drivingKm = co2 / ENVIRONMENTAL.CO2_PER_KM_DRIVING;
			console.log(`  🚗 Equivalent to driving:    ${drivingKm.toFixed(3)} km`);

			// Smartphone charges
			const phoneCharges = co2 / ENVIRONMENTAL.CO2_PER_PHONE_CHARGE;
			console.log(`  📱 Smartphone charges:        ${phoneCharges.toFixed(1)}`);

			// Cups of coffee water
			const coffeeCups = water / ENVIRONMENTAL.WATER_PER_COFFEE_CUP;
			console.log(`  ☕ Cups of coffee (water):     ${coffeeCups.toFixed(4)}`);

			// LED bulb hours
			const ledHours = co2 / ENVIRONMENTAL.CO2_PER_LED_HOUR;
			console.log(`  💡 LED bulb hours:            ${ledHours.toFixed(2)}`);

			console.log();
		}

		console.log(chalk.dim(`Last updated: ${stats.lastUpdated.toLocaleString()}\n`));
	});

/** Format CO₂ in grams, switching to kg notation when ≥ 1 000 g */
function formatCo2(grams: number): string {
	if (grams >= 1000) {
		return `${(grams / 1000).toFixed(2)} kgCO₂e`;
	}
	return `${grams.toFixed(3)} gCO₂e`;
}

function printEnvironmentalStats(label: string, emoji: string, stats: PeriodStats): void {
	console.log(chalk.bold(`${emoji} ${label}`));
	console.log(chalk.dim('─'.repeat(55)));

	if (stats.sessions === 0) {
		console.log(chalk.dim('  No activity in this period'));
		console.log();
		return;
	}

	console.log(`  Tokens used:          ${chalk.bold.yellow(formatTokens(stats.tokens))}`);
	console.log(`  CO₂ emissions:        ${chalk.bold(formatCo2(stats.co2))}`);
	console.log(`  Water usage:          ${chalk.bold(stats.waterUsage.toFixed(3))} liters`);

	if (stats.treesEquivalent > 0) {
		const treeStr = stats.treesEquivalent < 0.001
			? stats.treesEquivalent.toExponential(2)
			: stats.treesEquivalent.toFixed(6);
		console.log(`  Trees to offset:      ${chalk.green(treeStr)} trees/year`);
	}

	console.log();
}
