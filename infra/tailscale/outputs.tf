output "core_node_id" {
  description = "Tailscale node ID for core host"
  value       = data.tailscale_device.core.node_id
}

output "acl_source_file" {
  description = "ACL file used for policy"
  value       = var.acl_file
}
