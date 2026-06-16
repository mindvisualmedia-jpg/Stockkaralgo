variable "project_id" {
  description = "Google Cloud project ID where Stockkar resources will be created."
  type        = string
}

variable "region" {
  description = "Google Cloud region. Keep default unless you know your free-tier region."
  type        = string
  default     = "us-central1"
}

variable "zone" {
  description = "Google Cloud zone. Keep this inside the selected region."
  type        = string
  default     = "us-central1-a"
}

variable "app_name" {
  description = "Easy app name used in the personal URL, for example rahul-algo. Use lowercase letters, numbers, and hyphens."
  type        = string
  default     = "my-stockkar"

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{2,29}$", var.app_name))
    error_message = "Use 3-30 lowercase letters, numbers, and hyphens, starting with a letter."
  }
}

variable "update_pin" {
  description = "Private 6 to 12 digit PIN for protected one-click updates."
  type        = string
  sensitive   = true

  validation {
    condition     = can(regex("^[0-9]{6,12}$", var.update_pin))
    error_message = "Use only digits, 6 to 12 characters."
  }
}

variable "alert_email" {
  description = "Email used by Let's Encrypt if HTTPS certificate setup succeeds."
  type        = string
  default     = ""
}

variable "machine_type" {
  description = "Google Cloud free-tier friendly VM size. Keep default unless unavailable."
  type        = string
  default     = "e2-micro"
}

variable "git_repo" {
  description = "Public Stockkar repository. Keep default for normal setup."
  type        = string
  default     = "https://github.com/mindvisualmedia-jpg/Stockkaralgo.git"
}
