variable "cloudflare_account_id" {
  description = "Cloudflare account ID"
  type        = string
}

variable "cloudflare_api_token" {
  description = "Cloudflare API token (Zone DNS + Tunnel permissions)"
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
