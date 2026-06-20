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
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run as root: sudo bash install/ubuntu22.sh"
  exit 1
fi

as_app_user() {
  runuser -u "$APP_USER" -- bash -lc "$*"
}

if [[ "$(lsb_release -rs 2>/dev/null || true)" != "22.04" ]]; then
  echo "Warning: this installer is designed for Ubuntu 22.04."
fi

echo "==> Installing system packages"
apt-get update
apt-get install -y ca-certificates curl wget gnupg git rsync tar xvfb x11vnc fluxbox novnc websockify

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
elif [[ -f "$SOURCE_DIR/package.json" ]]; then
  if [[ "$SOURCE_DIR" != "$APP_DIR" ]]; then
    echo "No REPO_URL provided. Syncing project from $SOURCE_DIR to $APP_DIR."
    rsync -a --delete \
      --exclude ".git/" \
      --exclude ".env" \
      --exclude "data/" \
      --exclude "node_modules/" \
      "$SOURCE_DIR/" "$APP_DIR/"
  else
    echo "No REPO_URL provided. Using project files already in $APP_DIR."
  fi
else
  echo "No REPO_URL provided and no package.json found next to this installer."
  echo "Run from a cloned GMweb API repo or pass REPO_URL=https://github.com/.../GMweb-API.git"
  exit 1
fi

chown -R "$APP_USER:$APP_USER" "$APP_DIR"

if [[ ! -f "$APP_DIR/package-lock.json" ]]; then
  echo "package-lock.json not found in $APP_DIR."
  echo "The app directory is not a complete GMweb API checkout."
  exit 1
fi

echo "==> Installing npm dependencies"
as_app_user "cd '$APP_DIR' && npm ci --omit=dev"

TOKEN="$(as_app_user "cd '$APP_DIR' && node scripts/new-token.js")"
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
POLL_INTERVAL_MS=0
CONVERSATION_CACHE_FILE=./data/conversation-cache.json
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
chmod +x "$APP_DIR/scripts/gmweb-menu.sh" "$APP_DIR/scripts/uninstall.sh"

echo "==> Installing gmweb command"
ln -sf "$APP_DIR/scripts/gmweb-menu.sh" /usr/local/bin/gmweb
cat > /usr/local/bin/gmweb-uninstall <<'SCRIPT'
#!/usr/bin/env bash
exec gmweb uninstall "$@"
SCRIPT

cat > /usr/local/bin/gmweb-token <<'SCRIPT'
#!/usr/bin/env bash
exec gmweb token "$@"
SCRIPT
cat > /usr/local/bin/gmweb-status <<'SCRIPT'
#!/usr/bin/env bash
exec gmweb status "$@"
SCRIPT
cat > /usr/local/bin/gmweb-smoke <<'SCRIPT'
#!/usr/bin/env bash
exec gmweb smoke "$@"
SCRIPT
cat > /usr/local/bin/gmweb-vnc-on <<'SCRIPT'
#!/usr/bin/env bash
exec gmweb vnc-on "$@"
SCRIPT
cat > /usr/local/bin/gmweb-vnc-off <<'SCRIPT'
#!/usr/bin/env bash
exec gmweb vnc-off "$@"
SCRIPT
chmod +x /usr/local/bin/gmweb-uninstall /usr/local/bin/gmweb-token /usr/local/bin/gmweb-status /usr/local/bin/gmweb-smoke /usr/local/bin/gmweb-vnc-on /usr/local/bin/gmweb-vnc-off

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

cat > /etc/systemd/system/gmweb-vnc.service <<SERVICE
[Unit]
Description=$APP_NAME pairing VNC bridge
After=gmweb-chrome.service
Wants=gmweb-chrome.service

[Service]
Type=simple
User=$APP_USER
WorkingDirectory=$APP_DIR
ExecStart=$APP_DIR/pairing-vnc.sh
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
SERVICE

cat > /etc/systemd/system/gmweb-novnc.service <<SERVICE
[Unit]
Description=$APP_NAME noVNC web bridge
After=gmweb-vnc.service
Wants=gmweb-vnc.service

[Service]
Type=simple
User=$APP_USER
ExecStart=/usr/bin/websockify --web=/usr/share/novnc/ 127.0.0.1:6080 127.0.0.1:5900
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
SERVICE

systemctl daemon-reload
systemctl enable gmweb-chrome.service gmweb-api.service
systemctl disable gmweb-vnc.service gmweb-novnc.service 2>/dev/null || true

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
echo "Manager menu: gmweb"
echo
echo "Next:"
echo "1) gmweb start"
echo "2) gmweb vnc-on"
echo "3) From your laptop: ssh -L 6080:127.0.0.1:6080 root@SERVER_IP"
echo "4) Open http://127.0.0.1:6080/vnc.html and pair Google Messages"
echo "5) gmweb vnc-off"
echo "6) gmweb smoke"
