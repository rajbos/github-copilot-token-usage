#!/usr/bin/env node

/**
 * Azure Storage Table Data Loader
 * 
 * Loads token usage data from Azure Table Storage for analysis in chat conversations.
 * Supports both Entra ID and Shared Key authentication.
 * 
 * Usage:
 *   node load-table-data.js --storageAccount <name> --startDate <YYYY-MM-DD> --endDate <YYYY-MM-DD>
 * 
 * See SKILL.md for detailed documentation and examples.
 */

const { TableClient, AzureNamedKeyCredential } = require('@azure/data-tables');
const { DefaultAzureCredential } = require('@azure/identity');
const fs = require('fs');
const path = require('path');

// Parse command line arguments
function parseArgs() {
	const args = {
		storageAccount: null,
		tableName: 'usageAggDaily',
		datasetId: 'default',
		startDate: null,
		endDate: null,
		model: null,
		workspaceId: null,
		userId: null,
		sharedKey: null,
		output: null,
		format: 'json',
		help: false
	};

	for (let i = 2; i < process.argv.length; i++) {
		const arg = process.argv[i];
		const nextArg = process.argv[i + 1];

		switch (arg) {
			case '--storageAccount':
				args.storageAccount = nextArg;
				i++;
				break;
			case '--tableName':
				args.tableName = nextArg;
				i++;
				break;
			case '--datasetId':
				args.datasetId = nextArg;
				i++;
				break;
			case '--startDate':
				args.startDate = nextArg;
				i++;
				break;
			case '--endDate':
				args.endDate = nextArg;
				i++;
				break;
			case '--model':
				args.model = nextArg;
				i++;
				break;
			case '--workspaceId':
				args.workspaceId = nextArg;
				i++;
				break;
			case '--userId':
				args.userId = nextArg;
				i++;
				break;
			case '--sharedKey':
				args.sharedKey = nextArg;
				i++;
				break;
			case '--output':
				args.output = nextArg;
				i++;
				break;
			case '--format':
				args.format = nextArg;
				i++;
				break;
			case '--help':
			case '-h':
				args.help = true;
				break;
		}
	}

	return args;
}

// Display help message
function showHelp() {
	console.log(`
Azure Storage Table Data Loader

Usage:
  node load-table-data.js [options]

Required Options:
  --storageAccount <name>    Azure Storage account name
  --startDate <YYYY-MM-DD>   Start date for data retrieval
  --endDate <YYYY-MM-DD>     End date for data retrieval

Optional Options:
  --tableName <name>         Table name (default: "usageAggDaily")
  --datasetId <id>           Dataset identifier (default: "default")
  --model <name>             Filter by model name
  --workspaceId <id>         Filter by workspace ID
  --userId <id>              Filter by user ID
  --sharedKey <key>          Azure Storage shared key (if not using Entra ID)
  --output <path>            Output file path (default: stdout)
  --format <json|csv>        Output format (default: "json")
  --help, -h                 Show this help message

Authentication:
  By default, uses DefaultAzureCredential (Entra ID).
  To use Shared Key auth, provide --sharedKey option.

Examples:
  # Load data with Entra ID auth
  node load-table-data.js \\
    --storageAccount myaccount \\
    --startDate 2026-01-01 \\
    --endDate 2026-01-31

  # Load data with Shared Key auth and filter by model
  node load-table-data.js \\
    --storageAccount myaccount \\
    --startDate 2026-01-01 \\
    --endDate 2026-01-31 \\
    --model gpt-4o \\
    --sharedKey "your-key-here" \\
    --output usage.json

For more information, see SKILL.md
`);
}

// Validate date format (YYYY-MM-DD)
function isValidDate(dateString) {
	const regex = /^\d{4}-\d{2}-\d{2}$/;
	if (!regex.test(dateString)) {
		return false;
	}
	const date = new Date(dateString);
	return date instanceof Date && !isNaN(date);
}

// Generate array of date strings between start and end (inclusive)
function getDayKeysInclusive(startDate, endDate) {
	const start = new Date(startDate);
	const end = new Date(endDate);
	const days = [];

	const current = new Date(start);
	while (current <= end) {
		const year = current.getFullYear();
		const month = String(current.getMonth() + 1).padStart(2, '0');
		const day = String(current.getDate()).padStart(2, '0');
		days.push(`${year}-${month}-${day}`);
		current.setDate(current.getDate() + 1);
	}

	return days;
}

// Sanitize table key (replaces forbidden characters)
function sanitizeTableKey(value) {
	if (!value) {
		return value;
	}
	let result = value;
	const forbiddenChars = ['/', '\\', '#', '?'];
	for (const char of forbiddenChars) {
		result = result.replace(new RegExp(`\\${char}`, 'g'), '_');
	}
	// Replace control characters
	result = result.replace(/[\x00-\x1F\x7F-\x9F]/g, '_');
	return result;
}

// Build partition key for a specific dataset and day
function buildPartitionKey(datasetId, dayKey) {
	const raw = `ds:${datasetId}|d:${dayKey}`;
	return sanitizeTableKey(raw);
}

// Create table client with appropriate credentials
function createTableClient(storageAccount, tableName, sharedKey) {
	const endpoint = `https://${storageAccount}.table.core.windows.net`;

	let credential;
	if (sharedKey) {
		credential = new AzureNamedKeyCredential(storageAccount, sharedKey);
		console.error('Using Shared Key authentication');
	} else {
		credential = new DefaultAzureCredential();
		console.error('Using DefaultAzureCredential (Entra ID)');
	}

	return new TableClient(endpoint, tableName, credential);
}

// Fetch entities from table for a date range
async function fetchEntities(tableClient, datasetId, startDate, endDate, filters) {
	const dayKeys = getDayKeysInclusive(startDate, endDate);
	const allEntities = [];

	console.error(`Fetching data for ${dayKeys.length} days...`);

	for (const dayKey of dayKeys) {
		const partitionKey = buildPartitionKey(datasetId, dayKey);
		console.error(`  Querying partition: ${partitionKey}`);

		try {
			// Build OData filter
			let filter = `PartitionKey eq '${partitionKey.replace(/'/g, "''")}'`;

			if (filters.model) {
				filter += ` and model eq '${filters.model.replace(/'/g, "''")}'`;
			}
			if (filters.workspaceId) {
				filter += ` and workspaceId eq '${filters.workspaceId.replace(/'/g, "''")}'`;
			}
			if (filters.userId) {
				filter += ` and userId eq '${filters.userId.replace(/'/g, "''")}'`;
			}

			const queryOptions = {
				queryOptions: { filter }
			};

			let count = 0;
			for await (const entity of tableClient.listEntities(queryOptions)) {
				// Normalize entity structure
				const normalized = {
					partitionKey: entity.partitionKey || partitionKey,
					rowKey: entity.rowKey || '',
					schemaVersion: entity.schemaVersion,
					datasetId: entity.datasetId || datasetId,
					day: entity.day || dayKey,
					model: entity.model || '',
					workspaceId: entity.workspaceId || '',
					workspaceName: entity.workspaceName || undefined,
					machineId: entity.machineId || '',
					machineName: entity.machineName || undefined,
					userId: entity.userId || undefined,
					userKeyType: entity.userKeyType || undefined,
					shareWithTeam: entity.shareWithTeam || undefined,
					consentAt: entity.consentAt || undefined,
					inputTokens: typeof entity.inputTokens === 'number' ? entity.inputTokens : 0,
					outputTokens: typeof entity.outputTokens === 'number' ? entity.outputTokens : 0,
					interactions: typeof entity.interactions === 'number' ? entity.interactions : 0,
					updatedAt: entity.updatedAt || new Date().toISOString()
				};

				allEntities.push(normalized);
				count++;
			}

			console.error(`    Found ${count} entities`);
		} catch (error) {
			console.error(`    Error querying partition ${partitionKey}:`, error.message);
		}
	}

	return allEntities;
}

// Format entities as JSON
function formatAsJSON(entities) {
	return JSON.stringify(entities, null, 2);
}

// Format entities as CSV
function formatAsCSV(entities) {
	if (entities.length === 0) {
		return '';
	}

	// CSV headers
	const headers = [
		'day',
		'model',
		'workspaceId',
		'workspaceName',
		'machineId',
		'machineName',
		'userId',
		'userKeyType',
		'inputTokens',
		'outputTokens',
		'interactions',
		'updatedAt'
	];

	const rows = [headers.join(',')];

	// CSV data rows
	for (const entity of entities) {
		const values = headers.map(header => {
			const value = entity[header];
			if (value === undefined || value === null) {
				return '';
			}
			// Escape commas and quotes
			const stringValue = String(value);
			if (stringValue.includes(',') || stringValue.includes('"') || stringValue.includes('\n')) {
				return `"${stringValue.replace(/"/g, '""')}"`;
			}
			return stringValue;
		});
		rows.push(values.join(','));
	}

	return rows.join('\n');
}

// Main execution
async function main() {
	const args = parseArgs();

	// Show help if requested
	if (args.help) {
		showHelp();
		process.exit(0);
	}

	// Validate required arguments
	if (!args.storageAccount) {
		console.error('Error: --storageAccount is required');
		console.error('Use --help for usage information');
		process.exit(1);
	}

	if (!args.startDate || !args.endDate) {
		console.error('Error: --startDate and --endDate are required');
		console.error('Use --help for usage information');
		process.exit(1);
	}

	if (!isValidDate(args.startDate)) {
		console.error('Error: --startDate must be in YYYY-MM-DD format');
		process.exit(1);
	}

	if (!isValidDate(args.endDate)) {
		console.error('Error: --endDate must be in YYYY-MM-DD format');
		process.exit(1);
	}

	if (new Date(args.startDate) > new Date(args.endDate)) {
		console.error('Error: --startDate must be before or equal to --endDate');
		process.exit(1);
	}

	if (args.format !== 'json' && args.format !== 'csv') {
		console.error('Error: --format must be either "json" or "csv"');
		process.exit(1);
	}

	console.error('Azure Storage Table Data Loader');
	console.error('==============================');
	console.error(`Storage Account: ${args.storageAccount}`);
	console.error(`Table Name: ${args.tableName}`);
	console.error(`Dataset ID: ${args.datasetId}`);
	console.error(`Date Range: ${args.startDate} to ${args.endDate}`);
	if (args.model) {
		console.error(`Model Filter: ${args.model}`);
	}
	if (args.workspaceId) {
		console.error(`Workspace Filter: ${args.workspaceId}`);
	}
	if (args.userId) {
		console.error(`User Filter: ${args.userId}`);
	}
	console.error('');

	try {
		// Create table client
		const tableClient = createTableClient(
			args.storageAccount,
			args.tableName,
			args.sharedKey
		);

		// Fetch entities
		const entities = await fetchEntities(
			tableClient,
			args.datasetId,
			args.startDate,
			args.endDate,
			{
				model: args.model,
				workspaceId: args.workspaceId,
				userId: args.userId
			}
		);

		console.error('');
		console.error(`Total entities fetched: ${entities.length}`);

		// Calculate totals
		const totals = entities.reduce(
			(acc, entity) => {
				acc.inputTokens += entity.inputTokens;
				acc.outputTokens += entity.outputTokens;
				acc.interactions += entity.interactions;
				return acc;
			},
			{ inputTokens: 0, outputTokens: 0, interactions: 0 }
		);

		console.error('');
		console.error('Totals:');
		console.error(`  Input Tokens: ${totals.inputTokens.toLocaleString()}`);
		console.error(`  Output Tokens: ${totals.outputTokens.toLocaleString()}`);
		console.error(`  Total Tokens: ${(totals.inputTokens + totals.outputTokens).toLocaleString()}`);
		console.error(`  Interactions: ${totals.interactions.toLocaleString()}`);
		console.error('');

		// Format output
		let output;
		if (args.format === 'csv') {
			output = formatAsCSV(entities);
		} else {
			output = formatAsJSON(entities);
		}

		// Write to file or stdout
		if (args.output) {
			fs.writeFileSync(args.output, output, 'utf8');
			console.error(`Output written to: ${args.output}`);
		} else {
			// Write to stdout (actual data output)
			console.log(output);
		}

		process.exit(0);
	} catch (error) {
		console.error('');
		console.error('Error:', error.message);
		if (error.stack) {
			console.error('Stack trace:', error.stack);
		}
		process.exit(1);
	}
}

// Run if executed directly
if (require.main === module) {
	main().catch(error => {
		console.error('Unhandled error:', error);
		process.exit(1);
	});
}

module.exports = {
	parseArgs,
	isValidDate,
	getDayKeysInclusive,
	sanitizeTableKey,
	buildPartitionKey,
	createTableClient,
	fetchEntities,
	formatAsJSON,
	formatAsCSV
};
