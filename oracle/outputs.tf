output "StaticIp" {
  description = "Static IP to paste in broker static IP settings."
  value       = oci_core_public_ip.stockkar.ip_address
}

output "BackendUrl" {
  description = "Personal Stockkar app and backend URL."
  value       = "https://${var.app_name}.${oci_core_public_ip.stockkar.ip_address}.nip.io"
}

output "AppUrl" {
  description = "Open this personal Stockkar app URL after setup."
  value       = "https://${var.app_name}.${oci_core_public_ip.stockkar.ip_address}.nip.io"
}

output "BackendHealthUrl" {
  description = "Test URL for backend status."
  value       = "https://${var.app_name}.${oci_core_public_ip.stockkar.ip_address}.nip.io/api/auth/status"
}

output "InstanceShape" {
  description = "Oracle VM shape used by this app."
  value       = var.instance_shape
}
