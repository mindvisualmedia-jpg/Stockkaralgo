# Stockkar Google Cloud Template

This Terraform bundle creates a personal Stockkar Algo app on Google Cloud.

## What It Creates

- One Compute Engine VM
- One static external IP
- Firewall rules for ports 80 and 443
- Nginx reverse proxy
- Stockkar app from the public GitHub repository
- One-click updater support with your private PIN

## User Inputs

- `project_id`: your Google Cloud project ID
- `app_name`: lowercase name, for example `rahul-algo`
- `update_pin`: private 6 to 12 digit update PIN
- `alert_email`: optional email for HTTPS certificate registration

## Notes

Google Cloud free-tier eligibility depends on your account, region, and Google Cloud billing terms. Keep the default `e2-micro` machine type unless you intentionally want a paid VM.
