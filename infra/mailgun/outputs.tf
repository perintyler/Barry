output "receiving_records" {
  description = "DNS records required for receiving email (MX)"
  value       = mailgun_domain.barry_rocks.receiving_records_set
}

output "sending_records" {
  description = "DNS records required for sending email (SPF, DKIM)"
  value       = mailgun_domain.barry_rocks.sending_records_set
}

output "smtp_login" {
  description = "SMTP login for sending email"
  value       = mailgun_domain.barry_rocks.smtp_login
}
