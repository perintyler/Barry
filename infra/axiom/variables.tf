variable "axiom_api_token" {
  description = "Axiom API token for authentication (set via TF_VAR_axiom_api_token env var)"
  type        = string
  sensitive   = true
}

variable "axiom_org_id" {
  description = "Axiom organization ID (leave empty for personal orgs)"
  type        = string
  default     = ""
}
