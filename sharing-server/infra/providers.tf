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
  # Authentication is via service principal client secret using ARM_* environment
  # variables set by the workflow (ARM_CLIENT_ID, ARM_CLIENT_SECRET,
  # ARM_TENANT_ID, ARM_SUBSCRIPTION_ID).
  # The SP has Contributor on the RG only, not subscription-level permissions,
  # so we disable automatic resource provider registration.
  resource_provider_registrations = "none"
}
