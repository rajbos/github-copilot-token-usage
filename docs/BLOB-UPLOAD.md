# Uploading Session Log Files to Azure Blob Storage

## Overview

The Copilot Token Tracker extension can upload your local GitHub Copilot session log files to Azure Blob Storage. This enables:

1. **Team Collaboration**: Share session logs with your team for analysis and learning
2. **Persistent Storage**: Keep logs beyond local VS Code storage limits
3. **Coding Agent Access**: Make logs available to GitHub Copilot Coding Agent as reference material

## Configuration

### Prerequisites

- Azure Storage account configured in extension settings
- Backend sync enabled (`copilotTokenTracker.backend.enabled: true`)
- Appropriate Azure permissions:
  - **Storage Blob Data Contributor** (for uploading)
  - **Storage Blob Data Reader** (for downloading)

### Enable Blob Upload

Add these settings to your VS Code `settings.json`:

```json
{
  "copilotTokenTracker.backend.enabled": true,
  "copilotTokenTracker.backend.storageAccount": "your-storage-account-name",
  "copilotTokenTracker.backend.blobUploadEnabled": true,
  "copilotTokenTracker.backend.blobContainerName": "copilot-session-logs",
  "copilotTokenTracker.backend.blobUploadFrequencyHours": 24,
  "copilotTokenTracker.backend.blobCompressFiles": true
}
```

### Settings Explained

| Setting | Default | Description |
|---------|---------|-------------|
| `blobUploadEnabled` | `false` | Enable/disable session log file uploads |
| `blobContainerName` | `copilot-session-logs` | Name of the Azure Blob Storage container |
| `blobUploadFrequencyHours` | `24` | How often to upload files (1-168 hours) |
| `blobCompressFiles` | `true` | Compress files with gzip before upload |

## How It Works

### Upload Process

1. **Trigger**: Uploads occur during backend sync operations
2. **Frequency Check**: Extension checks if enough time has passed since last upload
3. **File Discovery**: Scans all local Copilot session directories
4. **Compression**: Files are gzipped (if enabled) to reduce size
5. **Upload**: Files are uploaded to blob storage with organized structure
6. **Tracking**: Last upload time is saved per machine

### Container Structure

Files are organized by dataset, machine, and date:

```
copilot-session-logs/
├── default/                          # Dataset ID
│   ├── 01234567-89ab-cdef-0123/      # Machine ID (vscode.env.machineId)
│   │   ├── 2026-02-11/              # Upload date (YYYY-MM-DD)
│   │   │   ├── session-abc123.json.gz
│   │   │   └── session-def456.json.gz
│   │   └── 2026-02-12/
│   │       └── session-xyz789.json.gz
│   └── fedcba98-7654-3210-fedc/      # Another machine
│       └── 2026-02-11/
│           └── session-ghi012.json.gz
```

### Blob Metadata

Each uploaded blob includes metadata:

- `originalFileName`: Original file name before compression
- `machineId`: First 16 characters of machine ID
- `datasetId`: Dataset identifier (e.g., "default")
- `uploadedAt`: ISO timestamp when uploaded
- `compressed`: "true" if file is gzipped

## Authentication

### Option 1: Entra ID (Recommended)

Uses your existing Azure credentials via `DefaultAzureCredential`:

```bash
# Authenticate via Azure CLI
az login

# Or sign in via VS Code Azure Account extension
```

No additional configuration needed - extension uses same credentials as backend sync.

### Option 2: Storage Shared Key

If using shared key authentication:

1. Run command: "Copilot Token Tracker: Set Backend Storage Shared Key"
2. Enter your storage account access key
3. Key is stored securely in VS Code SecretStorage

## GitHub Copilot Coding Agent Integration

### Overview

Session logs uploaded to blob storage can be downloaded and made available to the GitHub Copilot Coding Agent during its execution. This allows the agent to reference past interactions, learn from successful prompts, and understand usage patterns.

### Setup Instructions

1. **Configure Environment Variables**

   Navigate to your repository → Settings → Environments → `copilot` (create if needed)

   Add these variables:
   - `COPILOT_STORAGE_ACCOUNT`: Your storage account name
   - `COPILOT_STORAGE_CONTAINER`: Container name (default: `copilot-session-logs`)
   - `COPILOT_DATASET_ID`: Dataset ID (default: `default`)

2. **Configure Authentication**

   The coding agent workflow needs Azure credentials to download blobs.

   **Option A: Federated Identity (Recommended)**
   ```yaml
   - name: Azure Login
     uses: azure/login@v2
     with:
       client-id: ${{ secrets.AZURE_CLIENT_ID }}
       tenant-id: ${{ secrets.AZURE_TENANT_ID }}
       subscription-id: ${{ secrets.AZURE_SUBSCRIPTION_ID }}
   ```

   **Option B: Service Principal**
   Add secret `AZURE_CREDENTIALS` with service principal JSON

   **Option C: Storage Shared Key**
   Add secret `COPILOT_STORAGE_KEY` with storage account key

3. **Review Workflow**

   The `.github/workflows/copilot-setup-steps.yml` file is provided as a starting point. It:
   - Checks if storage account is configured
   - Downloads session logs from the last 7 days
   - Decompresses gzipped files
   - Makes files available in `./session-logs` directory

4. **Test the Workflow**

   Manually trigger the workflow:
   - Go to Actions → Copilot Setup Steps → Run workflow

   Verify logs are downloaded successfully.

### Workflow Configuration

The provided `copilot-setup-steps.yml` includes:

```yaml
- name: Download Copilot session logs from Azure Blob Storage
  if: ${{ vars.COPILOT_STORAGE_ACCOUNT != '' }}
  env:
    AZURE_STORAGE_ACCOUNT: ${{ vars.COPILOT_STORAGE_ACCOUNT }}
    AZURE_STORAGE_CONTAINER: ${{ vars.COPILOT_STORAGE_CONTAINER || 'copilot-session-logs' }}
    AZURE_DATASET_ID: ${{ vars.COPILOT_DATASET_ID || 'default' }}
  run: |
    # Download blobs from last 7 days
    az storage blob download-batch \
      --account-name "$AZURE_STORAGE_ACCOUNT" \
      --source "$AZURE_STORAGE_CONTAINER" \
      --destination ./session-logs \
      --pattern "${AZURE_DATASET_ID}/*/*/*.json.gz" \
      --auth-mode login
    
    # Decompress files
    find ./session-logs -name "*.gz" -exec gunzip {} \;
```

### Using Logs in Coding Agent

Once downloaded, session logs are available in the `./session-logs` directory. The coding agent can:

1. **Analyze usage patterns**: Understand how the team uses Copilot
2. **Learn from examples**: Reference successful prompts and responses
3. **Debug issues**: Review interaction history when troubleshooting
4. **Generate reports**: Aggregate statistics from session data

## Security and Privacy

### Important Considerations

⚠️ **Session logs contain sensitive information:**

- Full text of your prompts to Copilot
- Full text of Copilot's responses
- Code snippets and file references
- Potentially confidential information

### Security Best Practices

1. **Private Container**: Never make the blob container publicly accessible
   ```bash
   # Verify container is private
   az storage container show-permission \
     --name copilot-session-logs \
     --account-name your-account
   # Should show: "permissions": null (private)
   ```

2. **Access Control**: Use Azure RBAC to restrict access
   ```bash
   # Grant read-only access to specific user
   az role assignment create \
     --role "Storage Blob Data Reader" \
     --assignee user@example.com \
     --scope /subscriptions/.../containers/copilot-session-logs
   ```

3. **Environment Isolation**: Only use for `copilot` environment, not regular workflows

4. **Audit Access**: Enable logging for blob storage access
   ```bash
   az monitor diagnostic-settings create \
     --resource /subscriptions/.../storageAccounts/your-account \
     --name blob-audit \
     --logs '[{"category":"StorageRead","enabled":true}]'
   ```

5. **Retention Policy**: Auto-delete old logs to minimize exposure
   ```bash
   # Delete blobs older than 30 days
   az storage blob service-properties update \
     --account-name your-account \
     --delete-retention-days 30
   ```

### Privacy Profiles

The extension respects your privacy settings:

- **Off**: No upload occurs (backend disabled)
- **Solo**: Only your machine's logs (personal Azure account)
- **Team**: Multiple machines upload to shared storage (requires consent)

### GDPR Compliance

If operating in the EU or with EU users:

- ✅ Inform users that logs may be uploaded
- ✅ Obtain explicit consent for team sharing
- ✅ Provide mechanism to delete user's data
- ✅ Document data retention periods
- ✅ Restrict access to authorized personnel

## Troubleshooting

### Files Not Uploading

**Check settings:**
```json
{
  "copilotTokenTracker.backend.enabled": true,
  "copilotTokenTracker.backend.blobUploadEnabled": true
}
```

**View logs:**
1. Open Output panel: View → Output
2. Select "Copilot Token Tracker" from dropdown
3. Look for "Blob upload:" messages

**Common issues:**
- Backend sync is disabled
- Frequency interval hasn't elapsed (check hours since last upload)
- Authentication failed (verify Azure credentials)
- Container doesn't exist (will be auto-created on first upload)

### Downloads Fail in Workflow

**Check authentication:**
```yaml
# Add Azure login step before download
- uses: azure/login@v2
  with:
    client-id: ${{ secrets.AZURE_CLIENT_ID }}
    # ... other auth params
```

**Verify environment variables:**
- `COPILOT_STORAGE_ACCOUNT` must be set in `copilot` environment
- Check variable names match workflow file

**Review permissions:**
```bash
# Verify service principal has blob read access
az role assignment list \
  --assignee your-service-principal-id \
  --scope /subscriptions/.../storageAccounts/your-account
```

### Decompression Errors

Files are gzipped by default. Verify:

```bash
# Check if file is compressed
file session-abc123.json.gz
# Output: "gzip compressed data"

# Decompress
gunzip session-abc123.json.gz

# Or decompress and keep original
gzip -d -k session-abc123.json.gz
```

## Cost Estimation

### Storage Costs

Typical session file sizes:
- Uncompressed: 50-200 KB per file
- Compressed (gzip): 10-40 KB per file (75-80% reduction)

Example monthly costs (Azure Blob Storage - Hot tier, US regions):

| Users | Files/day | Compressed Size | Monthly Storage | Estimated Cost |
|-------|-----------|-----------------|-----------------|----------------|
| 10    | 100       | 2 MB/day        | ~60 MB          | $0.02          |
| 50    | 500       | 10 MB/day       | ~300 MB         | $0.06          |
| 100   | 1000      | 20 MB/day       | ~600 MB         | $0.12          |

*Costs as of 2026, may vary by region. Check [Azure Pricing Calculator](https://azure.microsoft.com/pricing/calculator/) for current rates.*

### Reducing Costs

1. **Enable compression**: `blobCompressFiles: true` (default)
2. **Increase upload frequency**: Upload less often to reduce transaction costs
3. **Use Cool tier**: For logs accessed infrequently
4. **Set lifecycle policy**: Auto-delete old logs after 30-90 days
5. **Archive old logs**: Move to Archive tier for long-term retention

Example lifecycle policy:

```json
{
  "rules": [
    {
      "enabled": true,
      "name": "move-old-logs-to-cool",
      "type": "Lifecycle",
      "definition": {
        "actions": {
          "baseBlob": {
            "tierToCool": { "daysAfterModificationGreaterThan": 30 },
            "delete": { "daysAfterModificationGreaterThan": 90 }
          }
        }
      }
    }
  ]
}
```

## FAQ

**Q: Do I need to enable blob upload if I just want backend sync?**
No, blob upload is optional and independent of backend sync (Azure Table Storage).

**Q: Will this affect extension performance?**
Minimal impact. Uploads happen in background during sync, and are throttled by frequency setting.

**Q: Can I upload to a different storage account than backend sync?**
Not currently. Both use the same storage account configured in settings.

**Q: What if I don't have an Azure Storage account?**
Blob upload is optional. The extension works fine with only local analytics or backend sync disabled.

**Q: How do I delete uploaded logs?**
Use Azure Portal, Storage Explorer, or Azure CLI:
```bash
az storage blob delete-batch \
  --account-name your-account \
  --source copilot-session-logs \
  --pattern "default/machine-id/*"
```

**Q: Can I limit which files are uploaded?**
Not currently. All session files found locally are uploaded (subject to frequency throttling).

## Next Steps

1. Review [Backend Setup Guide](backend.md) for initial Azure configuration
2. Test upload with manual sync: "Copilot Token Tracker: Configure Backend"
3. Set up coding agent environment variables for workflow access
4. Configure lifecycle policies to manage storage costs
5. Review uploaded files in Azure Portal → Storage accounts → Containers
