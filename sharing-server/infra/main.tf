data "azurerm_resource_group" "this" {
  name = var.resource_group_name
}

# Storage account names must be globally unique, 3-24 chars, lowercase alphanumeric only.
# The 8-char random suffix is keyed on app_name so it stays stable across applies.
resource "random_string" "storage_suffix" {
  length  = 8
  special = false
  upper   = false
  keepers = {
    app_name = var.app_name
  }
}

# Storage account that holds the Azure Files share for SQLite persistence.
resource "azurerm_storage_account" "this" {
  name                     = "sharing${random_string.storage_suffix.result}"
  resource_group_name      = data.azurerm_resource_group.this.name
  location                 = var.location
  account_tier             = "Standard"
  account_replication_type = "LRS"
  min_tls_version          = "TLS1_2"
  tags                     = var.tags
}

# Azure Files share mounted into the container at /data.
# SQLite runs in DELETE journal mode (not WAL) for Azure Files compatibility.
resource "azurerm_storage_share" "data" {
  name               = "sharing-data"
  storage_account_id = azurerm_storage_account.this.id
  quota              = 1 # minimum 1 GB
}

# Container Apps Environment — one per deployment for full isolation.
resource "azurerm_container_app_environment" "this" {
  name                = "${var.app_name}-env"
  location            = var.location
  resource_group_name = data.azurerm_resource_group.this.name
  tags                = var.tags
}

# Link the Azure Files share to the ACA environment so apps can mount it.
resource "azurerm_container_app_environment_storage" "data" {
  name                         = "sharing-data"
  container_app_environment_id = azurerm_container_app_environment.this.id
  account_name                 = azurerm_storage_account.this.name
  access_key                   = azurerm_storage_account.this.primary_access_key
  share_name                   = azurerm_storage_share.data.name
  access_mode                  = "ReadWrite"
}

# The ACA environment default_domain is known after environment creation,
# so this local can be used for BASE_URL before the container app is created.
locals {
  # Native ACA FQDN — always available; used as CNAME target for custom DNS setup.
  aca_fqdn = "${var.app_name}.${azurerm_container_app_environment.this.default_domain}"
  # Effective public hostname — custom domain when provided, ACA FQDN otherwise.
  app_fqdn = var.custom_domain != "" ? var.custom_domain : local.aca_fqdn
}

resource "azurerm_container_app" "this" {
  name                         = var.app_name
  container_app_environment_id = azurerm_container_app_environment.this.id
  resource_group_name          = data.azurerm_resource_group.this.name
  revision_mode                = "Single"
  tags                         = var.tags

  # Secrets are stored in ACA's secret store; containers reference them by name.
  secret {
    name  = "github-client-secret"
    value = var.github_client_secret
  }

  secret {
    name  = "session-secret"
    value = var.session_secret
  }

  # Only create the org-check-token secret when a value is provided.
  # ACA rejects secrets with empty values.
  dynamic "secret" {
    for_each = var.github_org_check_token != "" ? [1] : []
    content {
      name  = "org-check-token"
      value = var.github_org_check_token
    }
  }

  ingress {
    external_enabled = true
    target_port      = 3000
    transport        = "http"

    traffic_weight {
      latest_revision = true
      percentage      = 100
    }
  }

  template {
    min_replicas = var.min_replicas  # Keep at 1 to avoid cold-start restore latency
    max_replicas = 1 # SQLite single-writer; only one instance at a time

    volume {
      name         = "data"
      storage_name = azurerm_container_app_environment_storage.data.name
      storage_type = "AzureFile"
    }

    container {
      name   = "sharing-server"
      image  = var.container_image
      cpu    = 0.25
      memory = "0.5Gi"

      volume_mounts {
        name = "data"
        path = "/data"
      }

      env {
        name  = "GITHUB_CLIENT_ID"
        value = var.github_client_id
      }
      env {
        name        = "GITHUB_CLIENT_SECRET"
        secret_name = "github-client-secret"
      }
      env {
        name        = "SESSION_SECRET"
        secret_name = "session-secret"
      }
      env {
        name  = "BASE_URL"
        value = "https://${local.app_fqdn}"
      }
      env {
        name  = "DATA_DIR"
        value = "/data"
      }
      env {
        # SQLite runs on local container disk to avoid Azure Files SMB locking.
        # DATA_DIR (/data, Azure Files) is used only for backup/restore via file copy.
        name  = "LOCAL_DATA_DIR"
        value = "/tmp/db"
      }
      env {
        name  = "NODE_ENV"
        value = "production"
      }
      env {
        name  = "ALLOWED_GITHUB_ORG"
        value = var.allowed_github_org
      }
      # Only wire GITHUB_ORG_CHECK_TOKEN when the secret exists.
      dynamic "env" {
        for_each = var.github_org_check_token != "" ? [1] : []
        content {
          name        = "GITHUB_ORG_CHECK_TOKEN"
          secret_name = "org-check-token"
        }
      }

      liveness_probe {
        path             = "/health"
        port             = 3000
        transport        = "HTTP"
        initial_delay    = 10
        interval_seconds = 30
      }

      readiness_probe {
        path             = "/health"
        port             = 3000
        transport        = "HTTP"
        initial_delay    = 5
        interval_seconds = 10
      }
    }
  }
}

# ── Custom domain + managed TLS certificate ───────────────────────────────────
# Only created when var.custom_domain is set.
# DNS prerequisites (must exist before applying):
#   CNAME  <subdomain>        → local.aca_fqdn
#   TXT    asuid.<subdomain>  → azurerm_container_app_environment.this.custom_domain_verification_id

resource "azurerm_container_app_environment_managed_certificate" "this" {
  count                        = var.custom_domain != "" ? 1 : 0
  name                         = "sharing-cert"
  container_app_environment_id = azurerm_container_app_environment.this.id
  subject_name                 = var.custom_domain
  domain_control_validation    = "CNAME"
}

resource "azurerm_container_app_custom_domain" "this" {
  count                                    = var.custom_domain != "" ? 1 : 0
  name                                     = var.custom_domain
  container_app_id                         = azurerm_container_app.this.id
  container_app_environment_certificate_id = azurerm_container_app_environment_managed_certificate.this[0].id
  certificate_binding_type                 = "SniEnabled"

  depends_on = [azurerm_container_app_environment_managed_certificate.this]
}
