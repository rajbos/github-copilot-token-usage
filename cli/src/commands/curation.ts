/**
 * `curation` command — Tool curation analysis for the CLI.
 *
 * Compares configured MCP servers + discovered skills against the tools
 * actually used in session logs to surface unused context overhead.
 *
 * Unlike the VS Code extension the CLI has no access to `vscode.lm.tools`
 * at runtime, so "available tools" are derived from:
 *   - `.vscode/mcp.json` in the current working directory
 *   - `.github/skills` skill directories in the current working directory
 */
import { Command } from 'commander';
import * as path from 'path';
import { discoverSessionFiles, calculateUsageAnalysisStats } from '../helpers';
import { shouldOutputJson } from '../commandUtils';
import { createEmptyUsageAnalysisPeriod } from '../analysis';
import {
	buildMcpEntriesFromJson,
	discoverSkillEntries,
	analyzeToolCuration,
	mergeAvailableToolEntries,
} from '../../../src/toolCuration';
import type { ToolCurationAnalysis } from '../../../src/types';

// Default look-back window in days.
const DEFAULT_WINDOW_DAYS = 30;

export const curationCommand = new Command('curation')
	.description('Analyse tool curation: compare available MCP servers and skills against actual usage')
	.option('--json', 'Output raw JSON (for machine consumption)')
	.option('--window <days>', `Look-back window in days (default: ${DEFAULT_WINDOW_DAYS})`, String(DEFAULT_WINDOW_DAYS))
	.action(async (options) => {
		const windowDays = Math.max(1, parseInt(options.window ?? String(DEFAULT_WINDOW_DAYS), 10) || DEFAULT_WINDOW_DAYS);
		const cwd = process.cwd();

		const files = await discoverSessionFiles();
		const usageStats = files.length > 0 ? await calculateUsageAnalysisStats(files) : null;
		const last30Days = usageStats?.last30Days;

		// Build available tools from file-system sources only (no vscode.lm.tools).
		const workspaceFolderPaths = [cwd];
		const availableTools = mergeAvailableToolEntries({
			mcpJson: buildMcpEntriesFromJson(workspaceFolderPaths),
			skills: discoverSkillEntries(workspaceFolderPaths),
		});

		if (availableTools.length === 0 && !last30Days) {
			if (shouldOutputJson(options)) {
				process.stdout.write(JSON.stringify(createEmptyCurationPayload(windowDays)));
			} else {
				process.stderr.write('No MCP servers or skills found in the current directory, and no session data available.\n');
			}
			return;
		}

		const analysis = analyzeToolCuration(availableTools, last30Days ?? createEmptyUsageAnalysisPeriod(), windowDays);

		if (shouldOutputJson(options)) {
			process.stdout.write(JSON.stringify(createCurationPayload(analysis)));
		} else {
			printCurationReport(analysis);
		}
	});

// ---------------------------------------------------------------------------
// Payload helpers (used by the `all` command too)
// ---------------------------------------------------------------------------

export function createEmptyCurationPayload(windowDays = DEFAULT_WINDOW_DAYS): ToolCurationAnalysis {
	return {
		windowDays,
		availableTools: [],
		usedTools: [],
		unusedTools: [],
		underusedMcpServers: [],
		underusedAgentPlugins: [],
		estimatedPromptBloat: { totalTokens: 0, byServer: {} },
		recommendations: [],
	};
}

export function createCurationPayload(analysis: ToolCurationAnalysis): ToolCurationAnalysis {
	return analysis;
}

// ---------------------------------------------------------------------------
// Plain-text output
// ---------------------------------------------------------------------------

function printCurationReport(analysis: ToolCurationAnalysis): void {
	const { availableTools, usedTools, unusedTools, underusedMcpServers, estimatedPromptBloat, recommendations, windowDays } = analysis;

	process.stdout.write(`\nTool Curation Report (last ${windowDays} days)\n`);
	process.stdout.write('='.repeat(50) + '\n\n');

	process.stdout.write(`Available tools: ${availableTools.length}\n`);
	process.stdout.write(`Used tools:      ${usedTools.length}\n`);
	process.stdout.write(`Unused tools:    ${unusedTools.length}\n`);
	if (estimatedPromptBloat.totalTokens > 0) {
		process.stdout.write(`Est. overhead:   ~${estimatedPromptBloat.totalTokens.toLocaleString()} tokens/interaction\n`);
	}
	process.stdout.write('\n');

	if (underusedMcpServers.length > 0) {
		const unused = underusedMcpServers.filter(s => s.usedToolCount === 0);
		if (unused.length > 0) {
			process.stdout.write('Unused MCP Servers:\n');
			for (const s of unused) {
				const overhead = estimatedPromptBloat.byServer[s.server];
				const note = overhead ? ` (~${overhead.toLocaleString()} tokens overhead)` : '';
				process.stdout.write(`  • ${s.server}${note}\n`);
			}
			process.stdout.write('\n');
		}
	}

	const unusedSkills = unusedTools.filter(t => t.source === 'skill');
	if (unusedSkills.length > 0) {
		process.stdout.write('Unused Skills:\n');
		for (const s of unusedSkills) {
			process.stdout.write(`  • ${s.name}\n`);
		}
		process.stdout.write('\n');
	}

	if (recommendations.length > 0) {
		process.stdout.write('Recommendations:\n');
		for (const r of recommendations) {
			const savings = r.estimatedTokenSavings ? ` (saves ~${r.estimatedTokenSavings.toLocaleString()} tokens/interaction)` : '';
			process.stdout.write(`  → ${r.reason}${savings}\n`);
		}
		process.stdout.write('\n');
	}

	if (usedTools.length > 0) {
		process.stdout.write(`Top Used Tools (last ${windowDays}d):\n`);
		for (const t of usedTools.slice(0, 10)) {
			process.stdout.write(`  ${String(t.count).padStart(5)}x  ${t.name}\n`);
		}
		process.stdout.write('\n');
	}
}
