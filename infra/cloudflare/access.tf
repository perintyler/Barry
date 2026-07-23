# =============================================================================
# Cloudflare Access — barry.works
# =============================================================================

resource "cloudflare_access_application" "barry_works" {
  zone_id                   = cloudflare_zone.works.id
  name                      = "Barry"
  domain                    = "*.barry.works"
  type                      = "self_hosted"
  session_duration          = "24h"

  self_hosted_domains = [
    "barry.works",
    "*.barry.works",
  ]
}

resource "cloudflare_access_service_token" "barry_machine" {
  account_id = var.cloudflare_account_id
  name       = "barry-machine"
  duration   = "forever"
}

resource "cloudflare_access_policy" "barry_machine" {
  application_id = cloudflare_access_application.barry_works.id
  zone_id        = cloudflare_zone.works.id
  name           = "Barry Machine"
  decision       = "non_identity"
  precedence     = 1

  include {
    service_token = [cloudflare_access_service_token.barry_machine.id]
  }
}

resource "cloudflare_access_policy" "barry_owner" {
  application_id   = cloudflare_access_application.barry_works.id
  zone_id          = cloudflare_zone.works.id
  name             = "Barry Owner"
  decision         = "allow"
  precedence       = 2
  session_duration = "24h"

  include {
    email = [var.access_allowed_email]
  }
}

