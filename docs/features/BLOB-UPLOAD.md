# Uploading Session Log Files to Azure Blob Storage

## Overview

The AI Engineering Fluency extension can upload your local GitHub Copilot session log files to Azure Blob Storage. This enables:

1. **Team Collaboration**: Share session logs with your team for analysis and learning
2. **Persistent Storage**: Keep logs beyond local VS Code storage limits
3. **Coding Agent Access**: Make logs available to GitHub Copilot Coding Agent as reference material

## Configuration

### Prerequisites

- Azure Storage account configured in extension settings
- Backend sync enabled (`aiEngineeringFluency.backend.enabled: true`)
- Appropriate Azure permissions:
  - **Storage Blob Data Contributor** (for uploading)
  - **Storage Blob Data Reader** (for downloading)

### Enable Blob Upload

Add these settings to your VS Code `settings.json`:

```json
{
  "aiEngineeringFluency.backend.enabled": true,
  "aiEngineeringFluency.backend.storageAccount": "your-storage-account-name",
  "aiEngineeringFluency.backend.blobUploadEnabled": true,
  "aiEngineeringFluency.backend.blobContainerName": "copilot-session-logs",
  "aiEngineeringFluency.backend.blobUploadFrequencyHours": 24,
  "aiEngineeringFluency.backend.blobCompressFiles": true
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
- `editorType`: Source editor that created the session (e.g., "VS Code", "Copilot CLI", "JetBrains")

### Editor Type in the Download Workflow

The `copilot-setup-steps.yml` workflow lists the dataset's blobs once with `az storage blob list --include m`, which returns their metadata, and uses that single listing both to pick the date folders to download and to write a manifest at `./session-logs/.editor-types.json` mapping each session file's relative (decompressed) path to its `editorType`. This is needed because `az storage blob download-batch` does not preserve blob metadata. After downloading and decompressing, entries whose file is not on disk (a failed download or decompression) are dropped. The Copilot Coding Agent can use this manifest to classify session files by editor without relying on filename heuristics or content sniffing.

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

1. Run command: "AI Engineering Fluency: Set Backend Storage Shared Key"
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

   **Option A: Storage Shared Key (built in)**
   Add the secret `COPILOT_STORAGE_KEY` with the storage account key to the `copilot` environment. The provided workflow uses it automatically in both download steps, through two different mechanisms: the blob download sets it as `AZURE_STORAGE_KEY` and runs `az storage` with `--auth-mode key`, and the Table Storage download passes it to the `load-table-data.js` loader as `--sharedKey`. No workflow changes are needed.

   **Option B: Federated Identity**
   If you would rather not store a key, add an `azure/login` step before the download step. The workflow falls back to `--auth-mode login` when `COPILOT_STORAGE_KEY` is not set and an Azure login is present. This requires `id-token: write` on the job and a federated credential for the `copilot` environment:
   ```yaml
   - name: Azure Login
     uses: azure/login@v2
     with:
       client-id: ${{ secrets.AZURE_CLIENT_ID }}
       tenant-id: ${{ secrets.AZURE_TENANT_ID }}
       subscription-id: ${{ secrets.AZURE_SUBSCRIPTION_ID }}
   ```

   With neither configured, the download step is skipped with a workflow warning and `./session-logs` stays empty.

3. **Review Workflow**

   The `.github/workflows/copilot-setup-steps.yml` file is provided as a starting point. It:
   - Checks if storage account is configured
   - Lists the dataset's blobs once and downloads only the date folders from the last 7 days
   - Accepts `.json` and `.jsonl` session files, gzipped or not (`blobCompressFiles`)
   - Decompresses gzipped files, removing any that fail to decompress
   - Makes files available in `./session-logs` directory
   - Emits workflow warnings when it skips, fails, or finds no files

4. **Test the Workflow**

   Manually trigger the workflow:
   - Go to Actions → Copilot Setup Steps → Run workflow

   Verify logs are downloaded successfully.

### Workflow Configuration

The download step in the provided `copilot-setup-steps.yml` works like this (abridged; see the workflow file for the full step with its warnings and manifest handling):

```yaml
- name: Download Copilot session logs from Azure Blob Storage
  if: ${{ vars.COPILOT_STORAGE_ACCOUNT != '' }}
  env:
    AZURE_STORAGE_ACCOUNT: ${{ vars.COPILOT_STORAGE_ACCOUNT }}
    AZURE_STORAGE_CONTAINER: ${{ vars.COPILOT_STORAGE_CONTAINER || 'copilot-session-logs' }}
    AZURE_DATASET_ID: ${{ vars.COPILOT_DATASET_ID || 'default' }}
    # Read by `az storage` under --auth-mode key; never passed on a command line
    AZURE_STORAGE_KEY: ${{ secrets.COPILOT_STORAGE_KEY }}
  run: |
    # Shared key if configured, otherwise an existing azure/login session
    if [ -n "$AZURE_STORAGE_KEY" ]; then AUTH_MODE=key; else AUTH_MODE=login; fi

    # One listing (with metadata) of the whole dataset; "*" returns every page
    az storage blob list --account-name "$AZURE_STORAGE_ACCOUNT" \
      --container-name "$AZURE_STORAGE_CONTAINER" --prefix "${AZURE_DATASET_ID}/" \
      --include m --num-results '*' --auth-mode "$AUTH_MODE" --output json > blobs.json

    # ...select {dataset}/{machine}/{date}/*.json[l][.gz] blobs dated within the
    # last 7 days, write .editor-types.json, and collect their dates into $DATES...

    for DAY in $DATES; do
      az storage blob download-batch --account-name "$AZURE_STORAGE_ACCOUNT" \
        --source "$AZURE_STORAGE_CONTAINER" --destination ./session-logs \
        --pattern "${AZURE_DATASET_ID}/*/${DAY}/*.json*" --auth-mode "$AUTH_MODE"
    done

    # Decompress gzipped files (uncompressed uploads are used as-is)
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
  "aiEngineeringFluency.backend.enabled": true,
  "aiEngineeringFluency.backend.blobUploadEnabled": true
}
```

**View logs:**
1. Open Output panel: View → Output
2. Select "AI Engineering Fluency" from dropdown
3. Look for "Blob upload:" messages

**Common issues:**
- Backend sync is disabled
- Frequency interval hasn't elapsed (check hours since last upload)
- Authentication failed (verify Azure credentials)
- Container doesn't exist (will be auto-created on first upload)

### Downloads Fail in Workflow

**Check authentication:** look for `Using --auth-mode key` (or `login`) in the download step's log. A `No COPILOT_STORAGE_KEY secret and no Azure login` warning means neither credential is configured. Set the `COPILOT_STORAGE_KEY` secret in the `copilot` environment, or add an `azure/login` step before the download:
```yaml
- uses: azure/login@v2
  with:
    client-id: ${{ secrets.AZURE_CLIENT_ID }}
    # ... other auth params
```

**Check the dataset ID:** a `No session logs downloaded for dataset ...` warning, or `0 in date range` in the listing line, usually means `COPILOT_DATASET_ID` does not match the first path segment of the uploaded blobs.

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
2. Test upload with manual sync: "AI Engineering Fluency: Configure Backend"
3. Set up coding agent environment variables for workflow access
4. Configure lifecycle policies to manage storage costs
5. Review uploaded files in Azure Portal → Storage accounts → Containers
