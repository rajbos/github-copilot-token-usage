/**
 * `stats` command - Show overview of discovered session files, sessions, and token counts.
 */
import { Command } from 'commander';
import chalk from 'chalk';
import { discoverSessionFiles, processSessionFile, getDiagnosticPaths, fmt, formatTokens, getCacheStats } from '../helpers';

export const statsCommand = new Command('stats')
	.description('Show overview of discovered session files, sessions, chat turns, and tokens')
	.option('-v, --verbose', 'Show detailed per-folder breakdown')
	.action(async (options) => {
		console.log(chalk.bold.cyan('\n🔍 Copilot Token Tracker - Session Statistics\n'));

		// Show search paths if verbose
		if (options.verbose) {
			const paths = getDiagnosticPaths();
			console.log(chalk.dim('Search paths:'));
			for (const p of paths) {
				const status = p.exists ? chalk.green('✅') : chalk.dim('❌');
				console.log(`  ${status} ${chalk.dim(p.source)}: ${p.path}`);
			}
			console.log();
		}

		// Discover session files
		process.stdout.write(chalk.dim('Scanning for session files...'));
		const files = await discoverSessionFiles();
		process.stdout.write('\r' + ' '.repeat(50) + '\r'); // Clear line

		if (files.length === 0) {
			console.log(chalk.yellow('⚠️  No session files found.'));
			console.log(chalk.dim('Have you used GitHub Copilot Chat in VS Code yet?'));
			return;
		}

		console.log(chalk.green(`📂 Found ${chalk.bold(fmt(files.length))} session file(s)\n`));

		// Process files and gather stats
		let totalTokens = 0;
		let totalThinkingTokens = 0;
		let totalInteractions = 0;
		let processedCount = 0;
		let emptyCount = 0;
		const editorCounts: { [editor: string]: { files: number; tokens: number; interactions: number } } = {};
		const folderCounts: { [folder: string]: { files: number; tokens: number } } = {};

		for (let i = 0; i < files.length; i++) {
			const data = await processSessionFile(files[i]);

			if (!data || data.tokens === 0) {
				emptyCount++;
				continue;
			}

			processedCount++;
			totalTokens += data.tokens;
			totalThinkingTokens += data.thinkingTokens;
			totalInteractions += data.interactions;

			// Track by editor
			if (!editorCounts[data.editorSource]) {
				editorCounts[data.editorSource] = { files: 0, tokens: 0, interactions: 0 };
			}
			editorCounts[data.editorSource].files++;
			editorCounts[data.editorSource].tokens += data.tokens;
			editorCounts[data.editorSource].interactions += data.interactions;

			// Track by parent folder
			if (options.verbose) {
				const folder = getDisplayFolder(files[i]);
				if (!folderCounts[folder]) {
					folderCounts[folder] = { files: 0, tokens: 0 };
				}
				folderCounts[folder].files++;
				folderCounts[folder].tokens += data.tokens;
			}

			// Progress indicator
			if ((i + 1) % 50 === 0 || i === files.length - 1) {
				process.stdout.write(`\r${chalk.dim(`Processing: ${i + 1}/${files.length}`)}`);
			}
		}
		process.stdout.write('\r' + ' '.repeat(50) + '\r'); // Clear progress line

		// Summary table
		console.log(chalk.bold('📊 Summary'));
		console.log(chalk.dim('─'.repeat(50)));
		console.log(`  Session files (with data):  ${chalk.bold(fmt(processedCount))}`);
		if (emptyCount > 0) {
			console.log(`  Empty/skipped files:        ${chalk.dim(fmt(emptyCount))}`);
		}
		console.log(`  Total chat turns:           ${chalk.bold(fmt(totalInteractions))}`);
		console.log(`  Total estimated tokens:     ${chalk.bold.yellow(formatTokens(totalTokens))}`);
		if (totalThinkingTokens > 0) {
			console.log(`  Thinking tokens (included): ${chalk.dim(formatTokens(totalThinkingTokens))}`);
		}
		const cacheInfo = getCacheStats();
		if (cacheInfo.enabled && cacheInfo.entries > 0) {
			console.log(chalk.dim(`  Cache: ${fmt(cacheInfo.entries)} entries loaded`));
		}
		console.log();

		// Editor breakdown
		const editors = Object.entries(editorCounts).sort((a, b) => b[1].tokens - a[1].tokens);
		if (editors.length > 0) {
			console.log(chalk.bold('🖥️  By Editor'));
			console.log(chalk.dim('─'.repeat(50)));
			for (const [editor, counts] of editors) {
				const editorName = getEditorDisplayName(editor);
				console.log(`  ${editorName.padEnd(25)} ${fmt(counts.files).padStart(5)} files  ${formatTokens(counts.tokens).padStart(8)} tokens  ${fmt(counts.interactions).padStart(6)} turns`);
			}
			console.log();
		}

		// Verbose: per-folder breakdown
		if (options.verbose && Object.keys(folderCounts).length > 0) {
			const folders = Object.entries(folderCounts).sort((a, b) => b[1].tokens - a[1].tokens);
			console.log(chalk.bold('📁 By Folder'));
			console.log(chalk.dim('─'.repeat(70)));
			for (const [folder, counts] of folders.slice(0, 20)) {
				console.log(`  ${folder.substring(0, 50).padEnd(50)} ${fmt(counts.files).padStart(5)} files  ${formatTokens(counts.tokens).padStart(8)} tokens`);
			}
			if (folders.length > 20) {
				console.log(chalk.dim(`  ... and ${folders.length - 20} more folders`));
			}
			console.log();
		}
	});

function getEditorDisplayName(source: string): string {
	const names: Record<string, string> = {
		'vscode': 'VS Code',
		'vscode-insiders': 'VS Code Insiders',
		'vscode-exploration': 'VS Code Exploration',
		'vscode-remote': 'VS Code Remote',
		'vscodium': 'VSCodium',
		'cursor': 'Cursor',
		'copilot-cli': 'Copilot CLI',
		'opencode': 'OpenCode',
		'claude-code': 'Claude Code',
	};
	return names[source] || source;
}

function getDisplayFolder(filePath: string): string {
	const parts = filePath.split(/[/\\]/);
	// Find the meaningful folder (e.g., workspaceStorage/<hash> or chatSessions)
	const chatIdx = parts.indexOf('chatSessions');
	if (chatIdx >= 2) {
		return parts.slice(chatIdx - 1, chatIdx + 1).join('/');
	}
	// Fall back to parent directory
	return parts.slice(-3, -1).join('/');
}
