output "works_zone_id" {
  value = cloudflare_zone.works.id
}

output "works_nameservers" {
  value = cloudflare_zone.works.name_servers
}

output "barry_tunnel_id" {
  value = cloudflare_tunnel.barry_mac.id
}

output "barry_tunnel_token" {
  value     = cloudflare_tunnel.barry_mac.tunnel_token
  sensitive = true
}

output "barry_access_service_token_id" {
  value = cloudflare_access_service_token.barry_machine.client_id
}

output "barry_access_service_token_secret" {
  value     = cloudflare_access_service_token.barry_machine.client_secret
  sensitive = true
}

output "rocks_zone_id" {
  value = cloudflare_zone.rocks.id
}

output "rocks_nameservers" {
  value = cloudflare_zone.rocks.name_servers
}

output "email_d1_database_id" {
  value       = cloudflare_d1_database.email.id
  description = "D1 database_id for wrangler.jsonc EMAIL_DB binding"
}

output "email_r2_bucket_name" {
  value       = cloudflare_r2_bucket.email_bodies.name
  description = "R2 bucket_name for wrangler.jsonc EMAIL_BODIES binding"
}
