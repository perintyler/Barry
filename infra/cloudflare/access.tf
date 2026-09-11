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

# Google sign-in, offered alongside the PIN rather than replacing it.
#
# The PIN stays because it is the fallback that cannot lock anyone out: it
# depends on nothing but email delivery, whereas this depends on a Google
# client that can be deleted, have its secret rotated, or (being in Testing)
# drop an address from its test-user list. `auto_redirect_to_identity` is off
# on every app for the same reason — with two IdPs, skipping the chooser would
# silently commit each app to one of them.
#
# The client lives in the Barry Google Cloud project (barry-485300) and must
# list https://<access_team_name>.cloudflareaccess.com/cdn-cgi/access/callback
# as an authorized redirect URI; Google rejects any request whose redirect_uri
# is not registered. Note the team domain is barry-works, NOT the older
# footlama one that an earlier client was built against.
resource "cloudflare_zero_trust_access_identity_provider" "google" {
  account_id = var.cloudflare_account_id
  name       = "Google"
  type       = "google"

  config = {
    client_id     = var.access_google_client_id
    client_secret = var.access_google_client_secret
  }

  lifecycle {
    # The API returns the secret redacted, which would otherwise show as
    # perpetual drift and re-send the credential on every apply.
    ignore_changes = [config]
  }
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
  allowed_idps = [
    cloudflare_zero_trust_access_identity_provider.google.id,
    cloudflare_zero_trust_access_identity_provider.otp.id,
  ]
  auto_redirect_to_identity = false

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

  allowed_idps = [
    cloudflare_zero_trust_access_identity_provider.google.id,
    cloudflare_zero_trust_access_identity_provider.otp.id,
  ]
  auto_redirect_to_identity = false

  destinations = [
    { type = "public", uri = "vault.barry.rocks" },
  ]

  policies = [
    { id = cloudflare_zero_trust_access_policy.barry_machine.id, precedence = 1 },
    { id = cloudflare_zero_trust_access_policy.barry_owner.id, precedence = 2 },
  ]
}

# =============================================================================
# Cloudflare Access — metrics.barry.rocks
# =============================================================================

# The metrics dashboard reports on Barry itself: service health, resource
# trends, token spend and the Postgres-backed usage panels. The origin is a
# local tsx server on localhost:4870 with no authentication of its own — the
# tunnel publishes it, so this application is the only gate in front of it.
#
# Same policies as the other apps rather than duplicates, for the reason given
# above: the allowed email stays defined in exactly one place.
#
# barry_machine is included so scripted checks (uptime probes, `barry` CLI
# calls) can reach the dashboard with the service token instead of a human
# login. Drop it from `policies` if only browser access is ever wanted.
resource "cloudflare_zero_trust_access_application" "barry_metrics" {
  zone_id          = cloudflare_zone.rocks.id
  name             = "Barry Metrics"
  domain           = "metrics.barry.rocks"
  type             = "self_hosted"
  session_duration = "24h"

  allowed_idps = [
    cloudflare_zero_trust_access_identity_provider.google.id,
    cloudflare_zero_trust_access_identity_provider.otp.id,
  ]
  auto_redirect_to_identity = false

  destinations = [
    { type = "public", uri = "metrics.barry.rocks" },
  ]

  policies = [
    { id = cloudflare_zero_trust_access_policy.barry_machine.id, precedence = 1 },
    { id = cloudflare_zero_trust_access_policy.barry_owner.id, precedence = 2 },
  ]
}

# =============================================================================
# Cloudflare Access — plans.barry.rocks
# =============================================================================

# The plans bag's web app — write and edit plans from a phone. The origin is a
# local tsx server on localhost:4880 with no authentication of its own — the
# shared tunnel publishes it (bags/plans/bag.yaml, services.web.tunnel), so
# this application is the only gate in front of a read/write store and must
# exist before that tunnel hostname does.
#
# Same policies as the other apps rather than duplicates, for the reason given
# above: the allowed email stays defined in exactly one place. barry_machine is
# included so the MCP tools' HTTP path could ride the service token if it is
# ever pointed at the public hostname instead of loopback.
resource "cloudflare_zero_trust_access_application" "barry_plans" {
  zone_id          = cloudflare_zone.rocks.id
  name             = "Barry Plans"
  domain           = "plans.barry.rocks"
  type             = "self_hosted"
  session_duration = "24h"

  allowed_idps = [
    cloudflare_zero_trust_access_identity_provider.google.id,
    cloudflare_zero_trust_access_identity_provider.otp.id,
  ]
  auto_redirect_to_identity = false

  destinations = [
    { type = "public", uri = "plans.barry.rocks" },
  ]

  policies = [
    { id = cloudflare_zero_trust_access_policy.barry_machine.id, precedence = 1 },
    { id = cloudflare_zero_trust_access_policy.barry_owner.id, precedence = 2 },
  ]
}
