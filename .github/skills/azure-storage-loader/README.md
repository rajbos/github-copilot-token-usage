# Azure Storage Loader Skill

Load token usage data from Azure Table Storage for analysis in chat conversations.

## Quick Start

```bash
# Install dependencies
npm install

# Load data (using Entra ID auth)
node load-table-data.js \
  --storageAccount "youraccount" \
  --tableName "usageAggDaily" \
  --datasetId "default" \
  --startDate "2026-01-01" \
  --endDate "2026-01-30"

# Output to file
node load-table-data.js \
  --storageAccount "youraccount" \
  --startDate "2026-01-01" \
  --endDate "2026-01-30" \
  --output "usage-data.json"

# Get help
node load-table-data.js --help
```

## Files

- **SKILL.md**: Complete skill documentation with examples and troubleshooting
- **load-table-data.js**: Helper script to fetch data from Azure Storage Tables
- **example-usage.js**: Example script demonstrating data loading and analysis
- **package.json**: Node.js dependencies

## Authentication

### Entra ID (Default)
Authenticate using one of these methods:
- Azure CLI: `az login`
- VS Code: Sign in via Azure extension
- Environment variables

### Shared Key
Use `--sharedKey` parameter to provide storage account key.

## Common Use Cases

1. **Quick Analysis**: Load recent data for ad-hoc queries
2. **Model Comparison**: Compare token usage across different AI models
3. **Team Analytics**: Analyze per-user or per-workspace usage
4. **Cost Estimation**: Calculate usage costs with pricing data

## Documentation

See **SKILL.md** for:
- Complete parameter reference
- Azure Table Storage schema details
- Authentication setup
- Advanced filtering examples
- Troubleshooting guide
- Security best practices

## Requirements

- Node.js 14 or later
- Azure Storage account with token usage data
- Appropriate Azure permissions (Storage Table Data Reader or Contributor)
