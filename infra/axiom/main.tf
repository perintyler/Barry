# =============================================================================
# Axiom Provider Configuration
# =============================================================================
# Manages Axiom datasets and monitors for Barry observability.
# Auth: AXIOM_TOKEN env var (auto-read by provider)
# =============================================================================

terraform {
  required_version = ">= 1.5"

  required_providers {
    axiom = {
      source  = "axiomhq/axiom"
      version = "~> 1.5"
    }
  }
}

provider "axiom" {
  api_token = var.axiom_api_token
}
