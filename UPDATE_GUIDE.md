# Stockkar One-Click Updates

New AWS installations include the updater automatically. The personal AWS URL serves both the frontend and backend, so one protected update updates the full app.

## Existing AWS installation: one-time migration

Run these commands once in the EC2 terminal:

```bash
cd /home/ubuntu/stockkar_electron
git pull --ff-only origin main
sudo bash scripts/install-updater.sh
```

Then open the personal AWS app URL, go to **Settings > Software Updates**, and create a 6 to 12 digit Update PIN.

## Normal updates

1. Open the personal AWS app URL.
2. Go to **Settings > Software Updates**.
3. Unlock with the Update PIN.
4. Click **Update Stockkar**.

The updater backs up user data, downloads the latest release, validates it, restarts the backend, performs a health check, and rolls back if the health check fails.

Updates should be performed outside market hours. The app requires an extra confirmation for updates during market hours.
