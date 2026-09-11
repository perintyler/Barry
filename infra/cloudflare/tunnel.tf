# =============================================================================
# Cloudflare Tunnel — shared infrastructure
# =============================================================================
#
# The tunnel itself is shared infrastructure. The ingress rules are driven by
# bag manifests via `tunnel_ingress` — generate with:
#   tsx scripts/generate-tunnel-ingress.ts --tfvars

resource "cloudflare_zero_trust_tunnel_cloudflared" "barry_mac" {
  account_id    = var.cloudflare_account_id
  name          = "barry-mac"
  tunnel_secret = var.tunnel_secret
  config_src    = "cloudflare"

  lifecycle {
    ignore_changes = [tunnel_secret, config_src]
  }
}

variable "tunnel_ingress" {
  description = "Tunnel ingress rules generated from bag manifests (tsx scripts/generate-tunnel-ingress.ts --tfvars)"
  type = list(object({
    hostname = optional(string)
    service  = string
  }))
  default = [
    { hostname = "barry.works", service = "http://localhost:9429" },
    { hostname = "actions.barry.rocks", service = "http://localhost:4890" },
    { hostname = "github.barry.rocks", service = "http://localhost:4861" },
    { hostname = "metrics.barry.rocks", service = "http://localhost:4870" },
    { hostname = "plans.barry.rocks", service = "http://localhost:4880" },
    { hostname = "slack.barry.rocks", service = "http://localhost:4863" },
    { service = "http_status:404" },
  ]
}

resource "cloudflare_zero_trust_tunnel_cloudflared_config" "barry_mac" {
  account_id = var.cloudflare_account_id
  tunnel_id  = cloudflare_zero_trust_tunnel_cloudflared.barry_mac.id

  config = {
    ingress = var.tunnel_ingress
  }
}
