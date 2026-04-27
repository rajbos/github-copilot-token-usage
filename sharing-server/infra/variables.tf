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

variable "min_replicas" {
  description = "Minimum container replicas. Use 0 for scale-to-zero (cheapest), 1 for always-on (faster cold start)."
  type        = number
  default     = 0
}

variable "tags" {
  description = "Azure resource tags"
  type        = map(string)
  default     = {}
}
