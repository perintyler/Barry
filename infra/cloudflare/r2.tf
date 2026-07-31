# =============================================================================
# R2 Buckets
# =============================================================================

resource "cloudflare_r2_bucket" "artifacts" {
  account_id = var.cloudflare_account_id
  name       = "barry-artifacts-storage"
  location   = "ENAM"
}

resource "cloudflare_r2_bucket" "assets" {
  account_id = var.cloudflare_account_id
  name       = "barry-assets"
  location   = "ENAM"
}

resource "cloudflare_r2_bucket" "email_bodies" {
  account_id = var.cloudflare_account_id
  name       = "barry-rocks-email-bodies"
  location   = "ENAM"
}

# Off-machine destination for the nightly backup job (scripts/jobs/backup).
# Backups are useless on the disk they protect against, and the vault snapshot
# inside them is the only copy of 25 API tokens.
#
# The job encrypts the entire payload with age before upload, so this bucket
# holds no readable data — the Postgres dump carries profile auth tokens and
# tfstate can carry credentials the API will not return again. Keep it private
# regardless.
resource "cloudflare_r2_bucket" "backups" {
  account_id = var.cloudflare_account_id
  name       = "barry-backups"
  location   = "ENAM"
}

