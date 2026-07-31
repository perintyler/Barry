# =============================================================================
# Mailgun Provider Configuration
# =============================================================================
# Manages the Mailgun domain and routing for barry.rocks inbound email.
# DNS records (MX, SPF, DKIM) live in ../cloudflare/dns.tf — no cross-module
# references needed since they're independent.
#
# Auth: MAILGUN_API_KEY env var (auto-read by provider)
# =============================================================================

terraform {
  required_version = ">= 1.5"

  required_providers {
    mailgun = {
      source  = "wgebis/mailgun"
      version = "~> 0.7"
    }
  }
}

provider "mailgun" {
  # Reads MAILGUN_API_KEY from environment
}
