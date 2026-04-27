output "app_url" {
  description = "Public HTTPS URL of the deployed sharing server"
  value       = "https://${local.app_fqdn}"
}

output "oauth_callback_url" {
  description = "GitHub OAuth App callback URL — register this in your OAuth App settings"
  value       = "https://${local.app_fqdn}/auth/github/callback"
}

output "dashboard_url" {
  description = "Team dashboard URL"
  value       = "https://${local.app_fqdn}/dashboard"
}

output "health_url" {
  description = "Health check endpoint (public, no auth)"
  value       = "https://${local.app_fqdn}/health"
}
