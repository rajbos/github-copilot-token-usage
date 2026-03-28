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

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Parse command line arguments
const args = process.argv.slice(2);
if (args.length < 3) {
	console.error('Usage: node example-usage.js <storage-account> <start-date> <end-date>');
	console.error('Example: node example-usage.js mycopilotusage 2026-01-01 2026-01-31');
	process.exit(1);
}

const [storageAccount, startDate, endDate] = args;

console.log('Azure Storage Loader - Example Usage');
console.log('=====================================\n');

// Step 1: Load data from Azure Storage
console.log('Step 1: Loading data from Azure Storage...');
console.log(`  Storage Account: ${storageAccount}`);
console.log(`  Date Range: ${startDate} to ${endDate}\n`);

const tempFile = path.join(os.tmpdir(), `usage-data-${Date.now()}.json`);

try {
	execSync(
		`node load-table-data.js --storageAccount ${storageAccount} --startDate ${startDate} --endDate ${endDate} --output ${tempFile}`,
		{ stdio: 'inherit' }
	);

	// Step 2: Load and parse the data
	console.log('\nStep 2: Analyzing data...\n');
	const data = JSON.parse(fs.readFileSync(tempFile, 'utf8'));

	// Step 3: Perform analysis
	console.log('=== Summary Report ===\n');

	// Total tokens
	const totals = data.reduce(
		(acc, item) => {
			acc.inputTokens += item.inputTokens || 0;
			acc.outputTokens += item.outputTokens || 0;
			acc.interactions += item.interactions || 0;
			return acc;
		},
		{ inputTokens: 0, outputTokens: 0, interactions: 0 }
	);

	console.log(`Total Records: ${data.length}`);
	console.log(`Total Input Tokens: ${totals.inputTokens.toLocaleString()}`);
	console.log(`Total Output Tokens: ${totals.outputTokens.toLocaleString()}`);
	console.log(`Total Tokens: ${(totals.inputTokens + totals.outputTokens).toLocaleString()}`);
	console.log(`Total Interactions: ${totals.interactions.toLocaleString()}`);

	// Group by model
	console.log('\n=== Usage by Model ===\n');
	const byModel = {};
	data.forEach(item => {
		const model = item.model || 'unknown';
		if (!byModel[model]) {
			byModel[model] = { inputTokens: 0, outputTokens: 0, interactions: 0 };
		}
		byModel[model].inputTokens += item.inputTokens || 0;
		byModel[model].outputTokens += item.outputTokens || 0;
		byModel[model].interactions += item.interactions || 0;
	});

	Object.entries(byModel)
		.sort((a, b) => (b[1].inputTokens + b[1].outputTokens) - (a[1].inputTokens + a[1].outputTokens))
		.forEach(([model, stats]) => {
			const totalTokens = stats.inputTokens + stats.outputTokens;
			console.log(`${model}:`);
			console.log(`  Input: ${stats.inputTokens.toLocaleString()}`);
			console.log(`  Output: ${stats.outputTokens.toLocaleString()}`);
			console.log(`  Total: ${totalTokens.toLocaleString()}`);
			console.log(`  Interactions: ${stats.interactions.toLocaleString()}`);
			console.log('');
		});

	// Group by day
	console.log('=== Usage by Day (Top 5) ===\n');
	const byDay = {};
	data.forEach(item => {
		const day = item.day || 'unknown';
		if (!byDay[day]) {
			byDay[day] = { inputTokens: 0, outputTokens: 0, interactions: 0 };
		}
		byDay[day].inputTokens += item.inputTokens || 0;
		byDay[day].outputTokens += item.outputTokens || 0;
		byDay[day].interactions += item.interactions || 0;
	});

	Object.entries(byDay)
		.sort((a, b) => (b[1].inputTokens + b[1].outputTokens) - (a[1].inputTokens + a[1].outputTokens))
		.slice(0, 5)
		.forEach(([day, stats]) => {
			const totalTokens = stats.inputTokens + stats.outputTokens;
			console.log(`${day}: ${totalTokens.toLocaleString()} tokens, ${stats.interactions.toLocaleString()} interactions`);
		});

	// Group by workspace (if available)
	const workspaces = [...new Set(data.map(item => item.workspaceId).filter(Boolean))];
	if (workspaces.length > 1) {
		console.log('\n=== Usage by Workspace (Top 5) ===\n');
		const byWorkspace = {};
		data.forEach(item => {
			const ws = item.workspaceId || 'unknown';
			const wsName = item.workspaceName || ws;
			if (!byWorkspace[ws]) {
				byWorkspace[ws] = { name: wsName, inputTokens: 0, outputTokens: 0, interactions: 0 };
			}
			byWorkspace[ws].inputTokens += item.inputTokens || 0;
			byWorkspace[ws].outputTokens += item.outputTokens || 0;
			byWorkspace[ws].interactions += item.interactions || 0;
		});

		Object.entries(byWorkspace)
			.sort((a, b) => (b[1].inputTokens + b[1].outputTokens) - (a[1].inputTokens + a[1].outputTokens))
			.slice(0, 5)
			.forEach(([wsId, stats]) => {
				const totalTokens = stats.inputTokens + stats.outputTokens;
				console.log(`${stats.name}: ${totalTokens.toLocaleString()} tokens, ${stats.interactions.toLocaleString()} interactions`);
			});
	}

	// Clean up temp file
	fs.unlinkSync(tempFile);

	console.log('\n✅ Analysis complete!\n');
	console.log('Next steps:');
	console.log('- Use the raw JSON data for custom analysis');
	console.log('- Filter by specific models: --model "gpt-4o"');
	console.log('- Filter by workspace: --workspaceId "workspace123"');
	console.log('- Export to CSV: --format csv --output usage.csv');
	console.log('\nSee SKILL.md for more examples and documentation.');

} catch (error) {
	console.error('\nError:', error.message);
	// Clean up temp file if it exists
	if (fs.existsSync(tempFile)) {
		fs.unlinkSync(tempFile);
	}
	process.exit(1);
}
