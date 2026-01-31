---
name: azure-storage-loader
description: Load token usage data from Azure Table Storage for faster iteration and analysis in chat conversations
---

# Azure Storage Loader Skill

This skill enables you to load actual token usage data from Azure Table Storage into your chat conversations. This allows for faster iteration when analyzing usage patterns, testing queries, or debugging issues without needing to sync data from local session files.

## Overview

The Copilot Token Tracker extension can sync token usage data to Azure Table Storage. This skill provides helper scripts to:
- Query and fetch data from Azure Storage Tables
- Load data into a usable format for chat analysis
- Authenticate using Azure credentials (Entra ID or Shared Key)
- Filter data by date range, dataset, model, workspace, or user

## When to Use This Skill

Use this skill when you need to:
- Analyze actual usage data patterns without manual export
- Test query logic against real data
- Debug backend sync issues with live data
- Perform ad-hoc analysis of token usage across teams
- Validate data transformations or aggregations
- Quickly iterate on data analysis tasks in chat

## Prerequisites

Before using this skill, ensure you have:
- Azure Storage account with token usage data already synced
- Azure credentials configured (either Entra ID or Shared Key)
- Node.js installed for running helper scripts
- Access to the storage account and table (read permissions minimum)

## Azure Table Storage Schema

The extension stores daily aggregate data in Azure Tables with the following schema:

### Table Name
Default: `usageAggDaily` (configurable via `copilotTokenTracker.backend.aggTable`)

### Entity Structure

**Partition Key**: `ds:{datasetId}|d:{YYYY-MM-DD}`
- Groups entities by dataset and day for efficient queries

**Row Key**: `m:{model}|w:{workspaceId}|mc:{machineId}|u:{userId}`
- Unique identifier for each model/workspace/machine/user combination

**Fields**:
- `schemaVersion` (number): Schema version for compatibility
- `datasetId` (string): Logical dataset identifier
- `day` (string): Date in YYYY-MM-DD format
- `model` (string): AI model name (e.g., "gpt-4", "claude-3-5-sonnet-20241022")
- `workspaceId` (string): Workspace identifier (sanitized)
- `workspaceName` (string, optional): Human-readable workspace name
- `machineId` (string): Machine identifier (sanitized)
- `machineName` (string, optional): Human-readable machine name
- `userId` (string, optional): User identifier (if team sharing enabled)
- `userKeyType` (string, optional): Type of user identifier (pseudonymous/teamAlias/entraObjectId)
- `shareWithTeam` (boolean, optional): Whether data is shared with team
- `consentAt` (string, optional): ISO timestamp of consent
- `inputTokens` (number): Total input tokens for this dimension
- `outputTokens` (number): Total output tokens for this dimension
- `interactions` (number): Total interactions count
- `updatedAt` (string): ISO timestamp of last update

### Sanitization Rules

Azure Tables disallow certain characters in PartitionKey/RowKey: `/`, `\`, `#`, `?`
These are replaced with `_` by the `sanitizeTableKey()` function in `src/backend/storageTables.ts`.

## Authentication Methods

### Option 1: Entra ID (Recommended)

Uses DefaultAzureCredential for authentication:
- Azure CLI: `az login`
- VS Code: Sign in via Azure extension
- Environment variables: `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`
- Managed Identity (when running in Azure)

**Required RBAC Roles**:
- `Storage Table Data Reader` (read-only)
- `Storage Table Data Contributor` (read/write)

### Option 2: Shared Key

Uses account access key stored in VS Code SecretStorage:
- Set via command: "Copilot Token Tracker: Set Backend Storage Shared Key"
- Does not sync across devices
- Requires account key from Azure Portal

## Helper Script: `load-table-data.js`

### Purpose
Fetch token usage data from Azure Table Storage and output as JSON for analysis.

### Usage

```bash
# Navigate to skill directory
cd .github/skills/azure-storage-loader

# Install dependencies (first time only)
npm install

# Load data with Entra ID auth
node load-table-data.js \
  --storageAccount "youraccount" \
  --tableName "usageAggDaily" \
  --datasetId "default" \
  --startDate "2026-01-01" \
  --endDate "2026-01-30"

# Load data with Shared Key auth
node load-table-data.js \
  --storageAccount "youraccount" \
  --tableName "usageAggDaily" \
  --datasetId "default" \
  --startDate "2026-01-01" \
  --endDate "2026-01-30" \
  --sharedKey "your-account-key"

# Filter by specific model
node load-table-data.js \
  --storageAccount "youraccount" \
  --tableName "usageAggDaily" \
  --datasetId "default" \
  --startDate "2026-01-01" \
  --endDate "2026-01-30" \
  --model "gpt-4o"

# Output to file
node load-table-data.js \
  --storageAccount "youraccount" \
  --tableName "usageAggDaily" \
  --datasetId "default" \
  --startDate "2026-01-01" \
  --endDate "2026-01-30" \
  --output "usage-data.json"
```

### Parameters

- `--storageAccount` (required): Azure Storage account name
- `--tableName` (optional): Table name (default: "usageAggDaily")
- `--datasetId` (optional): Dataset identifier (default: "default")
- `--startDate` (required): Start date in YYYY-MM-DD format
- `--endDate` (required): End date in YYYY-MM-DD format
- `--model` (optional): Filter by specific model name
- `--workspaceId` (optional): Filter by specific workspace ID
- `--userId` (optional): Filter by specific user ID
- `--sharedKey` (optional): Azure Storage account key (if not using Entra ID)
- `--output` (optional): Output file path (default: stdout)
- `--format` (optional): Output format: "json" or "csv" (default: "json")

### Output Format

JSON array of entities:
```json
[
  {
    "partitionKey": "ds:default|d:2026-01-16",
    "rowKey": "m:gpt-4o|w:workspace123|mc:machine456|u:user789",
    "schemaVersion": 3,
    "datasetId": "default",
    "day": "2026-01-16",
    "model": "gpt-4o",
    "workspaceId": "workspace123",
    "workspaceName": "MyProject",
    "machineId": "machine456",
    "machineName": "MyLaptop",
    "userId": "user789",
    "userKeyType": "pseudonymous",
    "inputTokens": 1500,
    "outputTokens": 800,
    "interactions": 25,
    "updatedAt": "2026-01-16T23:59:59.999Z"
  }
]
```

CSV format (when `--format csv` is used):
```csv
day,model,workspaceId,workspaceName,machineId,machineName,userId,userKeyType,inputTokens,outputTokens,interactions,updatedAt
2026-01-16,gpt-4o,workspace123,MyProject,machine456,MyLaptop,user789,pseudonymous,1500,800,25,2026-01-16T23:59:59.999Z
```

## Usage Examples

### Example 1: Basic Data Loading

```javascript
// In a chat conversation:
// "Load the last 7 days of token usage data from Azure"

// Run the helper script:
node load-table-data.js \
  --storageAccount "mycopilotusage" \
  --datasetId "team-alpha" \
  --startDate "2026-01-23" \
  --endDate "2026-01-30"

// Analyze the output in the conversation
```

### Example 2: Model Comparison

```javascript
// "Compare GPT-4 vs Claude usage for January"

// Load GPT-4 data
node load-table-data.js \
  --storageAccount "mycopilotusage" \
  --datasetId "team-alpha" \
  --startDate "2026-01-01" \
  --endDate "2026-01-31" \
  --model "gpt-4o" \
  --output "gpt4-jan.json"

// Load Claude data
node load-table-data.js \
  --storageAccount "mycopilotusage" \
  --datasetId "team-alpha" \
  --startDate "2026-01-01" \
  --endDate "2026-01-31" \
  --model "claude-3-5-sonnet-20241022" \
  --output "claude-jan.json"

// Compare in chat using the JSON files
```

### Example 3: Team Analytics

```javascript
// "Show me per-user token usage for our team this month"

node load-table-data.js \
  --storageAccount "mycopilotusage" \
  --datasetId "team-alpha" \
  --startDate "2026-01-01" \
  --endDate "2026-01-31" \
  --output "team-usage.json"

// In chat, analyze the userId field to aggregate per-user totals
```

### Example 4: Cost Analysis

```javascript
// "Calculate the estimated cost of our Copilot usage"

node load-table-data.js \
  --storageAccount "mycopilotusage" \
  --datasetId "team-alpha" \
  --startDate "2026-01-01" \
  --endDate "2026-01-31" \
  --output "usage-for-costing.json"

// Use model pricing data (src/modelPricing.json) to calculate costs
// Group by model, multiply tokens by pricing rates
```

## Integration with Extension Code

The helper script uses the same Azure SDK packages as the extension:
- `@azure/data-tables`: Table Storage operations
- `@azure/identity`: Authentication via DefaultAzureCredential

Key extension modules referenced:
- `src/backend/storageTables.ts`: Entity schema and query functions
- `src/backend/services/dataPlaneService.ts`: Table client creation and operations
- `src/backend/constants.ts`: Schema versions and constants

## Troubleshooting

### Authentication Errors

**Problem**: "Missing Azure RBAC data-plane permissions"
**Solution**: Ensure you have `Storage Table Data Reader` or `Storage Table Data Contributor` role assigned

**Problem**: "SharedKeyCredential is not authorized"
**Solution**: Verify the shared key is correct and has not been rotated

### Data Not Found

**Problem**: No entities returned
**Solution**: 
- Verify the datasetId matches your configuration
- Check that data has been synced (enable backend in extension settings)
- Confirm the date range is correct
- Check that the table name matches (default: "usageAggDaily")

### Query Timeouts

**Problem**: Queries timing out with large date ranges
**Solution**:
- Reduce the date range (max 90 days recommended)
- Use pagination if loading large datasets
- Filter by model or workspace to reduce result set

## Security Considerations

- **Shared Keys**: Never commit shared keys to source control
- **User Data**: Respect team sharing consent settings
- **Data Retention**: Follow your organization's data retention policies
- **Access Control**: Use least-privilege RBAC roles when possible
- **Audit Logs**: Enable Azure Storage logs for compliance

## Related Files

- `src/backend/storageTables.ts`: Core table operations and schema
- `src/backend/services/dataPlaneService.ts`: Table client and query service
- `src/backend/services/queryService.ts`: Query caching and filtering
- `src/backend/constants.ts`: Schema versions and configuration
- `src/backend/types.ts`: TypeScript type definitions
- `package.json`: Azure SDK dependencies

## Additional Resources

- [Azure Table Storage Documentation](https://learn.microsoft.com/azure/storage/tables/)
- [Azure SDK for JavaScript](https://github.com/Azure/azure-sdk-for-js)
- [DefaultAzureCredential](https://learn.microsoft.com/javascript/api/@azure/identity/defaultazurecredential)
- [VS Code Extension Settings](../../../README.md#backend-configuration)
