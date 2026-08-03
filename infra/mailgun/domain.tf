# =============================================================================
# Mailgun Domain & Routes for barry.rocks
# =============================================================================

import {
  to = mailgun_domain.barry_rocks
  id = "barry.rocks"
}

import {
  to = mailgun_route.catch_all
  id = "69a0c4dfd7eadd41f32de9d1"
}

resource "mailgun_domain" "barry_rocks" {
  name                         = var.domain
  spam_action                  = "disabled"
  wildcard                     = false
  use_automatic_sender_security = false
  web_scheme                   = "http"

  lifecycle {
    prevent_destroy = true
  }
}

resource "mailgun_route" "catch_all" {
  priority    = 0
  description = "Forward all barry.rocks emails to Gmail + webhook"
  expression  = "match_recipient(\".*@${var.domain}\")"

  actions = [
    "forward(\"${var.forward_email}, ${var.webhook_url}\")",
    "stop()",
  ]
}
