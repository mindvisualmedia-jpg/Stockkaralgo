#!/usr/bin/env bash
# Stockkar VEE bootstrap — provisions a fresh Ubuntu VPS (InterServer, AWS,
# Azure, anywhere) into a running Stockkar box: Node 20 + pm2 + the app on the
# chosen branch, bound on the public interface, auto-started on reboot.
#
# Usage (on a fresh Ubuntu VPS, as root or a sudo user):
#   BRANCH=main REPO_URL="https://<github-token>@github.com/mindvisualmedia-jpg/Stockkaralgo.git" bash bootstrap.sh
#
# All settings are env-overridable; defaults below.
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/mindvisualmedia-jpg/Stockkaralgo.git}"  # private repo -> embed a PAT or use a deploy key
BRANCH="${BRANCH:-main}"                                   # main = production users; staging = test box
APP_DIR="${APP_DIR:-$HOME/stockkar_electron}"
DATA_DIR="${DATA_DIR:-$HOME/stockkar-data}"
PORT="${PORT:-7777}"
APP_NAME="${APP_NAME:-stockkar}"
INSECURE_COOKIE="${INSECURE_COOKIE:-1}"                    # 1 for HTTP-only box (no nginx/TLS); 0 behind HTTPS
PROTECT_AFTER_FILL="${PROTECT_AFTER_FILL:-0}"             # 1 to place Forever/GTT only after the entry fills

SUDO=""; [ "$(id -u)" -ne 0 ] && SUDO="sudo"

echo "==> Installing Node 20 + git + pm2"
if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | $SUDO bash -
fi
$SUDO apt-get install -y nodejs git
$SUDO npm install -g pm2

echo "==> Fetching app ($BRANCH)"
if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" fetch origin "$BRANCH"
  git -C "$APP_DIR" checkout "$BRANCH"
  git -C "$APP_DIR" pull --ff-only
else
  git clone "$REPO_URL" "$APP_DIR"
  git -C "$APP_DIR" checkout "$BRANCH"
fi

echo "==> Writing env"
cat > "$APP_DIR/.env" <<EOF
STOCKKAR_DATA_DIR=$DATA_DIR
PORT=$PORT
HOST=0.0.0.0
STOCKKAR_INSECURE_COOKIE=$INSECURE_COOKIE
STOCKKAR_PROTECT_AFTER_FILL=$PROTECT_AFTER_FILL
EOF

echo "==> Starting under pm2"
cd "$APP_DIR"
set -a; . ./.env; set +a
pm2 start server.js --name "$APP_NAME" --update-env || pm2 restart "$APP_NAME" --update-env
pm2 save
# Auto-start on reboot (best-effort; prints a line you may need to run as root)
$SUDO env PATH="$PATH" pm2 startup systemd -u "$(whoami)" --hp "$HOME" >/dev/null 2>&1 || true

IP="$(curl -s ifconfig.me || echo '<server-ip>')"
echo ""
echo "==> Stockkar VEE is up: http://$IP:$PORT"
echo "    Branch: $BRANCH | Data: $DATA_DIR | Open the URL and set an App-Lock PIN."
