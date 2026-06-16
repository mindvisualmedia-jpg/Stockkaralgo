terraform {
  required_version = ">= 1.2.0"
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = ">= 5.0.0"
    }
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
  zone    = var.zone
}

resource "google_compute_address" "stockkar" {
  name   = "${var.app_name}-stockkar-static-ip"
  region = var.region
}

resource "google_compute_firewall" "stockkar_web" {
  name    = "${var.app_name}-stockkar-web"
  network = "default"

  allow {
    protocol = "tcp"
    ports    = ["80", "443"]
  }

  source_ranges = ["0.0.0.0/0"]
  target_tags   = ["stockkar-web"]
}

resource "google_compute_firewall" "stockkar_ssh" {
  name    = "${var.app_name}-stockkar-ssh"
  network = "default"

  allow {
    protocol = "tcp"
    ports    = ["22"]
  }

  source_ranges = ["0.0.0.0/0"]
  target_tags   = ["stockkar-web"]
}

resource "google_compute_instance" "stockkar" {
  name         = "${var.app_name}-stockkar-backend"
  machine_type = var.machine_type
  zone         = var.zone
  tags         = ["stockkar-web"]

  boot_disk {
    initialize_params {
      image = "projects/ubuntu-os-cloud/global/images/family/ubuntu-2404-lts-amd64"
      size  = 20
      type  = "pd-standard"
    }
  }

  network_interface {
    network = "default"

    access_config {
      nat_ip = google_compute_address.stockkar.address
    }
  }

  metadata_startup_script = templatefile("${path.module}/startup-script.sh.tpl", {
    app_name    = var.app_name
    update_pin  = var.update_pin
    git_repo    = var.git_repo
    static_ip   = google_compute_address.stockkar.address
    domain      = "${var.app_name}.${google_compute_address.stockkar.address}.nip.io"
    alert_email = var.alert_email
  })
}
