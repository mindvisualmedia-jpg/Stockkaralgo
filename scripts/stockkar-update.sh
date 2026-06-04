#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${STOCKKAR_APP_DIR:-/home/ubuntu/stockkar_electron}"
DATA_DIR="${STOCKKAR_DATA_DIR:-/home/ubuntu/stockkar-data}"
BACKUP_DIR="${STOCKKAR_BACKUP_DIR:-/home/ubuntu/stockkar-backups}"
STATUS_FILE="$DATA_DIR/update_status.json"
OLD_COMMIT=""

write_status() {
  local status="$1"
  local message="$2"
  local version="${3:-}"
  printf '{"status":"%s","message":"%s","version":"%s","updatedAt":"%s"}\n' \
    "$status" "${message//\"/\\\"}" "$version" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"$STATUS_FILE"
  chown ubuntu:ubuntu "$STATUS_FILE"
}

rollback() {
  local reason="$1"
  if [ -n "$OLD_COMMIT" ]; then
    cd "$APP_DIR"
    sudo -u ubuntu git reset --hard "$OLD_COMMIT" || true
    sudo -u ubuntu npm install --omit=dev || true
    sudo -u ubuntu env PORT=7777 HOST=127.0.0.1 STOCKKAR_DATA_DIR="$DATA_DIR" pm2 restart stockkar-backend --update-env || true
  fi
  write_status "failed" "$reason"
  exit 1
}

mkdir -p "$DATA_DIR" "$BACKUP_DIR"
chown -R ubuntu:ubuntu "$DATA_DIR" "$BACKUP_DIR"
write_status "running" "Downloading and verifying the latest Stockkar release."

cd "$APP_DIR"
OLD_COMMIT="$(sudo -u ubuntu git rev-parse HEAD)"
sudo -u ubuntu git fetch origin main
NEW_COMMIT="$(sudo -u ubuntu git rev-parse origin/main)"

if [ "$OLD_COMMIT" = "$NEW_COMMIT" ]; then
  VERSION="$(node -p "require('./package.json').version")"
  write_status "current" "Stockkar is already up to date." "$VERSION"
  exit 0
fi

tar -czf "$BACKUP_DIR/data-$(date -u +%Y%m%dT%H%M%SZ).tar.gz" -C "$DATA_DIR" . || rollback "Could not back up user data."

sudo -u ubuntu git merge --ff-only origin/main || rollback "Update could not be applied cleanly."
sudo -u ubuntu npm install --omit=dev || rollback "Dependency installation failed."
node --check server.js || rollback "Server validation failed."

if [ -f "$APP_DIR/scripts/stockkar-update.sh" ]; then
  install -m 0755 "$APP_DIR/scripts/stockkar-update.sh" /usr/local/sbin/stockkar-update
fi

sudo -u ubuntu env PORT=7777 HOST=127.0.0.1 STOCKKAR_DATA_DIR="$DATA_DIR" pm2 restart stockkar-backend --update-env || rollback "Backend restart failed."
sleep 4
curl -fsS http://127.0.0.1:7777/api/auth/status >/dev/null || rollback "Health check failed after update."

VERSION="$(node -p "require('./package.json').version")"
write_status "complete" "Stockkar updated successfully." "$VERSION"

# Keep the latest ten small data backups.
ls -1t "$BACKUP_DIR"/data-*.tar.gz 2>/dev/null | tail -n +11 | xargs -r rm -f
