variable "do_token" {
  description = "DigitalOcean personal access token (custom scopes, see README) for this project."
  type        = string
  sensitive   = true
}

variable "cloudflare_api_token" {
  description = "Cloudflare API token with Zone:DNS:Edit on this domain, Account:Workers R2 Storage:Edit and Account:Workers Scripts:Edit (see README)."
  type        = string
  sensitive   = true
}

variable "cloudflare_zone_id" {
  description = "Zone ID from the domain's Overview page in Cloudflare (right-hand column)."
  type        = string
}

variable "cloudflare_account_id" {
  description = "Cloudflare account ID (dashboard home → the account's ⋯ menu → Copy account ID, or the right-hand column of the domain's Overview page)."
  type        = string
}

variable "domain" {
  description = "Apex domain the app is served on, e.g. example.com. www redirects to it."
  type        = string
}

variable "region" {
  description = "DigitalOcean region. nyc1/nyc3 = New York, sfo3 = San Francisco, atl1 = Atlanta."
  type        = string
  default     = "nyc3"
}

variable "droplet_size" {
  description = "Droplet size slug. List them with `doctl compute size list`."
  type        = string
  default     = "s-1vcpu-1gb" # $6/mo: 1 vCPU, 1 GB RAM, 25 GB SSD
}

variable "data_volume_size" {
  description = "Size in GB of the volume holding Postgres data and TLS certificates."
  type        = number
  default     = 10
}

variable "admin_ssh_public_key_path" {
  description = "Your SSH public key, for the `ops` user (sudo)."
  type        = string
  default     = "~/.ssh/id_ed25519.pub"
}

variable "ssh_allowed_cidrs" {
  description = "Networks allowed to reach SSH. Open by default because GitHub-hosted runners have no fixed IPs; access is key-only and fail2ban-protected."
  type        = list(string)
  default     = ["0.0.0.0/0", "::/0"]
}

variable "state_passphrase" {
  description = "Encrypts the OpenTofu state and saved plans (at least 16 characters). Keep it in your password manager: without it the state can't be read."
  type        = string
  sensitive   = true
}

variable "resend_dkim_public_key" {
  description = "Value of the resend._domainkey TXT record Resend shows after adding mail.<domain> (starts with p=)."
  type        = string

  validation {
    condition     = startswith(var.resend_dkim_public_key, "p=")
    error_message = "Paste the DKIM TXT value from Resend, starting with p=."
  }
}

variable "betterstack_api_token" {
  description = "Better Stack Incidents API token (Settings → API tokens → Team-based tokens). See README, Monitoring."
  type        = string
  sensitive   = true
}

variable "github_repository" {
  description = "The repository whose factory sweeps the clock starts (ADR-0060), as owner/name."
  type        = string
  default     = "brianpatterson/roundtable"
}

variable "github_factory_clock_token" {
  description = "Fine-grained GitHub token for the factory's clock: this repository only, Actions read and write, nothing else (see README, Factory clock)."
  type        = string
  sensitive   = true

  # Empty, the Worker would deploy and fail every tick with a 401; fail at plan instead.
  validation {
    condition     = startswith(var.github_factory_clock_token, "github_pat_")
    error_message = "Paste a fine-grained GitHub token (it starts with github_pat_); see README, Factory clock."
  }
}
