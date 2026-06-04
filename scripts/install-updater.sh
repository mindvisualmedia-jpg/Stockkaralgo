#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${STOCKKAR_APP_DIR:-/home/ubuntu/stockkar_electron}"
DATA_DIR="${STOCKKAR_DATA_DIR:-/home/ubuntu/stockkar-data}"
BACKUP_DIR="${STOCKKAR_BACKUP_DIR:-/home/ubuntu/stockkar-backups}"

if [ "$(id -u)" -ne 0 ]; then
  echo "Run this installer with sudo."
  exit 1
fi

mkdir -p "$DATA_DIR" "$BACKUP_DIR"
for file in algo_schedule.json order_log.json dhan_token.json broker_tokens.json update_pin.json update_status.json; do
  if [ -f "$APP_DIR/$file" ] && [ ! -f "$DATA_DIR/$file" ]; then
    cp "$APP_DIR/$file" "$DATA_DIR/$file"
  fi
  if [ -f "$APP_DIR/data/$file" ] && [ ! -f "$DATA_DIR/$file" ]; then
    cp "$APP_DIR/data/$file" "$DATA_DIR/$file"
  fi
done
chown -R ubuntu:ubuntu "$DATA_DIR" "$BACKUP_DIR"

install -m 0755 "$APP_DIR/scripts/stockkar-update.sh" /usr/local/sbin/stockkar-update
[ -f "$APP_DIR/scripts/stockkar-backup.sh" ] && install -m 0755 "$APP_DIR/scripts/stockkar-backup.sh" /usr/local/sbin/stockkar-backup
[ -f "$APP_DIR/scripts/stockkar-health.sh" ] && install -m 0755 "$APP_DIR/scripts/stockkar-health.sh" /usr/local/sbin/stockkar-health
cat >/etc/systemd/system/stockkar-update.service <<SERVICE
[Unit]
Description=Stockkar verified application update
After=network-online.target

[Service]
Type=oneshot
User=root
Environment=STOCKKAR_APP_DIR=$APP_DIR
Environment=STOCKKAR_DATA_DIR=$DATA_DIR
Environment=STOCKKAR_BACKUP_DIR=$BACKUP_DIR
ExecStart=/usr/local/sbin/stockkar-update
SERVICE

cat >/etc/sudoers.d/stockkar-update <<SUDOERS
ubuntu ALL=(root) NOPASSWD: /usr/bin/systemctl start --no-block stockkar-update.service
SUDOERS
chmod 0440 /etc/sudoers.d/stockkar-update
systemctl daemon-reload

sudo -u ubuntu env PORT=7777 HOST=127.0.0.1 STOCKKAR_DATA_DIR="$DATA_DIR" pm2 restart stockkar-backend --update-env
sudo -u ubuntu pm2 save
echo "Stockkar updater installed. Open the app and create your Update PIN in Settings."
