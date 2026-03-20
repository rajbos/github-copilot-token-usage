/**
 * `fluency` command - Show Copilot Fluency Score based on usage patterns.
 */
import { Command } from 'commander';
import chalk from 'chalk';
import { discoverSessionFiles, calculateUsageAnalysisStats, fmt } from '../helpers';
import { calculateMaturityScores } from '../../../src/maturityScoring';

export const fluencyCommand = new Command('fluency')
	.description('Show your Copilot Fluency Score and improvement tips')
	.option('-t, --tips', 'Show improvement tips for each category')
	.action(async (options) => {
		console.log(chalk.bold.cyan('\n🎯 Copilot Token Tracker - Fluency Score\n'));

		process.stdout.write(chalk.dim('Scanning for session files...'));
		const files = await discoverSessionFiles();
		process.stdout.write('\r' + ' '.repeat(50) + '\r');

		if (files.length === 0) {
			console.log(chalk.yellow('⚠️  No session files found.'));
			return;
		}

		process.stdout.write(chalk.dim('Analyzing usage patterns...'));

		// Calculate usage analysis stats
		const usageStats = await calculateUsageAnalysisStats(files);
		process.stdout.write('\r' + ' '.repeat(50) + '\r');

		// Calculate maturity scores
		const scores = await calculateMaturityScores(
			undefined,
			async () => usageStats,
			false
		);

		// Overall score
		const stageColors: Record<number, typeof chalk.red> = {
			1: chalk.red,
			2: chalk.yellow,
			3: chalk.blue,
			4: chalk.green,
		};

		const stageBar = (stage: number): string => {
			const filled = '█'.repeat(stage);
			const empty = '░'.repeat(4 - stage);
			return filled + empty;
		};

		console.log(chalk.bold('Overall Fluency Score'));
		console.log(chalk.dim('─'.repeat(55)));

		const colorFn = stageColors[scores.overallStage] || chalk.white;
		console.log(`  ${colorFn(stageBar(scores.overallStage))} ${chalk.bold(scores.overallLabel)}`);
		console.log();

		// Category breakdown
		console.log(chalk.bold('Category Breakdown'));
		console.log(chalk.dim('─'.repeat(55)));

		for (const cat of scores.categories) {
			const catColor = stageColors[cat.stage] || chalk.white;
			console.log(`  ${cat.icon} ${chalk.bold(cat.category)}`);
			console.log(`     ${catColor(stageBar(cat.stage))} Stage ${cat.stage}/4`);

			// Evidence
			if (cat.evidence.length > 0) {
				const evidenceToShow = cat.evidence.slice(0, 3);
				for (const ev of evidenceToShow) {
					console.log(chalk.dim(`     ✓ ${ev}`));
				}
				if (cat.evidence.length > 3) {
					console.log(chalk.dim(`     ... and ${cat.evidence.length - 3} more`));
				}
			}

			// Tips
			if (cat.tips.length > 0 && cat.stage < 4) {
				console.log(chalk.yellow(`     💡 Tips:`));
				for (const tip of cat.tips.slice(0, 2)) {
					// Strip markdown links for cleaner CLI output
					const cleanTip = tip.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/\[▶ [^\]]+\]\([^)]+\)/g, '').trim();
					console.log(chalk.yellow(`        → ${cleanTip}`));
				}
			}

			console.log();
		}

		// Summary stats
		const p = scores.period;
		console.log(chalk.bold('📊 Analysis Period (Last 30 Days)'));
		console.log(chalk.dim('─'.repeat(55)));
		console.log(`  Sessions analyzed:       ${chalk.bold(fmt(p.sessions))}`);

		const totalInteractions = p.modeUsage.ask + p.modeUsage.edit + p.modeUsage.agent;
		console.log(`  Total interactions:      ${chalk.bold(fmt(totalInteractions))}`);

		if (p.modeUsage.ask > 0) {
			console.log(`    Ask mode:              ${fmt(p.modeUsage.ask)}`);
		}
		if (p.modeUsage.edit > 0) {
			console.log(`    Edit mode:             ${fmt(p.modeUsage.edit)}`);
		}
		if (p.modeUsage.agent > 0) {
			console.log(`    Agent mode:            ${fmt(p.modeUsage.agent)}`);
		}
		if (p.toolCalls.total > 0) {
			console.log(`  Tool calls:              ${fmt(p.toolCalls.total)}`);
		}
		if (p.mcpTools.total > 0) {
			console.log(`  MCP tool calls:          ${fmt(p.mcpTools.total)}`);
		}

		const totalContextRefs = p.contextReferences.file + p.contextReferences.selection +
			p.contextReferences.codebase + p.contextReferences.workspace +
			p.contextReferences.terminal + p.contextReferences.vscode;
		if (totalContextRefs > 0) {
			console.log(`  Context references:      ${fmt(totalContextRefs)}`);
		}

		console.log();
		console.log(chalk.dim(`Last updated: ${scores.lastUpdated}\n`));
	});
