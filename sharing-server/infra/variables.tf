variable "resource_group_name" {
  description = "Azure resource group to deploy into (must already exist)"
  type        = string
}

variable "location" {
  description = "Azure region (e.g. westeurope)"
  type        = string
  default     = "westeurope"
}

variable "app_name" {
  description = "Container app name — sharing-server-prod (main) or sharing-test-<slug> (branch)"
  type        = string
}

variable "container_image" {
  description = "Fully-qualified container image reference (e.g. ghcr.io/rajbos/copilot-sharing-server@sha256:...)"
  type        = string
}

variable "github_client_id" {
  description = "GitHub OAuth App client ID (used by the dashboard login flow)"
  type        = string
  sensitive   = true
}

variable "github_client_secret" {
  description = "GitHub OAuth App client secret (used by the dashboard login flow)"
  type        = string
  sensitive   = true
}

variable "session_secret" {
  description = "Random secret for HMAC-signed session cookies (minimum 32 characters)"
  type        = string
  sensitive   = true
}

variable "allowed_github_org" {
  description = "Optional: restrict uploads and dashboard access to members of this GitHub org. Leave empty to allow any GitHub user."
  type        = string
  default     = ""
}

variable "github_org_check_token" {
  description = "Optional: server-side PAT with read:org scope and SSO authorization, used to verify org membership. Falls back to the user's own token if not set."
  type        = string
  sensitive   = true
  default     = ""
}

variable "custom_domain" {
  description = "Optional: custom domain to bind to the container app (e.g. sharing.example.com). Leave empty to use the ACA-generated FQDN."
  type        = string
  default     = ""
}

variable "min_replicas" {
  description = "Minimum container replicas. Must be 1 for SQLite on Azure Files — scale-to-zero causes stale SMB oplocks that block DB startup. Scale-to-zero (0) is only safe if you accept occasional lock errors on cold start."
  type        = number
  default     = 1
}

variable "admin_github_logins" {
  description = "Optional: comma-separated GitHub logins to auto-grant admin access (e.g. 'alice,bob'). When set, this list is authoritative — listed users get is_admin=1, all others get is_admin=0. Leave empty to manage admin access manually via the SQLite database."
  type        = string
  default     = ""
}

variable "tags" {
  description = "Azure resource tags"
  type        = map(string)
  default     = {}
}
