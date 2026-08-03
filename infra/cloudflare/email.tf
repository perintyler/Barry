# =============================================================================
# Email — platypus@barry.rocks
# =============================================================================

# D1 database for email metadata.
#
# v5 surfaces read-only stats (file_size, num_tables, version, read_replication)
# as diffable attributes, so every plan wants an update whose PUT the D1 API
# rejects with 7400. Nothing here is actually configurable beyond the name.
resource "cloudflare_d1_database" "email" {
  account_id = var.cloudflare_account_id
  name       = "barry-rocks-email"

  lifecycle {
    ignore_changes = [read_replication]
  }
}

# Email Routing is enabled on barry.rocks via the Cloudflare dashboard.
# The cloudflare_email_routing_settings resource requires zone-level
# permissions that conflict with our token scope, so we manage it manually.

# Route platypus@barry.rocks → barry-rocks Worker
# v5: matcher/action blocks became the matchers/actions list attributes.
resource "cloudflare_email_routing_rule" "platypus" {
  zone_id = cloudflare_zone.rocks.id
  name    = "platypus inbox"
  enabled = true

  matchers = [
    { type = "literal", field = "to", value = "platypus@barry.rocks" },
  ]

  actions = [
    { type = "worker", value = ["barry-rocks"] },
  ]
}
