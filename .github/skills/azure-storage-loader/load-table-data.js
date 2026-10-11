#!/usr/bin/env node

/**
 * Azure Storage Table Data Loader
 *
 * Loads token usage data from Azure Table Storage for analysis in chat conversations.
 * Supports both Entra ID and Shared Key authentication. The shared key is read
 * from the AZURE_STORAGE_KEY environment variable, never from the command line,
 * so it does not show up in process listings, shell history or transcripts.
 *
 * Usage:
 *   node load-table-data.js --storageAccount <name> --startDate <YYYY-MM-DD> --endDate <YYYY-MM-DD>
 *
 * See SKILL.md for detailed documentation and examples.
 */

const fs = require('fs');
const path = require('path');

// Environment variable holding the optional storage account shared key
const SHARED_KEY_ENV_VAR = 'AZURE_STORAGE_KEY';

// Azure storage account names are 3-24 lowercase letters and digits. The name
// becomes the endpoint host, so anything else (a '/', '.', ':' or '@') could
// send the Entra token or shared-key signature to a different host.
const STORAGE_ACCOUNT_PATTERN = /^[a-z0-9]{3,24}$/;

// Longest free-text entity value passed through; longer values are truncated
const MAX_ENTITY_STRING_LENGTH = 256;

// Options that take a value, mapped to their key in the parsed args
const VALUE_OPTIONS = {
	'--storageAccount': 'storageAccount',
	'--tableName': 'tableName',
	'--datasetId': 'datasetId',
	'--startDate': 'startDate',
	'--endDate': 'endDate',
	'--model': 'model',
	'--workspaceId': 'workspaceId',
	'--userId': 'userId',
	'--output': 'output',
	'--format': 'format'
};

// Parse command line arguments (throws on invalid input)
function parseArgs(argv = process.argv) {
	const args = {
		storageAccount: null,
		tableName: 'usageAggDaily',
		datasetId: 'default',
		startDate: null,
		endDate: null,
		model: null,
		workspaceId: null,
		userId: null,
		output: null,
		format: 'json',
		help: false
	};

	for (let i = 2; i < argv.length; i++) {
		const arg = argv[i];
		const nextArg = argv[i + 1];
		// Option name without any "=value" part. Error messages use only this,
		// never the raw argument, so a key passed by mistake is not echoed.
		const optionName = arg.split('=')[0];

		if (arg === '--help' || arg === '-h') {
			args.help = true;
		} else if (optionName === '--sharedKey') {
			// Deliberately not accepted, in either `--sharedKey <key>` or
			// `--sharedKey=<key>` form: a key on argv leaks into process
			// listings, shell history and agent transcripts. Never echo it.
			throw new Error(`--sharedKey is not supported; set the ${SHARED_KEY_ENV_VAR} environment variable instead`);
		} else if (Object.prototype.hasOwnProperty.call(VALUE_OPTIONS, arg)) {
			if (!nextArg || nextArg.startsWith('--')) {
				throw new Error(`${arg} requires a value`);
			}
			args[VALUE_OPTIONS[arg]] = nextArg;
			i++;
		} else if (arg.startsWith('-')) {
			throw new Error(`Unknown option: ${optionName} (use --help for usage information)`);
		} else {
			// A stray positional value could be a pasted secret; do not echo it
			throw new Error(`Unexpected positional argument at position ${i - 1} (use --help for usage information)`);
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
  --storageAccount <name>    Azure Storage account name (3-24 lowercase letters/digits)
  --startDate <YYYY-MM-DD>   Start date for data retrieval
  --endDate <YYYY-MM-DD>     End date for data retrieval

Optional Options:
  --tableName <name>         Table name (default: "usageAggDaily")
  --datasetId <id>           Dataset identifier (default: "default")
  --model <name>             Filter by model name
  --workspaceId <id>         Filter by workspace ID
  --userId <id>              Filter by user ID
  --output <path>            Write the result to this file instead of stdout
  --format <json|csv>        Output format (default: "json")
  --help, -h                 Show this help message

Authentication:
  By default, uses DefaultAzureCredential (Entra ID).
  To use Shared Key auth, set the ${SHARED_KEY_ENV_VAR} environment variable.
  The key is never accepted on the command line. Set the variable without
  typing the key into a command (which would land in shell history), e.g.
  read it with a silent prompt: read -rs ${SHARED_KEY_ENV_VAR}; export ${SHARED_KEY_ENV_VAR}

Examples:
  # Load data with Entra ID auth
  node load-table-data.js \\
    --storageAccount myaccount \\
    --startDate 2026-01-01 \\
    --endDate 2026-01-31

  # Load data with Shared Key auth (${SHARED_KEY_ENV_VAR} already exported) and filter by model
  node load-table-data.js \\
    --storageAccount myaccount \\
    --startDate 2026-01-01 \\
    --endDate 2026-01-31 \\
    --model gpt-4o \\
    --output usage.json

For more information, see SKILL.md
`);
}

// Validate an Azure storage account name (3-24 lowercase letters and digits)
function isValidStorageAccountName(name) {
	return typeof name === 'string' && STORAGE_ACCOUNT_PATTERN.test(name);
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
// Azure Tables disallow: / \ # ?
// Note: In JavaScript regex, forward slash doesn't need backslash escaping in strings
// but we keep the pattern consistent for all forbidden characters
function sanitizeTableKey(value) {
	if (!value) {
		return value;
	}
	let result = value;
	const forbiddenChars = ['/', '\\', '#', '?'];
	for (const char of forbiddenChars) {
		// For backslash, we need to escape it in both the regex pattern and replacement
		const escaped = char === '\\' ? '\\\\' : `\\${char}`;
		result = result.replace(new RegExp(escaped, 'g'), '_');
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
	// Checked here as well as in main(), because this function is exported and
	// the name is interpolated into the host that receives the credential.
	if (!isValidStorageAccountName(storageAccount)) {
		throw new Error('Invalid storage account name (expected 3-24 lowercase letters and digits)');
	}

	// Loaded lazily so the pure helpers can be used and tested without the SDK
	const { TableClient, AzureNamedKeyCredential } = require('@azure/data-tables');
	const { DefaultAzureCredential } = require('@azure/identity');

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

// Neutralize a free-text value that came from a table row. Rows are written by
// every uploader, so their strings are untrusted. Remove everything the
// repository's input validator (.github/workflows/validate-input.sh) treats as
// hidden content: control characters (\p{Cc}), all format characters (\p{Cf}:
// bidi controls, zero-width characters, soft hyphen, word joiner, BOM, Unicode
// tag characters), variation selectors and other invisible fillers. HTML
// comments are defused by removing all angle brackets, so their content stays
// visible. Then collapse whitespace and cap the length. Visible text is kept,
// so consumers must still treat these values as data, never as instructions.
function sanitizeEntityString(value) {
	if (value === undefined || value === null || value === '') {
		return undefined;
	}
	let result = String(value)
		.replace(/\p{Cc}/gu, ' ')
		.replace(/\p{Cf}/gu, '')
		.replace(/[\u{E0000}-\u{E007F}\uFE00-\uFE0F\u{E0100}-\u{E01EF}]/gu, '')
		.replace(/[\u034F\u115F\u1160\u180E\u3164\uFFA0]/gu, '')
		// Drop every angle bracket rather than pattern-matching HTML: with no
		// '<' or '>' left, no comment or tag can hide text from a Markdown
		// render, and a single-character pass cannot be bypassed by nesting
		// (e.g. "<!<!---->--") the way a multi-character strip can.
		.replace(/[<>]/g, '')
		.replace(/\s+/g, ' ')
		.trim();
	const chars = Array.from(result);
	if (chars.length > MAX_ENTITY_STRING_LENGTH) {
		result = chars.slice(0, MAX_ENTITY_STRING_LENGTH - 1).join('') + '\u2026';
	}
	return result === '' ? undefined : result;
}

// Map a raw table entity onto the output shape, sanitizing every string field
function normalizeEntity(entity, partitionKey, datasetId, dayKey) {
	const text = (value, fallback) => sanitizeEntityString(value) ?? fallback;
	return {
		partitionKey: text(entity.partitionKey, partitionKey),
		rowKey: text(entity.rowKey, ''),
		schemaVersion: entity.schemaVersion,
		datasetId: text(entity.datasetId, datasetId),
		day: text(entity.day, dayKey),
		model: text(entity.model, ''),
		workspaceId: text(entity.workspaceId, ''),
		workspaceName: text(entity.workspaceName, undefined),
		machineId: text(entity.machineId, ''),
		machineName: text(entity.machineName, undefined),
		userId: text(entity.userId, undefined),
		userKeyType: text(entity.userKeyType, undefined),
		shareWithTeam: entity.shareWithTeam || undefined,
		consentAt: text(entity.consentAt, undefined),
		inputTokens: typeof entity.inputTokens === 'number' ? entity.inputTokens : 0,
		outputTokens: typeof entity.outputTokens === 'number' ? entity.outputTokens : 0,
		interactions: typeof entity.interactions === 'number' ? entity.interactions : 0,
		updatedAt: text(entity.updatedAt, new Date().toISOString())
	};
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
			// Build OData filter with input validation
			// Note: Azure Table Storage has limited SQL injection risk, but we still validate inputs
			const escapeODataValue = (value) => {
				if (!value || typeof value !== 'string') {
					throw new Error('Filter value must be a non-empty string');
				}
				// Validate that value doesn't contain logical operators or newlines
				if (/\b(and|or|not)\b/i.test(value) || /[\n\r]/.test(value)) {
					throw new Error('Filter value contains invalid characters or operators');
				}
				// Escape single quotes per OData spec
				return value.replace(/'/g, "''");
			};

			let filter = `PartitionKey eq '${escapeODataValue(partitionKey)}'`;

			if (filters.model) {
				filter += ` and model eq '${escapeODataValue(filters.model)}'`;
			}
			if (filters.workspaceId) {
				filter += ` and workspaceId eq '${escapeODataValue(filters.workspaceId)}'`;
			}
			if (filters.userId) {
				filter += ` and userId eq '${escapeODataValue(filters.userId)}'`;
			}

			const queryOptions = {
				queryOptions: { filter }
			};

			let count = 0;
			for await (const entity of tableClient.listEntities(queryOptions)) {
				allEntities.push(normalizeEntity(entity, partitionKey, datasetId, dayKey));
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

// Escape one CSV cell. Text cells starting with = + - @ (or tab/CR) are
// prefixed with a quote so Excel/Sheets do not evaluate them as formulas.
function formatCsvCell(value) {
	if (value === undefined || value === null) {
		return '';
	}
	let stringValue = String(value);
	if (typeof value === 'string' && /^[=+\-@\t\r]/.test(stringValue)) {
		stringValue = `'${stringValue}`;
	}
	if (/[",\r\n]/.test(stringValue)) {
		return `"${stringValue.replace(/"/g, '""')}"`;
	}
	return stringValue;
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
		rows.push(headers.map(header => formatCsvCell(entity[header])).join(','));
	}

	return rows.join('\n');
}

// Write the result to a file readable only by the current user
function writeOutputFile(outputPath, content) {
	const resolved = path.resolve(outputPath);
	fs.mkdirSync(path.dirname(resolved), { recursive: true });
	fs.writeFileSync(resolved, content, { encoding: 'utf8', mode: 0o600 });
	return resolved;
}

// Main execution
async function main(argv = process.argv, env = process.env, createClient = createTableClient) {
	const args = parseArgs(argv);

	// Show help if requested
	if (args.help) {
		showHelp();
		return null;
	}

	// Validation (throw errors so callers can handle them)
	if (!args.storageAccount) {
		throw new Error('--storageAccount is required');
	}

	if (!isValidStorageAccountName(args.storageAccount)) {
		throw new Error('--storageAccount must be 3-24 lowercase letters and digits');
	}

	if (!args.startDate || !args.endDate) {
		throw new Error('--startDate and --endDate are required');
	}

	if (!isValidDate(args.startDate)) {
		throw new Error('--startDate must be in YYYY-MM-DD format');
	}

	if (!isValidDate(args.endDate)) {
		throw new Error('--endDate must be in YYYY-MM-DD format');
	}

	if (new Date(args.startDate) > new Date(args.endDate)) {
		throw new Error('--startDate must be before or equal to --endDate');
	}

	if (args.format !== 'json' && args.format !== 'csv') {
		throw new Error('--format must be either "json" or "csv"');
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

	// Create table client
	const tableClient = createClient(
		args.storageAccount,
		args.tableName,
		env[SHARED_KEY_ENV_VAR] || null
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

	// With --output the dataset goes only to the file, never to stdout, so a
	// CI log or transcript gets the counts above and not the per-row data.
	if (args.output) {
		const written = writeOutputFile(args.output, output);
		console.error(`Wrote ${entities.length} entities to ${written}`);
	}

	// Attach result to module.exports and return it
	module.exports.tresult = output;
	return { output, writtenToFile: Boolean(args.output) };
}

// Run if executed directly
if (require.main === module) {
	main()
		.then(result => {
			// Without --output, print the result to stdout for interactive use.
			if (result && !result.writtenToFile) {
				console.log(result.output);
			}
			process.exit(0);
		})
		.catch(error => {
			console.error('');
			console.error('Error:', error.message || error);
			if (error.stack) {
				console.error('Stack trace:', error.stack);
			}
			process.exit(1);
		});
}

module.exports = {
	parseArgs,
	main,
	isValidStorageAccountName,
	isValidDate,
	getDayKeysInclusive,
	sanitizeTableKey,
	buildPartitionKey,
	createTableClient,
	sanitizeEntityString,
	normalizeEntity,
	fetchEntities,
	formatAsJSON,
	formatCsvCell,
	formatAsCSV,
	writeOutputFile,
	SHARED_KEY_ENV_VAR,
	// `tresult` will hold the final output (JSON or CSV string) after `main()` runs
	tresult: null
};
