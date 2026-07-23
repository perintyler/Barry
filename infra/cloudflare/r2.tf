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

