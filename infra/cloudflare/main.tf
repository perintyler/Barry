terraform {
  required_version = ">= 1.5"

  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 4.0"
    }
  }
}

provider "cloudflare" {
  api_token = var.cloudflare_api_token
}

resource "cloudflare_zone" "works" {
  account_id = var.cloudflare_account_id
  zone       = "barry.works"
  plan       = "free"
}

resource "cloudflare_zone" "rocks" {
  account_id = var.cloudflare_account_id
  zone       = "barry.rocks"
  plan       = "free"
}