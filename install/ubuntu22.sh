#!/usr/bin/env bash
set -euo pipefail

APP_NAME="GMweb API"
APP_SLUG="gmweb-api"
APP_USER="${APP_USER:-gmweb}"
APP_DIR="${APP_DIR:-/opt/gmweb-api}"
APP_PORT="${APP_PORT:-3030}"
DISPLAY_ID="${DISPLAY_ID:-:99}"
CDP_PORT="${CDP_PORT:-9222}"
REPO_URL="${REPO_URL:-}"

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run as root: sudo bash install/ubuntu22.sh"
  exit 1
fi

if [[ "$(lsb_release -rs 2>/dev/null || true)" != "22.04" ]]; then
  echo "Warning: this installer is designed for Ubuntu 22.04."
fi

echo "==> Installing system packages"
apt-get update
apt-get install -y ca-certificates curl wget gnupg git tar xvfb x11vnc fluxbox

if ! command -v node >/dev/null 2>&1 || [[ "$(node -p 'Number(process.versions.node.split(`.`)[0])')" -lt 20 ]]; then
  echo "==> Installing Node.js 22"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi

if ! command -v google-chrome >/dev/null 2>&1; then
  echo "==> Installing Google Chrome"
  install -d -m 0755 /etc/apt/keyrings
  wget -q -O - https://dl.google.com/linux/linux_signing_key.pub \
    | gpg --dearmor -o /etc/apt/keyrings/google-linux.gpg
  echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/google-linux.gpg] http://dl.google.com/linux/chrome/deb/ stable main" \
    > /etc/apt/sources.list.d/google-chrome.list
  apt-get update
  apt-get install -y google-chrome-stable
fi

if ! id "$APP_USER" >/dev/null 2>&1; then
  echo "==> Creating service user: $APP_USER"
  useradd --system --create-home --shell /bin/bash "$APP_USER"
fi

echo "==> Preparing app directory: $APP_DIR"
mkdir -p "$APP_DIR"

if [[ -n "$REPO_URL" ]]; then
  if [[ -d "$APP_DIR/.git" ]]; then
    git -C "$APP_DIR" pull --ff-only
  else
    rm -rf "$APP_DIR"
    git clone "$REPO_URL" "$APP_DIR"
  fi
else
  echo "No REPO_URL provided. Assuming project files already exist in $APP_DIR."
fi

chown -R "$APP_USER:$APP_USER" "$APP_DIR"

echo "==> Installing npm dependencies"
sudo -u "$APP_USER" bash -lc "cd '$APP_DIR' && npm ci --omit=dev"

TOKEN="$(sudo -u "$APP_USER" bash -lc "cd '$APP_DIR' && node scripts/new-token.js")"
if [[ ! -f "$APP_DIR/.env" ]]; then
  echo "==> Creating .env"
  cat > "$APP_DIR/.env" <<ENV
NODE_ENV=production
PORT=$APP_PORT
HOST=127.0.0.1
API_TOKEN=$TOKEN
HEADLESS=false
USER_DATA_DIR=./data/browser-profile
CHROME_EXECUTABLE_PATH=/usr/bin/google-chrome
BROWSER_MODE=connect
BROWSER_CDP_URL=http://127.0.0.1:$CDP_PORT
POLL_INTERVAL_MS=5000
WEBHOOK_URL=
ENABLE_DEBUG_ROUTES=false
PUBLIC_HEALTH=true
ENV
  chown "$APP_USER:$APP_USER" "$APP_DIR/.env"
  chmod 600 "$APP_DIR/.env"
else
  echo ".env already exists; not overwriting it."
fi

chmod +x "$APP_DIR/scripts/vps-chrome.sh"

echo "==> Installing systemd services"
cat > /etc/systemd/system/gmweb-chrome.service <<SERVICE
[Unit]
Description=$APP_NAME Chrome on virtual display
After=network.target

[Service]
Type=simple
User=$APP_USER
WorkingDirectory=$APP_DIR
Environment=ROOT_DIR=$APP_DIR
Environment=USER_DATA_DIR=$APP_DIR/data/browser-profile
Environment=DISPLAY_ID=$DISPLAY_ID
Environment=BROWSER_CDP_PORT=$CDP_PORT
ExecStart=$APP_DIR/scripts/vps-chrome.sh
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
SERVICE

cat > /etc/systemd/system/gmweb-api.service <<SERVICE
[Unit]
Description=$APP_NAME HTTP bridge
After=network.target gmweb-chrome.service
Wants=gmweb-chrome.service

[Service]
Type=simple
User=$APP_USER
WorkingDirectory=$APP_DIR
Environment=NODE_ENV=production
ExecStart=/usr/bin/npm start
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
SERVICE

systemctl daemon-reload
systemctl enable gmweb-chrome.service gmweb-api.service

cat > "$APP_DIR/pairing-vnc.sh" <<SCRIPT
#!/usr/bin/env bash
set -euo pipefail
export DISPLAY="$DISPLAY_ID"
x11vnc -localhost -forever -shared -rfbport 5900
SCRIPT
chown "$APP_USER:$APP_USER" "$APP_DIR/pairing-vnc.sh"
chmod +x "$APP_DIR/pairing-vnc.sh"

echo
echo "==> Installed $APP_NAME"
echo "App directory: $APP_DIR"
echo "API token: $(grep '^API_TOKEN=' "$APP_DIR/.env" | sed 's/API_TOKEN=//')"
echo
echo "Next:"
echo "1) systemctl start gmweb-chrome"
echo "2) sudo -u $APP_USER $APP_DIR/pairing-vnc.sh"
echo "3) From your laptop: ssh -L 5900:127.0.0.1:5900 root@SERVER_IP"
echo "4) Open VNC viewer at 127.0.0.1:5900 and pair Google Messages"
echo "5) systemctl start gmweb-api"
echo "6) cd $APP_DIR && npm run smoke"
