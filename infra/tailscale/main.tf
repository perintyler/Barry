terraform {
  required_version = ">= 1.5"

  required_providers {
    tailscale = {
      source  = "tailscale/tailscale"
      version = ">= 0.16"
    }
  }
}

provider "tailscale" {
  # Auth via env vars (recommended):
  #   TAILSCALE_API_KEY
  #   TAILSCALE_TAILNET
  # or OAuth client credentials:
  #   TAILSCALE_OAUTH_CLIENT_ID
  #   TAILSCALE_OAUTH_CLIENT_SECRET
}

locals {
  acl_policy = file(var.acl_file)
}

# Step 2: apply the tailnet policy from source-of-truth ACL file.
resource "tailscale_acl" "barry" {
  acl = local.acl_policy

  # Keep default false for safety; set true only for initial bootstrap.
  overwrite_existing_content = var.overwrite_existing_policy
  reset_acl_on_destroy       = false
}

# Step 1: resolve devices and apply role tags.
data "tailscale_device" "core" {
  hostname = var.core_hostname
  wait_for = var.device_lookup_wait
}

resource "tailscale_device_tags" "core" {
  device_id = data.tailscale_device.core.node_id
  tags      = [var.core_tag]
  depends_on = [
    tailscale_acl.barry
  ]
}
