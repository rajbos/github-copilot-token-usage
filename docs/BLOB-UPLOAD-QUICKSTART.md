# Quick Start: Blob Upload for GitHub Copilot Coding Agent

This guide shows how to set up session log file uploads to Azure Blob Storage and make them available to the GitHub Copilot Coding Agent.

## Step 1: Enable Blob Upload in VS Code

Add to your VS Code `settings.json`:

```json
{
  "copilotTokenTracker.backend.enabled": true,
  "copilotTokenTracker.backend.storageAccount": "your-storage-account",
  "copilotTokenTracker.backend.blobUploadEnabled": true
}
```

That's it! Files will upload during the next backend sync (runs every 5 minutes by default).

## Step 2: Configure GitHub Copilot Coding Agent Access

### Option A: Using Entra ID (Recommended)

1. **Set up workload identity federation** for your GitHub repository:
   ```bash
   # Create a federated identity credential
   az ad app federated-credential create \
     --id <app-id> \
     --parameters '{
       "name": "github-actions",
       "issuer": "https://token.actions.githubusercontent.com",
       "subject": "repo:your-org/your-repo:environment:copilot",
       "audiences": ["api://AzureADTokenExchange"]
     }'
   ```

2. **Grant blob read access** to the application:
   ```bash
   az role assignment create \
     --role "Storage Blob Data Reader" \
     --assignee <app-id> \
     --scope /subscriptions/<sub>/resourceGroups/<rg>/providers/Microsoft.Storage/storageAccounts/<account>
   ```

3. **Add secrets to `copilot` environment**:
   - `AZURE_CLIENT_ID`: Application (client) ID
   - `AZURE_TENANT_ID`: Directory (tenant) ID
   - `AZURE_SUBSCRIPTION_ID`: Your subscription ID

4. **Add variables to `copilot` environment**:
   - `COPILOT_STORAGE_ACCOUNT`: Your storage account name
   - `COPILOT_STORAGE_CONTAINER`: `copilot-session-logs`
   - `COPILOT_DATASET_ID`: `default`

### Option B: Using Storage Shared Key

1. **Get storage account key**:
   ```bash
   az storage account keys list \
     --account-name your-storage-account \
     --query "[0].value" -o tsv
   ```

2. **Add to `copilot` environment**:
   - Secret: `COPILOT_STORAGE_KEY` = your storage key
   - Variable: `COPILOT_STORAGE_ACCOUNT` = your storage account name

3. **Update workflow** to use shared key auth (modify `.github/workflows/copilot-setup-steps.yml`):
   ```yaml
   - name: Download with shared key
     env:
       AZURE_STORAGE_KEY: ${{ secrets.COPILOT_STORAGE_KEY }}
     run: |
       az storage blob download-batch \
         --account-name ${{ vars.COPILOT_STORAGE_ACCOUNT }} \
         --account-key $AZURE_STORAGE_KEY \
         --source copilot-session-logs \
         --destination ./session-logs
   ```

## Step 3: Verify Setup

1. **Trigger upload** manually:
   - Open VS Code Command Palette (Ctrl+Shift+P / Cmd+Shift+P)
   - Run: "Copilot Token Tracker: Configure Backend"
   - Click "Test Connection" to verify access
   - Backend sync will upload files automatically

2. **Check Azure Storage**:
   ```bash
   # List uploaded files
   az storage blob list \
     --account-name your-storage-account \
     --container-name copilot-session-logs \
     --auth-mode login \
     --output table
   ```

3. **Test workflow**:
   - Go to your repository → Actions
   - Find "Copilot Setup Steps" workflow
   - Click "Run workflow" → Run
   - Check logs to verify files downloaded

## Step 4: Use in Coding Agent

Once configured, the GitHub Copilot Coding Agent will:

1. Run `.github/workflows/copilot-setup-steps.yml` before starting
2. Download session logs from blob storage to `./session-logs`
3. Have access to these logs during its execution

You can reference logs in your interactions with the agent:

```
"Review the session logs in ./session-logs and summarize common 
usage patterns from the last week"
```

## Troubleshooting

### Files not uploading?

Check VS Code Output panel:
1. View → Output
2. Select "Copilot Token Tracker"
3. Look for "Blob upload:" messages

Common causes:
- Backend sync disabled
- Upload frequency not elapsed (24 hours by default)
- Authentication failed
- Container doesn't exist (should auto-create)

### Workflow can't download files?

1. Verify environment variables are set correctly
2. Check authentication (Azure login step in workflow)
3. Ensure storage account allows GitHub Actions access
4. Review workflow run logs for specific errors

### Need more help?

See full documentation:
- [Blob Upload Guide](../docs/BLOB-UPLOAD.md)
- [Coding Agent Knowledge Base](.github/agents/coding-agent/knowledge.md)
- [Backend Configuration](../docs/specs/backend.md)
