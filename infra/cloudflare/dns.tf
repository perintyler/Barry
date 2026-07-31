# =============================================================================
# DNS — barry.works
# =============================================================================

# Root — proxied through Cloudflare Tunnel
resource "cloudflare_dns_record" "works_root" {
  zone_id = cloudflare_zone.works.id
  name    = "barry.works"
  content = "${cloudflare_zero_trust_tunnel_cloudflared.barry_mac.id}.cfargotunnel.com"
  type    = "CNAME"
  proxied = true
  ttl     = 1
}

# No vault.barry.works record. Vault is a local-only service (localhost:3923);
# every consumer reaches it directly. The hostname existed from the Vaultwarden
# era but never had a working origin, so exposing the secrets store publicly was
# never a deliberate feature. If remote access is ever wanted, give it a
# dedicated Access application rather than relying on the *.barry.works
# wildcard, which is scoped for the web app.

# GitHub App — webhook receiver for @barry-the-platypus mentions
resource "cloudflare_dns_record" "rocks_github" {
  zone_id = cloudflare_zone.rocks.id
  name    = "github"
  content = "${cloudflare_zero_trust_tunnel_cloudflared.barry_mac.id}.cfargotunnel.com"
  type    = "CNAME"
  proxied = true
  ttl     = 1
}



# =============================================================================
# DNS — barry.rocks
# =============================================================================

# Slack App — webhook receiver for slash commands and Events API
resource "cloudflare_dns_record" "rocks_slack" {
  zone_id = cloudflare_zone.rocks.id
  name    = "slack"
  content = "${cloudflare_zero_trust_tunnel_cloudflared.barry_mac.id}.cfargotunnel.com"
  type    = "CNAME"
  proxied = true
  ttl     = 1
}

# SPF — allow Mailgun to send on behalf of barry.rocks
# Note: MX records are managed automatically by Cloudflare Email Routing (see email.tf)
resource "cloudflare_dns_record" "rocks_spf" {
  zone_id = cloudflare_zone.rocks.id
  name    = "barry.rocks"
  content = "v=spf1 include:mailgun.org -all"
  type    = "TXT"
  ttl     = 1
}

# Note: artifacts.barry.rocks and lists.barry.rocks DNS records are managed
# automatically by Cloudflare Workers custom domains (wrangler.jsonc routes).

# =============================================================================
# DNS — barry.rocks (Resend outbound email)
# =============================================================================

resource "cloudflare_dns_record" "rocks_resend_dkim" {
  zone_id = cloudflare_zone.rocks.id
  name    = "resend._domainkey"
  content = "p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQCvtwI18Urrl4/DGK64qu0kLWPc3iY90xvE7lnfVMusVdYQb0aeo+6TzX/2VWBFuRst6gAeGSe3AzOlyfkhqeE2YsIH+rzSNry2qVOh284p6QkDxQBtpGCT3To+pNj17zmX8GfFnhSkME3LRELxgBKDQaVmGJNcVwCbpQ5yxij0cQIDAQAB"
  type    = "TXT"
  ttl     = 1
}

resource "cloudflare_dns_record" "rocks_resend_spf_mx" {
  zone_id  = cloudflare_zone.rocks.id
  name     = "send"
  content  = "feedback-smtp.us-east-1.amazonses.com"
  type     = "MX"
  priority = 10
  ttl      = 1
}

resource "cloudflare_dns_record" "rocks_resend_spf_txt" {
  zone_id = cloudflare_zone.rocks.id
  name    = "send"
  content = "v=spf1 include:amazonses.com ~all"
  type    = "TXT"
  ttl     = 1
}
