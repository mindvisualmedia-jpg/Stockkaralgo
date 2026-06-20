#!/usr/bin/env bash
# Universal one-command installer for Stockkar Algo on a fresh Ubuntu server.
# Works on any provider (InterServer, Azure, DigitalOcean, Hetzner, ...).
#
#   curl -fsSL https://raw.githubusercontent.com/mindvisualmedia-jpg/Stockkaralgo/main/scripts/install.sh | sudo bash
#
# Override defaults with env vars, e.g.:
#   STOCKKAR_APP_NAME=monish sudo bash install.sh
set -euo pipefail

REPO="${STOCKKAR_REPO:-https://github.com/mindvisualmedia-jpg/Stockkaralgo.git}"
APP_USER="${STOCKKAR_USER:-stockkar}"
APP_DIR="${STOCKKAR_APP_DIR:-/home/$APP_USER/stockkar_electron}"
DATA_DIR="${STOCKKAR_DATA_DIR:-/home/$APP_USER/stockkar-data}"
BACKUP_DIR="${STOCKKAR_BACKUP_DIR:-/home/$APP_USER/stockkar-backups}"
PORT="${STOCKKAR_PORT:-7777}"
APP_NAME="${STOCKKAR_APP_NAME:-stockkar}"     # used for the nip.io hostname
NODE_MAJOR="${STOCKKAR_NODE_MAJOR:-20}"

if [ "$(id -u)" -ne 0 ]; then
  echo "Please run as root (use sudo)." >&2
  exit 1
fi

echo "==> Installing base packages..."
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y git curl ca-certificates ufw nginx certbot python3-certbot-nginx

echo "==> Ensuring Node.js ${NODE_MAJOR}.x..."
NODE_OK=0
if command -v node >/dev/null 2>&1; then
  [ "$(node -v | sed 's/v\([0-9]*\).*/\1/')" -ge 18 ] && NODE_OK=1
fi
if [ "$NODE_OK" -ne 1 ]; then
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
  apt-get install -y nodejs
fi
npm install -g pm2 >/dev/null 2>&1 || npm install -g pm2

echo "==> Service user: $APP_USER"
id "$APP_USER" >/dev/null 2>&1 || useradd -m -s /bin/bash "$APP_USER"

echo "==> Fetching app to $APP_DIR..."
if [ -d "$APP_DIR/.git" ]; then
  sudo -u "$APP_USER" git -C "$APP_DIR" fetch origin main && sudo -u "$APP_USER" git -C "$APP_DIR" reset --hard origin/main
else
  sudo -u "$APP_USER" git clone "$REPO" "$APP_DIR"
fi
cd "$APP_DIR"
sudo -u "$APP_USER" npm install --omit=dev || sudo -u "$APP_USER" npm install
mkdir -p "$DATA_DIR" "$BACKUP_DIR"
chown -R "$APP_USER:$APP_USER" "$DATA_DIR" "$BACKUP_DIR"

echo "==> Starting backend under PM2 (bound to 127.0.0.1:$PORT)..."
if sudo -u "$APP_USER" pm2 describe stockkar-backend >/dev/null 2>&1; then
  sudo -u "$APP_USER" env PORT="$PORT" HOST=127.0.0.1 STOCKKAR_DATA_DIR="$DATA_DIR" pm2 restart stockkar-backend --update-env
else
  sudo -u "$APP_USER" env PORT="$PORT" HOST=127.0.0.1 STOCKKAR_DATA_DIR="$DATA_DIR" \
    pm2 start "$APP_DIR/server.js" --name stockkar-backend \
    --max-memory-restart 350M --node-args="--max-old-space-size=320"
fi
sudo -u "$APP_USER" pm2 save
env PATH="$PATH:/usr/bin" pm2 startup systemd -u "$APP_USER" --hp "/home/$APP_USER" >/dev/null 2>&1 || true

echo "==> Configuring nginx reverse proxy..."
PUBLIC_IP="$(curl -fsS https://api.ipify.org 2>/dev/null || curl -fsS https://ifconfig.me 2>/dev/null || hostname -I | awk '{print $1}')"
DOMAIN="${APP_NAME}.${PUBLIC_IP}.nip.io"
cat >/etc/nginx/sites-available/stockkar <<NGINX
server {
  listen 80 default_server;
  server_name ${DOMAIN} ${PUBLIC_IP} _;
  client_max_body_size 5m;
  location / {
    proxy_pass http://127.0.0.1:${PORT};
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \$scheme;
    proxy_http_version 1.1;
  }
}
NGINX
rm -f /etc/nginx/sites-enabled/default
ln -sf /etc/nginx/sites-available/stockkar /etc/nginx/sites-enabled/stockkar
nginx -t && systemctl reload nginx

echo "==> Firewall (allow SSH + web)..."
ufw allow 22/tcp >/dev/null 2>&1 || true
ufw allow 80/tcp >/dev/null 2>&1 || true
ufw allow 443/tcp >/dev/null 2>&1 || true
ufw --force enable >/dev/null 2>&1 || true

echo "==> Attempting HTTPS via Let's Encrypt + nip.io..."
SCHEME=http
if certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --register-unsafely-without-email --redirect >/dev/null 2>&1; then
  SCHEME=https
fi

echo "==> Installing one-click updater..."
STOCKKAR_USER="$APP_USER" STOCKKAR_PORT="$PORT" STOCKKAR_APP_DIR="$APP_DIR" \
  STOCKKAR_DATA_DIR="$DATA_DIR" STOCKKAR_BACKUP_DIR="$BACKUP_DIR" \
  bash "$APP_DIR/scripts/install-updater.sh"

echo
echo "=================== Stockkar Algo is ready ==================="
echo "  Open:   ${SCHEME}://${DOMAIN}"
echo "  (or)    ${SCHEME}://${PUBLIC_IP}"
echo
echo "  1) Set your App Lock PIN on first open."
echo "  2) Connect your broker (Dhan / Zerodha / Angel) in Settings."
echo "  3) Updates: Settings -> Software Updates (one-click, git pull)."
[ "$SCHEME" = "http" ] && echo "  NOTE: HTTPS auto-setup didn't complete; you're on HTTP. Re-run:" && \
  echo "        certbot --nginx -d ${DOMAIN} --redirect"
echo "============================================================="
