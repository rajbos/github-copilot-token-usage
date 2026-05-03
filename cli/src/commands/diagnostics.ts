/**
 * `diagnostics` command - Show where session files are searched, and stats per location.
 */
import { Command } from 'commander';
import chalk from 'chalk';
import * as path from 'path';
import { discoverSessionFiles, getDiagnosticPaths, processSessionFile, effectiveTokens, fmt, formatTokens } from '../helpers';

interface LocationStats {
	label: string;
	source: string;
	files: number;
	sessions: number;
	interactions: number;
	tokens: number;
}

/**
 * Map a session file path to the candidate search path it lives under.
 * Returns the matching candidate path, or 'unknown' if none match.
 */
function matchToCandidatePath(
	filePath: string,
	candidates: { path: string; exists: boolean; source: string }[]
): { path: string; source: string } | null {
	const normalized = filePath.replace(/\\/g, '/');
	// For OpenCode DB virtual paths, resolve to the db file path
	const effectivePath = normalized.includes('opencode.db#') ? normalized.split('#')[0] : normalized;

	// Try to find the deepest matching candidate
	let best: { path: string; source: string } | null = null;
	let bestLen = 0;
	for (const cand of candidates) {
		const candNorm = cand.path.replace(/\\/g, '/');
		if (effectivePath.startsWith(candNorm) && candNorm.length > bestLen) {
			best = { path: cand.path, source: cand.source };
			bestLen = candNorm.length;
		}
	}
	return best;
}

/** Truncate a path for display, keeping the last N segments */
function truncatePath(p: string, maxLen = 55): string {
	if (p.length <= maxLen) { return p; }
	const parts = p.replace(/\\/g, '/').split('/');
	let result = p;
	for (let keep = parts.length - 1; keep > 1; keep--) {
		result = '…/' + parts.slice(-keep).join('/');
		if (result.length <= maxLen) { break; }
	}
	return result;
}

/** Print a simple aligned table to stdout */
function printTable(headers: string[], rows: string[][], colWidths: number[]): void {
	const sep = chalk.dim('─'.repeat(colWidths.reduce((a, b) => a + b + 3, -1)));

	// Header
	const headerLine = headers.map((h, i) => chalk.bold(h.padEnd(colWidths[i]))).join(' │ ');
	console.log('  ' + headerLine);
	console.log('  ' + sep);

	// Rows
	for (const row of rows) {
		const line = row.map((cell, i) => {
			const padded = cell.padEnd(colWidths[i]);
			return i === 0 ? chalk.dim(padded) : padded;
		}).join(chalk.dim(' │ '));
		console.log('  ' + line);
	}
	console.log('  ' + sep);
}

export const diagnosticsCommand = new Command('diagnostics')
	.description('Show session file search locations and per-location usage stats')
	.action(async () => {
		console.log(chalk.bold.cyan('\n🔬 Copilot Token Tracker - Diagnostics\n'));

		// --- Search path candidates ---
		const candidates = getDiagnosticPaths();
		const existing = candidates.filter(c => c.exists);
		const missing = candidates.filter(c => !c.exists);

		console.log(chalk.bold(`📂 Search Locations  (${existing.length} found / ${candidates.length} total)`));
		console.log(chalk.dim('─'.repeat(65)));

		const pathHeaders = ['Source', 'Exists', 'Path'];
		const pathColWidths = [18, 6, 55];
		const pathRows = candidates.map(c => [
			c.source,
			c.exists ? chalk.green('yes') : chalk.dim('no'),
			truncatePath(c.path, 55),
		]);
		printTable(pathHeaders, pathRows, pathColWidths);
		console.log();

		if (existing.length === 0) {
			console.log(chalk.yellow('⚠️  No search paths exist on this machine.'));
			console.log(chalk.dim('Have you used GitHub Copilot Chat in VS Code yet?'));
			return;
		}

		// --- Discover and process files ---
		process.stdout.write(chalk.dim('Scanning for session files...'));
		const files = await discoverSessionFiles();
		process.stdout.write('\r' + ' '.repeat(60) + '\r');

		if (files.length === 0) {
			console.log(chalk.yellow('⚠️  No session files found in any search path.'));
			return;
		}

		// Accumulate stats per candidate path
		const locationMap = new Map<string, LocationStats>();

		// Seed all existing candidates so they appear even if no files matched
		for (const cand of existing) {
			locationMap.set(cand.path, {
				label: truncatePath(cand.path, 45),
				source: cand.source,
				files: 0,
				sessions: 0,
				interactions: 0,
				tokens: 0,
			});
		}

		let totalFiles = 0;
		let totalSessions = 0;
		let totalInteractions = 0;
		let totalTokens = 0;

		for (let i = 0; i < files.length; i++) {
			// Progress
			if ((i + 1) % 25 === 0 || i === files.length - 1) {
				process.stdout.write(`\r${chalk.dim(`Processing: ${i + 1}/${files.length} files...`)}`);
			}

			const match = matchToCandidatePath(files[i], candidates);
			const key = match ? match.path : '__unknown__';

			if (!locationMap.has(key)) {
				locationMap.set(key, {
					label: match ? truncatePath(match.path, 45) : '(unknown)',
					source: match ? match.source : 'unknown',
					files: 0,
					sessions: 0,
					interactions: 0,
					tokens: 0,
				});
			}

			const loc = locationMap.get(key)!;
			loc.files++;
			totalFiles++;

			const data = await processSessionFile(files[i]);
			if (data && data.tokens > 0) {
				loc.sessions++;
				loc.interactions += data.interactions;
				loc.tokens += effectiveTokens(data);
				totalSessions++;
				totalInteractions += data.interactions;
				totalTokens += effectiveTokens(data);
			}
		}

		process.stdout.write('\r' + ' '.repeat(60) + '\r');

		// --- Per-location table ---
		console.log(chalk.bold(`📊 Stats per Search Location`));
		console.log(chalk.dim('─'.repeat(65)));

		const statsHeaders = ['Source', 'Files', 'Sessions', 'Turns', 'Tokens'];
		const statsColWidths = [18, 6, 9, 8, 14];
		const statsRows: string[][] = [];

		// Sort by tokens desc, then by source name
		const sorted = [...locationMap.values()]
			.filter(l => l.files > 0)
			.sort((a, b) => b.tokens - a.tokens || a.source.localeCompare(b.source));

		for (const loc of sorted) {
			statsRows.push([
				loc.source,
				fmt(loc.files),
				fmt(loc.sessions),
				fmt(loc.interactions),
				formatTokens(loc.tokens),
			]);
		}

		if (statsRows.length === 0) {
			console.log(chalk.dim('  No session data found in any location.'));
		} else {
			printTable(statsHeaders, statsRows, statsColWidths);
		}

		// --- Totals ---
		console.log();
		console.log(chalk.bold('📈 Totals (all time)'));
		console.log(chalk.dim('─'.repeat(65)));
		console.log(`  Total files found:      ${chalk.bold(fmt(totalFiles))}`);
		console.log(`  Files with data:        ${chalk.bold(fmt(totalSessions))}`);
		console.log(`  Total chat turns:       ${chalk.bold(fmt(totalInteractions))}`);
		console.log(`  Total tokens:           ${chalk.bold.yellow(formatTokens(totalTokens))}`);

		if (missing.length > 0) {
			console.log();
			console.log(chalk.dim(`ℹ️  ${missing.length} search path(s) not present on this machine — this is normal if you don't use all VS Code variants.`));
		}

		console.log();
	});
