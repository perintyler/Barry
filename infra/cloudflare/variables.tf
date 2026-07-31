variable "cloudflare_account_id" {
  description = "Cloudflare account ID"
  type        = string
}

# Deliberately NOT named cloudflare_api_token: the repo also has an unrelated
# CLOUDFLARE_API_TOKEN env var (Caddy DNS-01, `barry cloudflare`, preflight) that
# holds a DIFFERENT credential. Naming this one *_tf_token keeps the two apart.
#
# Needs Edit on: Access (Apps and Policies; Organizations, IdPs and Groups;
# Service Tokens), Tunnel, R2, D1, Zone, DNS, Email Routing Rules — Terraform
# owns these as resources, so read-only is not enough.
variable "cloudflare_tf_token" {
  description = "Cloudflare API token used by Terraform (distinct from CLOUDFLARE_API_TOKEN)"
  type        = string
  sensitive   = true
  default     = ""
}

variable "selfping_api_key" {
  description = "Selfping.com API key for SMS notifications"
  type        = string
  sensitive   = true
  default     = ""
}

variable "tunnel_secret" {
  description = "Base64-encoded secret for the Barry Cloudflare Tunnel"
  type        = string
  sensitive   = true
  default     = ""
}

variable "access_allowed_email" {
  description = "Email address allowed through Cloudflare Access for Barry"
  type        = string
  sensitive   = true
}

# Team domain prefix for the Zero Trust login page:
# https://<access_team_name>.cloudflareaccess.com
# Historically "footlama" (auto-derived from footlama.studio when Zero Trust was
# first enabled). Changing this signs everyone out.
# NOTE: team names are globally unique across all Cloudflare customers, not just
# this account. Plain "barry" is already taken by someone else (error 11003
# auth_domain_not_available), hence "barry-works".
variable "access_team_name" {
  description = "Cloudflare Zero Trust team name (the <team>.cloudflareaccess.com prefix)"
  type        = string
  default     = "barry-works"
}
