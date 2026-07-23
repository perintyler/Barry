variable "acl_file" {
  description = "Path to ACL policy file (JSON or HuJSON)"
  type        = string
  default     = "./policy.acl.jsonc"
}

variable "core_hostname" {
  description = "Short hostname of Barry core node in Tailscale (for tag:barry-core)"
  type        = string
}

variable "core_tag" {
  description = "Tag applied to core node"
  type        = string
  default     = "tag:barry-core"
}

variable "device_lookup_wait" {
  description = "Max wait for device lookups (e.g., when a node just joined)"
  type        = string
  default     = "60s"
}

variable "overwrite_existing_policy" {
  description = "Set true only for first bootstrap if ACL policy is not yet imported"
  type        = bool
  default     = false
}
