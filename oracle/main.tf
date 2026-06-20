terraform {
  required_version = ">= 1.2.0"
  required_providers {
    oci = {
      source  = "oracle/oci"
      version = ">= 5.0.0"
    }
  }
}

provider "oci" {
  region = var.region
}

data "oci_identity_availability_domains" "ads" {
  compartment_id = var.tenancy_ocid
}

data "oci_core_images" "ubuntu" {
  compartment_id           = var.compartment_ocid
  operating_system         = "Canonical Ubuntu"
  operating_system_version = "24.04"
  shape                    = var.instance_shape
  sort_by                  = "TIMECREATED"
  sort_order               = "DESC"
}

resource "oci_core_vcn" "stockkar" {
  compartment_id = var.compartment_ocid
  cidr_block     = "10.88.0.0/16"
  display_name   = "${var.app_name}-stockkar-vcn"
  dns_label      = "stockkar"
}

resource "oci_core_internet_gateway" "stockkar" {
  compartment_id = var.compartment_ocid
  vcn_id         = oci_core_vcn.stockkar.id
  display_name   = "${var.app_name}-stockkar-igw"
  enabled        = true
}

resource "oci_core_route_table" "public" {
  compartment_id = var.compartment_ocid
  vcn_id         = oci_core_vcn.stockkar.id
  display_name   = "${var.app_name}-stockkar-public-rt"

  route_rules {
    destination       = "0.0.0.0/0"
    destination_type  = "CIDR_BLOCK"
    network_entity_id = oci_core_internet_gateway.stockkar.id
  }
}

resource "oci_core_security_list" "public" {
  compartment_id = var.compartment_ocid
  vcn_id         = oci_core_vcn.stockkar.id
  display_name   = "${var.app_name}-stockkar-public-sl"

  egress_security_rules {
    protocol    = "all"
    destination = "0.0.0.0/0"
  }

  ingress_security_rules {
    protocol = "6"
    source   = "0.0.0.0/0"
    tcp_options {
      min = 22
      max = 22
    }
  }

  ingress_security_rules {
    protocol = "6"
    source   = "0.0.0.0/0"
    tcp_options {
      min = 80
      max = 80
    }
  }

  ingress_security_rules {
    protocol = "6"
    source   = "0.0.0.0/0"
    tcp_options {
      min = 443
      max = 443
    }
  }
}

resource "oci_core_subnet" "public" {
  compartment_id             = var.compartment_ocid
  vcn_id                     = oci_core_vcn.stockkar.id
  cidr_block                 = "10.88.1.0/24"
  display_name               = "${var.app_name}-stockkar-public-subnet"
  dns_label                  = "public"
  route_table_id             = oci_core_route_table.public.id
  security_list_ids          = [oci_core_security_list.public.id]
  prohibit_public_ip_on_vnic = false
}

resource "oci_core_instance" "stockkar" {
  availability_domain = data.oci_identity_availability_domains.ads.availability_domains[0].name
  compartment_id      = var.compartment_ocid
  display_name        = "${var.app_name}-stockkar-backend"
  shape               = var.instance_shape

  create_vnic_details {
    subnet_id        = oci_core_subnet.public.id
    assign_public_ip = false
    display_name     = "${var.app_name}-stockkar-vnic"
    hostname_label   = "stockkar"
  }

  source_details {
    source_type             = "image"
    source_id               = data.oci_core_images.ubuntu.images[0].id
    boot_volume_size_in_gbs = var.boot_volume_gb
  }

  metadata = merge(
    {
      user_data = base64encode(templatefile("${path.module}/cloud-init.yaml.tpl", {
        app_name = var.app_name
        git_repo = var.git_repo
      }))
    },
    var.ssh_public_key == "" ? {} : { ssh_authorized_keys = var.ssh_public_key }
  )
}

data "oci_core_vnic_attachments" "stockkar" {
  compartment_id = var.compartment_ocid
  instance_id    = oci_core_instance.stockkar.id
}

data "oci_core_vnic" "stockkar" {
  vnic_id = data.oci_core_vnic_attachments.stockkar.vnic_attachments[0].vnic_id
}

data "oci_core_private_ips" "stockkar" {
  vnic_id = data.oci_core_vnic.stockkar.id
}

resource "oci_core_public_ip" "stockkar" {
  compartment_id = var.compartment_ocid
  display_name   = "${var.app_name}-stockkar-static-ip"
  lifetime       = "RESERVED"
  private_ip_id  = data.oci_core_private_ips.stockkar.private_ips[0].id
}
