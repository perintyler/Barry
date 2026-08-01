# =============================================================================
# Cloudflare Access — barry.works
# =============================================================================

# The Zero Trust organization: the team domain that hosts the login page, and
# the sign-in methods offered on it. Managing it here is what stops a dashboard
# toggle from silently changing how (or whether) anyone can log in.
#
# auth_domain is the <team>.cloudflareaccess.com prefix. Changing it invalidates
# every existing Access session — everyone re-authenticates — and rewrites the
# aud/kid in login URLs. Nothing in this repo hardcodes it.
resource "cloudflare_zero_trust_organization" "barry" {
  account_id                         = var.cloudflare_account_id
  name                               = "Barry"
  auth_domain                        = "${var.access_team_name}.cloudflareaccess.com"
  is_ui_read_only                    = false
  user_seat_expiration_inactive_time = "1460h"
}

# Login is by emailed one-time PIN. Pinning it here (rather than leaving
# allowed_idps empty and inheriting whatever is toggled in the dashboard) keeps
# the email-code method from disappearing with no diff in this repo.
resource "cloudflare_zero_trust_access_identity_provider" "otp" {
  account_id = var.cloudflare_account_id
  name       = "One-Time PIN"
  type       = "onetimepin"
  # v5 requires config even for onetimepin, which takes no settings.
  config = {}
}

# v5 restructure: policies are account-scoped resources rather than children of
# an application, and the app attaches them in order via `policies` (precedence
# is now list position). `self_hosted_domains` became `destinations`.
resource "cloudflare_zero_trust_access_application" "barry_works" {
  zone_id          = cloudflare_zone.works.id
  name             = "Barry"
  domain           = "*.barry.works"
  type             = "self_hosted"
  session_duration = "24h"

  # Terraform is now the authority on sign-in methods. Adding an IdP means
  # adding it here — a dashboard-only change will be reverted on next apply.
  allowed_idps              = [cloudflare_zero_trust_access_identity_provider.otp.id]
  auto_redirect_to_identity = true

  # Pinned to the live values. v5 defaults http_only_cookie_attribute to true,
  # which would otherwise show as perpetual drift on an app that has always run
  # with these false.
  http_only_cookie_attribute = false
  enable_binding_cookie      = false
  options_preflight_bypass   = false

  destinations = [
    { type = "public", uri = "barry.works" },
    { type = "public", uri = "*.barry.works" },
  ]

  # Order is precedence: the machine token is evaluated before the human policy.
  policies = [
    { id = cloudflare_zero_trust_access_policy.barry_machine.id, precedence = 1 },
    { id = cloudflare_zero_trust_access_policy.barry_owner.id, precedence = 2 },
  ]
}

resource "cloudflare_zero_trust_access_service_token" "barry_machine" {
  account_id = var.cloudflare_account_id
  name       = "barry-machine"
  duration   = "forever"
}

resource "cloudflare_zero_trust_access_policy" "barry_machine" {
  account_id = var.cloudflare_account_id
  name       = "Barry Machine"
  decision   = "non_identity"

  include = [
    { service_token = { token_id = cloudflare_zero_trust_access_service_token.barry_machine.id } },
  ]
}

resource "cloudflare_zero_trust_access_policy" "barry_owner" {
  account_id       = var.cloudflare_account_id
  name             = "Barry Owner"
  decision         = "allow"
  session_duration = "24h"

  include = [
    { email = { email = var.access_allowed_email } },
  ]
}

# =============================================================================
# Cloudflare Access — vault.barry.rocks
# =============================================================================

# The vault holds every API token Barry uses. It enforces its own auth (the API
# returns 401 unauthenticated and the store is zero-knowledge), but until this
# app existed its login form was reachable by anyone on the internet — the
# *.barry.works application does not cover barry.rocks, a separate zone.
#
# Gating was added in 0fef5cc3 and lost in 40533315 when the vault moved from a
# Worker to a local Docker container. This restores it.
#
# Same policies as barry.works rather than duplicates: that is the point of
# reusable policies, and it means the allowed email is defined in exactly one
# place.
resource "cloudflare_zero_trust_access_application" "barry_vault" {
  zone_id          = cloudflare_zone.rocks.id
  name             = "Barry Vault"
  domain           = "vault.barry.rocks"
  type             = "self_hosted"
  session_duration = "24h"

  allowed_idps              = [cloudflare_zero_trust_access_identity_provider.otp.id]
  auto_redirect_to_identity = true

  destinations = [
    { type = "public", uri = "vault.barry.rocks" },
  ]

  policies = [
    { id = cloudflare_zero_trust_access_policy.barry_machine.id, precedence = 1 },
    { id = cloudflare_zero_trust_access_policy.barry_owner.id, precedence = 2 },
  ]
}
