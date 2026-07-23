# =============================================================================
# Email — platypus@barry.rocks
# =============================================================================

# D1 database for email metadata
resource "cloudflare_d1_database" "email" {
  account_id = var.cloudflare_account_id
  name       = "barry-rocks-email"
}

# Email Routing is enabled on barry.rocks via the Cloudflare dashboard.
# The cloudflare_email_routing_settings resource requires zone-level
# permissions that conflict with our token scope, so we manage it manually.

# Route platypus@barry.rocks → barry-rocks Worker
resource "cloudflare_email_routing_rule" "platypus" {
  zone_id = cloudflare_zone.rocks.id
  name    = "platypus inbox"
  enabled = true

  matcher {
    type  = "literal"
    field = "to"
    value = "platypus@barry.rocks"
  }

  action {
    type  = "worker"
    value = ["barry-rocks"]
  }
}
