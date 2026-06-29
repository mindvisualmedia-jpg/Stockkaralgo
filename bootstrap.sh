#!/usr/bin/env bash
# Stockkar VEE bootstrap — provisions a fresh Ubuntu VPS (InterServer, AWS,
# Azure, anywhere) into a running Stockkar box and wires up in-app one-click
# updates, so a push to `main` shows "Update available" in every user's app.
#
# Usage (on a fresh Ubuntu VPS, as root or a sudo user):
#   GITHUB_TOKEN=ghp_xxx BRANCH=main PORT=80 bash bootstrap.sh
#
# GITHUB_TOKEN = a read-only GitHub PAT for the private repo (used to clone, to
# pull on update, and to read the latest version for the update banner).
set -euo pipefail

GITHUB_TOKEN="${GITHUB_TOKEN:-}"
OWNER_REPO="${OWNER_REPO:-mindvisualmedia-jpg/Stockkaralgo}"
REPO_URL="${REPO_URL:-https://${GITHUB_TOKEN:+$GITHUB_TOKEN@}github.com/${OWNER_REPO}.git}"
BRANCH="${BRANCH:-main}"                                   # main = production users; staging = test box
APP_DIR="${APP_DIR:-$HOME/stockkar_electron}"
DATA_DIR="${DATA_DIR:-$HOME/stockkar-data}"
PORT="${PORT:-7777}"
APP_NAME="${APP_NAME:-stockkar}"
INSECURE_COOKIE="${INSECURE_COOKIE:-1}"                    # 1 for HTTP-only box; 0 behind nginx+HTTPS
PROTECT_AFTER_FILL="${PROTECT_AFTER_FILL:-0}"            # 1 = place Forever/GTT only after the entry fills
INSTALL_UPDATER="${INSTALL_UPDATER:-1}"                  # 1 = wire the in-app one-click updater

SUDO=""; [ "$(id -u)" -ne 0 ] && SUDO="sudo"
APP_USER="$(whoami)"

echo "==> Installing Node 20 + git + pm2"
if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | $SUDO bash -
fi
$SUDO apt-get install -y nodejs git
$SUDO npm install -g pm2

echo "==> Fetching app ($BRANCH)"
if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" remote set-url origin "$REPO_URL"
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
STOCKKAR_GITHUB_TOKEN=$GITHUB_TOKEN
EOF

echo "==> Starting under pm2"
cd "$APP_DIR"
set -a; . ./.env; set +a
pm2 start server.js --name "$APP_NAME" --update-env || pm2 restart "$APP_NAME" --update-env
pm2 save
$SUDO env PATH="$PATH" pm2 startup systemd -u "$APP_USER" --hp "$HOME" >/dev/null 2>&1 || true

if [ "$INSTALL_UPDATER" = "1" ]; then
  echo "==> Installing the in-app one-click updater"
  # Update script: pull the tracked branch and restart pm2 (git remote already
  # carries the token, so the pull is non-interactive on the private repo).
  cat > /tmp/stockkar-update <<UPD
#!/usr/bin/env bash
set -e
cd "$APP_DIR"
git pull --ff-only
pm2 restart "$APP_NAME" --update-env || pm2 start server.js --name "$APP_NAME" --update-env
pm2 save
UPD
  $SUDO mv /tmp/stockkar-update /usr/local/sbin/stockkar-update
  $SUDO chmod 755 /usr/local/sbin/stockkar-update

  # systemd unit, run AS the app user so it talks to the right pm2 instance.
  cat > /tmp/stockkar-update.service <<SVC
[Unit]
Description=Stockkar one-click updater
[Service]
Type=oneshot
User=$APP_USER
WorkingDirectory=$APP_DIR
Environment=HOME=$HOME
Environment=PATH=/usr/local/sbin:/usr/local/bin:/usr/bin:/bin
ExecStart=/usr/local/sbin/stockkar-update
SVC
  $SUDO mv /tmp/stockkar-update.service /etc/systemd/system/stockkar-update.service
  $SUDO systemctl daemon-reload

  # Let the app user trigger the updater service without a password (that's the
  # exact command the app runs from the "Update Stockkar" button).
  cat > /tmp/stockkar-update.sudoers <<SUD
$APP_USER ALL=(ALL) NOPASSWD: /usr/bin/systemctl start --no-block stockkar-update.service, /usr/bin/systemctl start stockkar-update.service
SUD
  $SUDO mv /tmp/stockkar-update.sudoers /etc/sudoers.d/stockkar-update
  $SUDO chmod 440 /etc/sudoers.d/stockkar-update
fi

IP="$(curl -s ifconfig.me || echo '<server-ip>')"
echo ""
echo "==> Stockkar VEE is up: http://$IP${PORT:+:$PORT}"
echo "    Branch: $BRANCH | In-app updates: $([ "$INSTALL_UPDATER" = 1 ] && echo on || echo off)"
echo "    Open the URL, set an App-Lock PIN, connect the broker token."
