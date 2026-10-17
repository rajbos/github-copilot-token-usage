#!/usr/bin/env node

/**
 * Example: Load and analyze token usage data from Azure Storage
 * 
 * This example demonstrates how to use the azure-storage-loader skill
 * to fetch data and perform basic analysis.
 * 
 * Prerequisites:
 * - Azure Storage account with token usage data
 * - Azure credentials configured (az login or env vars)
 * - Node.js and npm installed
 * 
 * Usage:
 *   node example-usage.js <storage-account-name> <start-date> <end-date>
 * 
 * Example:
 *   node example-usage.js mycopilotusage 2026-01-01 2026-01-31
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { sumCounts } = require('./load-table-data.js');

// Parse command line arguments
const args = process.argv.slice(2);
if (args.length < 3) {
	console.error('Usage: node example-usage.js <storage-account> <start-date> <end-date>');
	console.error('Example: node example-usage.js mycopilotusage 2026-01-01 2026-01-31');
	process.exit(1);
}

const [storageAccount, startDate, endDate] = args;

// Validate CLI args before they reach a subprocess call — Azure storage account
// names are 3-24 lowercase alphanumeric characters, and dates must be ISO
// (YYYY-MM-DD). Rejecting anything else prevents shell metacharacters or
// other unexpected content from influencing the command that gets run.
const STORAGE_ACCOUNT_PATTERN = /^[a-z0-9]{3,24}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
if (!STORAGE_ACCOUNT_PATTERN.test(storageAccount)) {
	console.error(`Error: invalid storage account name "${storageAccount}" (expected 3-24 lowercase letters/digits)`);
	process.exit(1);
}
if (!DATE_PATTERN.test(startDate) || !DATE_PATTERN.test(endDate)) {
	console.error('Error: start-date and end-date must be in YYYY-MM-DD format');
	process.exit(1);
}

console.log('Azure Storage Loader - Example Usage');
console.log('=====================================\n');

// Step 1: Load data from Azure Storage
console.log('Step 1: Loading data from Azure Storage...');
console.log(`  Storage Account: ${storageAccount}`);
console.log(`  Date Range: ${startDate} to ${endDate}\n`);

// Use a freshly created, collision-resistant temp directory rather than a
// predictably-named file directly in the shared OS temp dir.
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-data-'));
const tempFile = path.join(tempDir, 'usage-data.json');

try {
	execFileSync(
		'node',
		['load-table-data.js', '--storageAccount', storageAccount, '--startDate', startDate, '--endDate', endDate, '--output', tempFile],
		{ stdio: 'inherit' }
	);

	// Step 2: Load and parse the data
	console.log('\nStep 2: Analyzing data...\n');
	const data = JSON.parse(fs.readFileSync(tempFile, 'utf8'));

	// Step 3: Perform analysis
	console.log('=== Summary Report ===\n');

	// Exact totals: sumCounts adds with BigInt, so many large per-row counts
	// cannot overflow Number precision (see load-table-data.js).
	const totals = sumCounts(data);

	console.log(`Total Records: ${data.length}`);
	console.log(`Total Input Tokens: ${totals.inputTokens.toLocaleString()}`);
	console.log(`Total Output Tokens: ${totals.outputTokens.toLocaleString()}`);
	console.log(`Total Tokens: ${totals.totalTokens.toLocaleString()}`);
	console.log(`Total Interactions: ${totals.interactions.toLocaleString()}`);

	// Group rows by a key and return [key, exact totals] sorted by total tokens
	const groupTotals = (keyOf) => {
		const groups = new Map();
		for (const item of data) {
			const key = keyOf(item);
			if (!groups.has(key)) {
				groups.set(key, []);
			}
			groups.get(key).push(item);
		}
		return [...groups.entries()]
			.map(([key, items]) => [key, sumCounts(items), items[0]])
			.sort((a, b) => (b[1].totalTokens > a[1].totalTokens ? 1 : b[1].totalTokens < a[1].totalTokens ? -1 : 0));
	};

	// Group by model
	console.log('\n=== Usage by Model ===\n');
	groupTotals(item => item.model || 'unknown').forEach(([model, stats]) => {
		console.log(`${model}:`);
		console.log(`  Input: ${stats.inputTokens.toLocaleString()}`);
		console.log(`  Output: ${stats.outputTokens.toLocaleString()}`);
		console.log(`  Total: ${stats.totalTokens.toLocaleString()}`);
		console.log(`  Interactions: ${stats.interactions.toLocaleString()}`);
		console.log('');
	});

	// Group by day
	console.log('=== Usage by Day (Top 5) ===\n');
	groupTotals(item => item.day || 'unknown')
		.slice(0, 5)
		.forEach(([day, stats]) => {
			console.log(`${day}: ${stats.totalTokens.toLocaleString()} tokens, ${stats.interactions.toLocaleString()} interactions`);
		});

	// Group by workspace (if available)
	const workspaces = [...new Set(data.map(item => item.workspaceId).filter(Boolean))];
	if (workspaces.length > 1) {
		console.log('\n=== Usage by Workspace (Top 5) ===\n');
		groupTotals(item => item.workspaceId || 'unknown')
			.slice(0, 5)
			.forEach(([wsId, stats, first]) => {
				const name = first.workspaceName || wsId;
				console.log(`${name}: ${stats.totalTokens.toLocaleString()} tokens, ${stats.interactions.toLocaleString()} interactions`);
			});
	}

	// Clean up temp file/dir
	fs.unlinkSync(tempFile);
	fs.rmdirSync(tempDir);

	console.log('\n✅ Analysis complete!\n');
	console.log('Next steps:');
	console.log('- Use the raw JSON data for custom analysis');
	console.log('- Filter by specific models: --model "gpt-4o"');
	console.log('- Filter by workspace: --workspaceId "workspace123"');
	console.log('- Export to CSV: --format csv --output usage.csv');
	console.log('\nSee SKILL.md for more examples and documentation.');

} catch (error) {
	console.error('\nError:', error.message);
	// Clean up temp file/dir if they exist
	if (fs.existsSync(tempFile)) {
		fs.unlinkSync(tempFile);
	}
	if (fs.existsSync(tempDir)) {
		fs.rmdirSync(tempDir);
	}
	process.exit(1);
}
