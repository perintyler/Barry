# =============================================================================
# Cloudflare Tunnel — barry.works
# =============================================================================

resource "cloudflare_tunnel" "barry_mac" {
  account_id = var.cloudflare_account_id
  name       = "barry-mac"
  secret     = var.tunnel_secret
  config_src = "cloudflare"

  lifecycle {
    ignore_changes = [secret, config_src]
  }
}

resource "cloudflare_tunnel_config" "barry_mac" {
  account_id = var.cloudflare_account_id
  tunnel_id  = cloudflare_tunnel.barry_mac.id

  config {
    ingress_rule {
      hostname = "barry.works"
      service  = "http://localhost:9429"
    }

    ingress_rule {
      hostname = "vault.barry.works"
      service  = "http://localhost:8222"
    }

    ingress_rule {
      service = "http_status:404"
    }
  }
}
