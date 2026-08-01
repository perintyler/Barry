# =============================================================================
# Cloudflare Tunnel — barry.works
# =============================================================================

resource "cloudflare_zero_trust_tunnel_cloudflared" "barry_mac" {
  account_id    = var.cloudflare_account_id
  name          = "barry-mac"
  tunnel_secret = var.tunnel_secret
  config_src    = "cloudflare"

  lifecycle {
    ignore_changes = [tunnel_secret, config_src]
  }
}

resource "cloudflare_zero_trust_tunnel_cloudflared_config" "barry_mac" {
  account_id = var.cloudflare_account_id
  tunnel_id  = cloudflare_zero_trust_tunnel_cloudflared.barry_mac.id

  # v5: config/ingress_rule blocks became nested attributes (`ingress` list).
  # Order matters — the catch-all 404 must stay last.
  config = {
    ingress = [
      { hostname = "barry.works", service = "http://localhost:9429" },

      # No vault ingress. Vault is local-only (localhost:3923) — see dns.tf.
      # If re-added, the origin port is 3923; the old 8222 was Vaultwarden's.

      { hostname = "github.barry.rocks", service = "http://localhost:4861" },
      { hostname = "slack.barry.rocks", service = "http://localhost:4863" },
      { service = "http_status:404" },
    ]
  }
}
