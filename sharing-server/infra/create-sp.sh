#!/usr/bin/env bash
set -euo pipefail

# Create a service principal (service principal name) scoped to the specified
# resource group. Update SUBSCRIPTION_ID and RESOURCE_GROUP below if needed.

SUBSCRIPTION_ID="877cc7f4-0de3-4b2a-a3d6-ecd82e7b7cd4"
RESOURCE_GROUP="rg-copilot-token-usage"
SP_NAME="copilot-sharing-deploy"

SCOPE="/subscriptions/${SUBSCRIPTION_ID}/resourceGroups/${RESOURCE_GROUP}"

echo "Creating service principal '${SP_NAME}' scoped to resource group:'${SCOPE}'"

# Creates the SP and outputs SDK auth JSON which is convenient for Terraform/az cli
az ad sp create-for-rbac \
  --name "${SP_NAME}" \
  --role "Contributor" \
  --scopes "${SCOPE}" \
  --sdk-auth \
  > sp-credentials.json

echo "Service principal created. Credentials written to: sp-credentials.json"

# Show the important values to set as GitHub secrets (do NOT commit these values)
if command -v jq >/dev/null 2>&1; then
  CLIENT_ID=$(jq -r '.clientId' sp-credentials.json)
  CLIENT_SECRET=$(jq -r '.clientSecret' sp-credentials.json)
  TENANT_ID=$(jq -r '.tenantId' sp-credentials.json)
  echo "\n--- Values (set these as GitHub Environment secrets) ---"
  echo "AZURE_CLIENT_ID:     ${CLIENT_ID}"
  echo "AZURE_CLIENT_SECRET: ${CLIENT_SECRET}"
  echo "AZURE_TENANT_ID:     ${TENANT_ID}"
  echo "AZURE_SUBSCRIPTION_ID: ${SUBSCRIPTION_ID}"
else
  echo "\nNOTE: jq not found. Install jq to print secrets helpful for copying into GitHub." >&2
  echo "Credentials are in sp-credentials.json" >&2
fi

cat <<EOF

Next steps (recommended):
1. Add the values above to your GitHub Environment(s) (production/testing) as secrets:
   - AZURE_CLIENT_ID
   - AZURE_CLIENT_SECRET
   - AZURE_TENANT_ID
   - AZURE_SUBSCRIPTION_ID

   Example (requires gh CLI installed and authenticated):
     gh secret set AZURE_CLIENT_ID --body "<client-id>" --env production
     gh secret set AZURE_CLIENT_SECRET --body "<client-secret>" --env production
     gh secret set AZURE_TENANT_ID --body "<tenant-id>" --env production
     gh secret set AZURE_SUBSCRIPTION_ID --body "${SUBSCRIPTION_ID}" --env production

2. Grant the service principal Contributor access to the target resource group
   (the create-for-rbac above already assigns the role scoped to the RG).

3. For Terraform state storage, ensure the TF state storage account/container exists and
   set the repo variables: TF_STATE_RESOURCE_GROUP, TF_STATE_STORAGE_ACCOUNT, TF_STATE_CONTAINER

WARNING: Do NOT commit sp-credentials.json or any secret value into source control.
EOF
