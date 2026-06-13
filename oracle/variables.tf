variable "tenancy_ocid" {
  description = "Oracle tenancy OCID. Resource Manager usually fills this automatically."
  type        = string
}

variable "compartment_ocid" {
  description = "Compartment OCID where Stockkar resources will be created."
  type        = string
}

variable "region" {
  description = "Oracle Cloud region, for example ap-mumbai-1 or eu-stockholm-1."
  type        = string
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

variable "instance_shape" {
  description = "Oracle Always Free AMD shape. Keep default unless unavailable in your region."
  type        = string
  default     = "VM.Standard.E2.1.Micro"
}

variable "boot_volume_gb" {
  description = "Boot disk size. Keep 50 GB for Oracle image compatibility and free-tier headroom."
  type        = number
  default     = 50
}

variable "git_repo" {
  description = "Public Stockkar repository. Keep default for normal setup."
  type        = string
  default     = "https://github.com/mindvisualmedia-jpg/Stockkaralgo.git"
}
