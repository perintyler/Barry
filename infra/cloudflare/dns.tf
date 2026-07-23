# =============================================================================
# DNS — barry.works
# =============================================================================

# Root — proxied through Cloudflare Tunnel
resource "cloudflare_record" "works_root" {
  zone_id = cloudflare_zone.works.id
  name    = "barry.works"
  content = cloudflare_tunnel.barry_mac.cname
  type    = "CNAME"
  proxied = true
  ttl     = 1
}

# Vault — zero-knowledge secrets API (Cloudflare Workers + D1)
resource "cloudflare_record" "works_vault" {
  zone_id = cloudflare_zone.works.id
  name    = "vault.barry.works"
  content = cloudflare_tunnel.barry_mac.cname
  type    = "CNAME"
  proxied = true
  ttl     = 1
}



# =============================================================================
# DNS — barry.rocks
# =============================================================================

# SPF — allow Mailgun to send on behalf of barry.rocks
# Note: MX records are managed automatically by Cloudflare Email Routing (see email.tf)
resource "cloudflare_record" "rocks_spf" {
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

resource "cloudflare_record" "rocks_resend_dkim" {
  zone_id = cloudflare_zone.rocks.id
  name    = "resend._domainkey"
  content = "p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQCvtwI18Urrl4/DGK64qu0kLWPc3iY90xvE7lnfVMusVdYQb0aeo+6TzX/2VWBFuRst6gAeGSe3AzOlyfkhqeE2YsIH+rzSNry2qVOh284p6QkDxQBtpGCT3To+pNj17zmX8GfFnhSkME3LRELxgBKDQaVmGJNcVwCbpQ5yxij0cQIDAQAB"
  type    = "TXT"
  ttl     = 1
}

resource "cloudflare_record" "rocks_resend_spf_mx" {
  zone_id  = cloudflare_zone.rocks.id
  name     = "send"
  content  = "feedback-smtp.us-east-1.amazonses.com"
  type     = "MX"
  priority = 10
  ttl      = 1
}

resource "cloudflare_record" "rocks_resend_spf_txt" {
  zone_id = cloudflare_zone.rocks.id
  name    = "send"
  content = "v=spf1 include:amazonses.com ~all"
  type    = "TXT"
  ttl     = 1
}
