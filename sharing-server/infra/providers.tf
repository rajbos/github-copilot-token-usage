terraform {
  required_version = ">= 1.9"

  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 4.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }

  # All backend values are supplied via -backend-config flags in CI.
  # See .github/workflows/sharing-server-deploy.yml for the full init command.
  backend "azurerm" {}
}

provider "azurerm" {
  features {}
  # Authentication is via OIDC using ARM_* environment variables set by the
  # workflow (ARM_USE_OIDC, ARM_CLIENT_ID, ARM_TENANT_ID, ARM_SUBSCRIPTION_ID).
  use_oidc = true
}
