terraform {
  required_version = ">= 1.5"

  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.0"
    }
  }
}

provider "cloudflare" {
  api_token = var.cloudflare_tf_token
}

resource "cloudflare_zone" "works" {
  account = { id = var.cloudflare_account_id }
  name    = "barry.works"
}

resource "cloudflare_zone" "rocks" {
  account = { id = var.cloudflare_account_id }
  name    = "barry.rocks"
}