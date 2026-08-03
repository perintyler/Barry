variable "domain" {
  description = "Primary domain for Mailgun"
  type        = string
  default     = "barry.rocks"
}

# Must match the live catch-all route. The default was the literal placeholder
# "your-email@example.com", so a plan here showed a one-line diff that looked
# like harmless drift but would have redirected all inbound barry.rocks mail to
# a non-existent address.
variable "forward_email" {
  description = "Email address to forward inbound mail to"
  type        = string
  default     = "perintyler@gmail.com"
}

variable "webhook_url" {
  description = "Webhook URL for inbound email processing"
  type        = string
  default     = "https://barry.rocks/webhooks/mailgun/incoming"
}
