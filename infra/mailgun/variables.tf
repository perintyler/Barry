variable "domain" {
  description = "Primary domain for Mailgun"
  type        = string
  default     = "barry.rocks"
}

variable "forward_email" {
  description = "Email address to forward inbound mail to"
  type        = string
  default     = "your-email@example.com"
}

variable "webhook_url" {
  description = "Webhook URL for inbound email processing"
  type        = string
  default     = "https://barry.rocks/webhooks/mailgun/incoming"
}
