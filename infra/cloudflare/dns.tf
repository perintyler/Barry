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

# Metrics dashboard — Barry's own telemetry, gated by Cloudflare Access.
# The origin (localhost:4870) has no authentication of its own, so the Access
# application in access.tf is the only thing between this record and the
# internet. Do not add this hostname to the tunnel without that app.
#
# Ordering matters when adding a record like this. On the apply that created
# it, DNS and the tunnel route took effect before the Access policy finished
# propagating, and for a few seconds the dashboard answered unauthenticated
# requests with real content. Terraform gives no ordering between these
# resources because none is expressed: the Access app and the DNS record do
# not reference each other. For a new unauthenticated origin, apply the Access
# application FIRST (-target it), confirm it is live, then add the record.
resource "cloudflare_dns_record" "rocks_metrics" {
  zone_id = cloudflare_zone.rocks.id
  name    = "metrics"
  content = "${cloudflare_zero_trust_tunnel_cloudflared.barry_mac.id}.cfargotunnel.com"
  type    = "CNAME"
  proxied = true
  ttl     = 1
}

# Plans — the plans bag's web app, gated by Cloudflare Access exactly like
# metrics above: the origin (localhost:4880) has no authentication of its own,
# so the "Barry Plans" application in access.tf is the only thing between this
# record and a read/write store. Per the ordering note above, that Access app
# was applied and confirmed live BEFORE this record was added.
resource "cloudflare_dns_record" "rocks_plans" {
  zone_id = cloudflare_zone.rocks.id
  name    = "plans"
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
