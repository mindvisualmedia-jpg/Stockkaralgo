output "StaticIp" {
  description = "Static IP to paste in broker static IP settings."
  value       = google_compute_address.stockkar.address
}

output "BackendUrl" {
  description = "Personal Stockkar app and backend URL."
  value       = "https://${var.app_name}.${google_compute_address.stockkar.address}.nip.io"
}

output "AppUrl" {
  description = "Open this personal Stockkar app URL after setup."
  value       = "https://${var.app_name}.${google_compute_address.stockkar.address}.nip.io"
}

output "BackendHealthUrl" {
  description = "Test URL for backend status."
  value       = "https://${var.app_name}.${google_compute_address.stockkar.address}.nip.io/api/auth/status"
}

output "InstanceShape" {
  description = "Google Cloud VM shape used by this app."
  value       = var.machine_type
}
