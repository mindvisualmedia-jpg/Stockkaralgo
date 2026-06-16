#!/bin/bash
set -euo pipefail

APP_NAME="${app_name}"
UPDATE_PIN="${update_pin}"
GIT_REPO="${git_repo}"
STATIC_IP="${static_ip}"
DOMAIN="${domain}"
ALERT_EMAIL="${alert_email}"
APP_DIR=/home/ubuntu/stockkar_electron
DATA_DIR=/home/ubuntu/stockkar-data
BACKUP_DIR=/home/ubuntu/stockkar-backups

export DEBIAN_FRONTEND=noninteractive

echo "Installing Stockkar on Google Cloud..."
for i in $(seq 1 90); do
  if curl -fsS --connect-timeout 5 https://api.ipify.org >/tmp/stockkar-public-ip.txt 2>/dev/null; then
    break
  fi
  sleep 10
done

apt-get update
apt-get install -y git curl nginx nodejs npm certbot python3-certbot-nginx

if ! id ubuntu >/dev/null 2>&1; then
  useradd -m -s /bin/bash ubuntu
fi

npm install -g pm2 || true
mkdir -p "$DATA_DIR" "$BACKUP_DIR"
chown -R ubuntu:ubuntu "$DATA_DIR" "$BACKUP_DIR"

if [ ! -d "$APP_DIR/.git" ]; then
  rm -rf "$APP_DIR"
  sudo -u ubuntu git clone "$GIT_REPO" "$APP_DIR"
fi

cd "$APP_DIR"
sudo -u ubuntu git pull --ff-only || true
npm install --omit=dev || npm install
chown -R ubuntu:ubuntu "$APP_DIR"

if [ -f "$APP_DIR/scripts/stockkar-update.sh" ]; then
  install -m 0755 "$APP_DIR/scripts/stockkar-update.sh" /usr/local/sbin/stockkar-update
fi
if [ -f "$APP_DIR/scripts/stockkar-backup.sh" ]; then
  install -m 0755 "$APP_DIR/scripts/stockkar-backup.sh" /usr/local/sbin/stockkar-backup
fi

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

sudo -u ubuntu env DATA_DIR="$DATA_DIR" UPDATE_PIN="$UPDATE_PIN" node -e "const fs=require('fs'),crypto=require('crypto'),path=require('path');const pin=process.env.UPDATE_PIN||'';const file=path.join(process.env.DATA_DIR,'update_pin.json');if(!fs.existsSync(file)&&/^\\d{6,12}$/.test(pin)){const salt=crypto.randomBytes(16).toString('hex');const hash=crypto.scryptSync(pin,salt,64).toString('hex');fs.writeFileSync(file,JSON.stringify({salt,hash,createdAt:new Date().toISOString(),source:'gcp-setup'},null,2),{mode:0o600});}"
sudo -u ubuntu pm2 delete stockkar-backend || true
sudo -u ubuntu env PORT=7777 HOST=127.0.0.1 STOCKKAR_DATA_DIR="$DATA_DIR" pm2 start "$APP_DIR/server.js" --name stockkar-backend
sudo -u ubuntu pm2 save
env PATH=$PATH:/usr/bin pm2 startup systemd -u ubuntu --hp /home/ubuntu || true

cat >/etc/nginx/sites-available/stockkar <<NGINX
server {
  listen 80 default_server;
  server_name $DOMAIN $STATIC_IP;
  location / {
    proxy_pass http://127.0.0.1:7777;
    proxy_http_version 1.1;
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \$scheme;
  }
}
NGINX
rm -f /etc/nginx/sites-enabled/default
ln -sf /etc/nginx/sites-available/stockkar /etc/nginx/sites-enabled/stockkar
nginx -t
systemctl reload nginx

if [ -n "$ALERT_EMAIL" ]; then
  certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos -m "$ALERT_EMAIL" --redirect || true
else
  certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --register-unsafely-without-email --redirect || true
fi

curl -fsS http://127.0.0.1:7777/api/auth/status >/dev/null || true
echo "Stockkar Google Cloud setup complete for $DOMAIN"
