#!/usr/bin/env bash
# ┌──────────────────────────────────────────────────────────────────────────┐
# │  GMweb API — Quick Install & Manager                                      │
# │  One menu-driven script to install, pair, monitor, secure, and remove     │
# │  the Google Messages → REST bridge on Ubuntu 22.04.                       │
# │                                                                            │
# │  Run:   sudo bash install/quick-install.sh                                 │
# │  Or:    curl -fsSL <raw-url>/install/quick-install.sh | sudo bash         │
# └──────────────────────────────────────────────────────────────────────────┘
set -uo pipefail

# ── Identity / defaults ───────────────────────────────────────────────────────
APP_NAME="GMweb API"
APP_SLUG="gmweb-api"
APP_USER="${APP_USER:-gmweb}"
APP_DIR="${APP_DIR:-/opt/gmweb-api}"
APP_PORT="${APP_PORT:-3030}"
CDP_PORT="${CDP_PORT:-9222}"
DISPLAY_ID="${DISPLAY_ID:-:99}"
VNC_PORT="${VNC_PORT:-5900}"
NOVNC_PORT="${NOVNC_PORT:-6080}"
REPO_URL="${REPO_URL:-https://github.com/yoyoraya/GMweb-API.git}"
LOG_DIR="/var/log/gmweb"
STATE_DIR="/var/lib/gmweb"
INSTALL_LOG="$LOG_DIR/install.log"
SELF_PATH="$(readlink -f "${BASH_SOURCE[0]}" 2>/dev/null || echo "")"

# ── Pretty output ─────────────────────────────────────────────────────────────
if [[ -t 1 ]]; then
  BOLD=$'\e[1m'; DIM=$'\e[2m'; RED=$'\e[31m'; GRN=$'\e[32m'; YEL=$'\e[33m'
  BLU=$'\e[34m'; CYN=$'\e[36m'; RST=$'\e[0m'
else
  BOLD=""; DIM=""; RED=""; GRN=""; YEL=""; BLU=""; CYN=""; RST=""
fi
ok()    { echo "${GRN}✔${RST} $*"; }
warn()  { echo "${YEL}⚠${RST} $*"; }
err()   { echo "${RED}✗${RST} $*" >&2; }
info()  { echo "${CYN}›${RST} $*"; }
step()  { echo; echo "${BOLD}${BLU}==>${RST} ${BOLD}$*${RST}"; }
hr()    { printf '%s\n' "${DIM}────────────────────────────────────────────────────────────${RST}"; }

banner() {
  clear 2>/dev/null || true
  echo "${BOLD}${CYN}"
  cat <<'ART'
   ____ __  __          _       _      _    ____ ___
  / ___|  \/  |_      _| |__   / \    |  _ \_ _|
 | |  _| |\/| \ \ /\ / / '_ \ / _ \   | |_) | |
 | |_| | |  | |\ V  V /| |_) / ___ \  |  __/| |
  \____|_|  |_| \_/\_/ |_.__/_/   \_\ |_|  |___|
ART
  echo "${RST}${DIM}        Google Messages → REST bridge · installer & manager${RST}"
  echo
}

# stdin may be a pipe (curl | bash); read menu input from the terminal.
read_tty() { local __v; if [[ -r /dev/tty ]]; then read -r "$@" <"/dev/tty"; else read -r "$@"; fi; }
pause()    { echo; printf '%s' "${DIM}Press Enter to continue…${RST}"; read_tty _; }
ask() { # ask "Prompt" "default" -> echoes answer
  local p="$1" d="${2:-}" a
  if [[ -n "$d" ]]; then printf '%s [%s]: ' "$p" "$d"; else printf '%s: ' "$p"; fi
  read_tty a; echo "${a:-$d}"
}
confirm() { # confirm "Question?" -> returns 0 on y
  local a; printf '%s [y/N]: ' "$1"; read_tty a; [[ "$a" =~ ^[Yy]$ ]]
}

require_root() {
  if [[ "$(id -u)" -ne 0 ]]; then
    if command -v sudo >/dev/null 2>&1; then exec sudo -E bash "$SELF_PATH" "$@"; fi
    err "Run as root: sudo bash $0"; exit 1
  fi
}

logged() { # logged <cmd...> — run, echo, and append output to install.log
  mkdir -p "$LOG_DIR"
  echo "\$ $*" >>"$INSTALL_LOG"
  "$@" 2>&1 | tee -a "$INSTALL_LOG"
  return "${PIPESTATUS[0]}"
}

svc_active() { systemctl is-active --quiet "$1" 2>/dev/null && echo "${GRN}active${RST}" || echo "${RED}inactive${RST}"; }
port_busy()  { ss -ltn 2>/dev/null | grep -q ":$1 "; }

# ── 0. Preflight & security checks ────────────────────────────────────────────
preflight() {
  step "Preflight checks"
  local osver ram disk
  osver="$(. /etc/os-release 2>/dev/null && echo "${PRETTY_NAME:-unknown}")"
  info "OS: $osver"
  [[ "$osver" == *"22.04"* ]] || warn "Designed for Ubuntu 22.04 — other versions may need tweaks."

  ram="$(awk '/MemTotal/{printf "%d", $2/1024}' /proc/meminfo 2>/dev/null || echo 0)"
  (( ram >= 1500 )) && ok "RAM: ${ram} MB" || warn "RAM ${ram} MB — Chrome wants ≥2 GB; add swap if it OOMs."
  disk="$(df -Pm / | awk 'NR==2{print $4}')"
  (( disk >= 3000 )) && ok "Free disk: ${disk} MB" || warn "Free disk ${disk} MB — Chrome+deps need ~3 GB."

  command -v systemctl >/dev/null 2>&1 && ok "systemd present" || { err "systemd required."; return 1; }

  for p in "$APP_PORT" "$CDP_PORT"; do
    if port_busy "$p"; then warn "Port $p already in use (an old GMweb? will be reused)"; else ok "Port $p free"; fi
  done

  if [[ -d "$APP_DIR" ]]; then warn "Existing install detected at $APP_DIR (install will update it, keep .env)"; fi
  echo
  info "${BOLD}Security note:${RST} the controlled Chrome logs into ${BOLD}your Google account${RST}."
  info "Treat this server like your phone — anyone with root or the VNC console can read your SMS."
}

# ── 1. Full install ───────────────────────────────────────────────────────────
install_packages() {
  step "Installing system packages (Chrome, Redis, VNC, Node)"
  export DEBIAN_FRONTEND=noninteractive
  logged apt-get update
  logged apt-get install -y ca-certificates curl wget gnupg git rsync sudo tar \
        xvfb x11vnc fluxbox novnc websockify redis-server jq

  if ! command -v node >/dev/null 2>&1 || (( $(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0) < 20 )); then
    step "Installing Node.js 22"
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >>"$INSTALL_LOG" 2>&1
    logged apt-get install -y nodejs
  else
    ok "Node $(node -v) already present"
  fi

  if ! command -v google-chrome >/dev/null 2>&1; then
    step "Installing Google Chrome"
    install -d -m 0755 /etc/apt/keyrings
    wget -q -O - https://dl.google.com/linux/linux_signing_key.pub | gpg --dearmor -o /etc/apt/keyrings/google-linux.gpg
    echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/google-linux.gpg] http://dl.google.com/linux/chrome/deb/ stable main" >/etc/apt/sources.list.d/google-chrome.list
    logged apt-get update
    logged apt-get install -y google-chrome-stable
  else
    ok "Chrome already present"
  fi

  systemctl enable --now redis-server >>"$INSTALL_LOG" 2>&1 || true
  redis-cli ping >/dev/null 2>&1 && ok "Redis running" || warn "Redis not responding — queue won't work until it does."
}

sync_app() {
  step "Placing app in $APP_DIR"
  id "$APP_USER" >/dev/null 2>&1 || { useradd --system --create-home --shell /bin/bash "$APP_USER"; ok "Created user $APP_USER"; }
  mkdir -p "$APP_DIR"
  local src; src="$(cd "$(dirname "$SELF_PATH")/.." 2>/dev/null && pwd || echo "")"

  if [[ -f "$src/package.json" && "$src" != "$APP_DIR" ]]; then
    info "Syncing from local checkout: $src"
    rsync -a --delete --exclude ".git/" --exclude ".env" --exclude "data/" --exclude "node_modules/" "$src/" "$APP_DIR/"
  elif [[ -d "$APP_DIR/.git" ]]; then
    info "Updating existing git checkout"; git -C "$APP_DIR" pull --ff-only >>"$INSTALL_LOG" 2>&1 || warn "git pull failed"
  else
    info "Cloning $REPO_URL"; rm -rf "$APP_DIR"; git clone "$REPO_URL" "$APP_DIR" >>"$INSTALL_LOG" 2>&1
  fi
  chown -R "$APP_USER:$APP_USER" "$APP_DIR"
  [[ -f "$APP_DIR/package.json" ]] || { err "No app found in $APP_DIR"; return 1; }

  step "Installing npm dependencies"
  runuser -u "$APP_USER" -- bash -lc "cd '$APP_DIR' && (npm ci --omit=dev || npm install --omit=dev)" >>"$INSTALL_LOG" 2>&1 && ok "Deps installed" || warn "npm install had issues — check $INSTALL_LOG"
  chmod +x "$APP_DIR"/scripts/*.sh 2>/dev/null || true

  # The React console (/app) ships pre-built in public/dashboard-next. If a source
  # checkout is missing the build, build it here so /app works out of the box.
  if [[ -f "$APP_DIR/dashboard-next/package.json" && ! -f "$APP_DIR/public/dashboard-next/index.html" ]]; then
    step "Building the React console (/app)"
    runuser -u "$APP_USER" -- bash -lc "cd '$APP_DIR/dashboard-next' && npm ci && npm run build" >>"$INSTALL_LOG" 2>&1 \
      && ok "Console built" || warn "Console build skipped/failed — /dashboard still works. See $INSTALL_LOG"
  else
    [[ -f "$APP_DIR/public/dashboard-next/index.html" ]] && ok "React console present (/app)"
  fi
}

write_env() {
  if [[ -f "$APP_DIR/.env" ]]; then ok ".env exists — keeping it"; return; fi
  step "Generating .env (token + dashboard credentials)"
  local token user pass hash
  token="$(runuser -u "$APP_USER" -- bash -lc "cd '$APP_DIR' && node scripts/new-token.js")"
  user="$(ask 'Dashboard username' 'gmwebadmin')"
  pass="$(node -e "console.log(require('node:crypto').randomBytes(33).toString('base64url'))")"
  hash="$(runuser -u "$APP_USER" -- bash -lc "cd '$APP_DIR' && node scripts/hash-password.js '$pass'")"
  cat >"$APP_DIR/.env" <<ENV
NODE_ENV=production
PORT=$APP_PORT
HOST=127.0.0.1
API_TOKEN=$token
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
CORS_ORIGIN=
DASHBOARD_ENABLED=true
ADMIN_ACTIONS_ENABLED=true
DASHBOARD_USERNAME=$user
DASHBOARD_PASSWORD_HASH=$hash
DASHBOARD_PASSWORD_SESSION_TTL_MS=600000
DASHBOARD_PASSWORD_WINDOW_MS=900000
DASHBOARD_PASSWORD_MAX=5
DASHBOARD_COOKIE_SECURE=false
DASHBOARD_LOGIN_WINDOW_MS=60000
DASHBOARD_LOGIN_MAX=20
ADMIN_ACTION_WINDOW_MS=60000
ADMIN_ACTION_MAX=60
VNC_PROXY_TARGET=http://127.0.0.1:$NOVNC_PORT

# Reliability / self-healing tuning (safe defaults)
SEND_DEDUPE_SECONDS=120
SEND_TIMEOUT_MS=80000
SEND_FAIL_RESTART_THRESHOLD=3
SEND_MIN_INTERVAL_MS=15000
SEND_MAX_PER_MINUTE=4
CONVERSATION_HISTORY_MAX_BATCHES=80
ENV
  chown "$APP_USER:$APP_USER" "$APP_DIR/.env"; chmod 600 "$APP_DIR/.env"
  printf '%s' "$pass" >"$STATE_DIR/dashboard-password.txt"; chmod 600 "$STATE_DIR/dashboard-password.txt"
  ok "Wrote $APP_DIR/.env (mode 600)"
}

install_systemd() {
  step "Installing systemd services + watchdog + logging"
  mkdir -p "$LOG_DIR" "$STATE_DIR"
  local sysctl; sysctl="$(command -v systemctl)"

  cat >/etc/sudoers.d/gmweb-api <<SUDO
$APP_USER ALL=(root) NOPASSWD: $sysctl start gmweb-vnc.service gmweb-novnc.service
$APP_USER ALL=(root) NOPASSWD: $sysctl stop gmweb-novnc.service gmweb-vnc.service
$APP_USER ALL=(root) NOPASSWD: $sysctl restart gmweb-api.service
$APP_USER ALL=(root) NOPASSWD: $sysctl restart gmweb-chrome.service
SUDO
  chmod 440 /etc/sudoers.d/gmweb-api; visudo -cf /etc/sudoers.d/gmweb-api >/dev/null

  cat >/etc/systemd/system/gmweb-chrome.service <<S
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
S

  cat >/etc/systemd/system/gmweb-api.service <<S
[Unit]
Description=$APP_NAME HTTP bridge
After=network.target redis-server.service gmweb-chrome.service
Wants=gmweb-chrome.service
Requires=redis-server.service
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
S

  cat >/etc/systemd/system/gmweb-vnc.service <<S
[Unit]
Description=$APP_NAME pairing VNC bridge
After=gmweb-chrome.service
Wants=gmweb-chrome.service
[Service]
Type=simple
User=$APP_USER
WorkingDirectory=$APP_DIR
Environment=DISPLAY_ID=$DISPLAY_ID
ExecStart=$APP_DIR/scripts/pairing-vnc.sh
Restart=always
RestartSec=5
[Install]
WantedBy=multi-user.target
S

  cat >/etc/systemd/system/gmweb-novnc.service <<S
[Unit]
Description=$APP_NAME noVNC web bridge
After=gmweb-vnc.service
Wants=gmweb-vnc.service
[Service]
Type=simple
User=$APP_USER
ExecStart=/usr/bin/websockify --web=/usr/share/novnc/ 127.0.0.1:$NOVNC_PORT 127.0.0.1:$VNC_PORT
Restart=always
RestartSec=5
[Install]
WantedBy=multi-user.target
S

  # Watchdog: heal a wedged session automatically.
  cat >/etc/systemd/system/gmweb-monitor.service <<S
[Unit]
Description=$APP_NAME watchdog (health + pairing self-heal)
[Service]
Type=oneshot
Environment=APP_DIR=$APP_DIR LOG_DIR=$LOG_DIR STATE_DIR=$STATE_DIR
ExecStart=$APP_DIR/scripts/gmweb-monitor.sh
S
  cat >/etc/systemd/system/gmweb-monitor.timer <<S
[Unit]
Description=Run $APP_NAME watchdog every 2 minutes
[Timer]
OnBootSec=90
OnUnitActiveSec=120
[Install]
WantedBy=timers.target
S

  # Log rotation for the monitor/install logs.
  cat >/etc/logrotate.d/gmweb <<S
$LOG_DIR/*.log {
  weekly
  rotate 8
  compress
  missingok
  notifempty
  copytruncate
}
S

  ln -sf "$APP_DIR/scripts/gmweb-menu.sh" /usr/local/bin/gmweb 2>/dev/null || true
  ln -sf "$SELF_PATH" /usr/local/bin/gmweb-install 2>/dev/null || true

  systemctl daemon-reload
  systemctl enable gmweb-chrome.service gmweb-api.service gmweb-monitor.timer >>"$INSTALL_LOG" 2>&1
  systemctl disable gmweb-vnc.service gmweb-novnc.service >>"$INSTALL_LOG" 2>&1 || true
  ok "Services installed (chrome, api, vnc, novnc, monitor.timer)"
}

start_core() {
  step "Starting core services"
  systemctl restart gmweb-chrome.service; sleep 4
  systemctl restart gmweb-api.service;    sleep 6
  systemctl start gmweb-monitor.timer
  curl -fsS -m 8 "http://127.0.0.1:$APP_PORT/health" >/dev/null 2>&1 && ok "API healthy on :$APP_PORT" || warn "API not answering yet — check: gmweb-install → Logs"
}

show_credentials() {
  hr
  local token user pass ip
  token="$(grep -m1 '^API_TOKEN=' "$APP_DIR/.env" | cut -d= -f2-)"
  user="$(grep -m1 '^DASHBOARD_USERNAME=' "$APP_DIR/.env" | cut -d= -f2-)"
  pass="$(cat "$STATE_DIR/dashboard-password.txt" 2>/dev/null || echo '(set previously — kept)')"
  ip="$(curl -fsS -m 5 https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')"
  echo "${BOLD}${GRN}GMweb is installed.${RST}"
  echo
  echo "  ${BOLD}Console (new):${RST} http://127.0.0.1:$APP_PORT/app        ${DIM}React UI${RST}"
  echo "  ${BOLD}Dashboard:${RST}     http://127.0.0.1:$APP_PORT/dashboard  ${DIM}classic${RST}"
  echo "  ${BOLD}Username:${RST}      $user"
  echo "  ${BOLD}Password:${RST}      $pass"
  echo "  ${BOLD}API token:${RST}  $token"
  echo "  ${BOLD}Server IP:${RST}  ${ip:-unknown}"
  echo
  echo "  ${DIM}Manager menu:${RST} ${BOLD}gmweb-install${RST}   ·   ${DIM}quick CLI:${RST} ${BOLD}gmweb${RST}"
  hr
  warn "Save these now. The password is shown from $STATE_DIR/dashboard-password.txt."
}

do_full_install() {
  banner; preflight || { pause; return; }
  echo; confirm "Proceed with full install?" || return
  install_packages && sync_app && write_env && install_systemd && start_core
  show_credentials
  echo
  if confirm "Google Messages is not paired yet. Run the pairing wizard now?"; then
    pairing_wizard
  else
    info "Pair later from the menu → Pairing wizard."
  fi
  pause
}

# ── 2. Pairing wizard ─────────────────────────────────────────────────────────
pairing_wizard() {
  banner
  echo "${BOLD}Pairing wizard — connect Google Messages${RST}"
  hr
  echo "You will pair this server's Chrome with the Google Messages app on your phone,"
  echo "exactly like 'Messages for web' on a normal computer."
  echo
  echo "${BOLD}Security:${RST} after pairing, this server can read & send SMS on your line."
  echo "Only pair an account you control, and keep the VNC console private."
  hr
  local ip; ip="$(curl -fsS -m 5 https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')"

  echo "${BOLD}Step 1.${RST} Turning on the VNC console (so you can see the server's Chrome)…"
  systemctl start gmweb-vnc.service gmweb-novnc.service 2>/dev/null
  sleep 2
  ok "VNC up on 127.0.0.1:$NOVNC_PORT"

  echo
  echo "${BOLD}Step 2.${RST} From ${BOLD}your laptop${RST}, open an SSH tunnel:"
  echo "    ${CYN}ssh -L $NOVNC_PORT:127.0.0.1:$NOVNC_PORT root@${ip:-SERVER_IP}${RST}"
  echo "   then open in your browser:"
  echo "    ${CYN}http://127.0.0.1:$NOVNC_PORT/vnc.html?autoconnect=true&resize=scale${RST}"
  echo "   ${DIM}(Or use the dashboard's built-in VNC panel if the public dashboard is set up.)${RST}"
  echo
  echo "${BOLD}Step 3.${RST} In that Chrome window:"
  echo "   a) If asked, sign in to your Google account."
  echo "   b) Open Google Messages on your ${BOLD}phone${RST} → ⋮ → ${BOLD}Device pairing${RST} → ${BOLD}QR code scanner${RST}."
  echo "   c) Scan the QR code shown in the VNC window."
  pause

  echo "${BOLD}Step 4.${RST} Watching pairing status (Ctrl-C to stop)…"
  local token; token="$(grep -m1 '^API_TOKEN=' "$APP_DIR/.env" | cut -d= -f2-)"
  local i paired=false
  for i in $(seq 1 40); do
    local r; r="$(curl -fsS -m 12 -H "Authorization: Bearer $token" "http://127.0.0.1:$APP_PORT/ready" 2>/dev/null || echo '')"
    if echo "$r" | grep -q '"paired":true'; then paired=true; break; fi
    printf '\r  %s waiting for pairing… (%s/40)   ' "${YEL}●${RST}" "$i"
    sleep 5
  done
  echo
  if [[ "$paired" == true ]]; then
    ok "Paired! Google Messages is connected."
    echo "${BOLD}Step 5.${RST} Turning the VNC console back OFF for safety…"
    systemctl stop gmweb-novnc.service gmweb-vnc.service 2>/dev/null
    ok "VNC off. Pairing persists in the browser profile."
  else
    warn "Still not paired. Leave VNC on and retry the QR scan, or check logs."
    echo "   Screenshot of current screen:  gmweb-install → Logs → screenshot"
  fi
  pause
}

screenshot_now() {
  local token out; token="$(grep -m1 '^API_TOKEN=' "$APP_DIR/.env" | cut -d= -f2-)"
  out="$LOG_DIR/screen-$(date +%s).png"
  curl -fsS -m 20 -H "Authorization: Bearer $token" "http://127.0.0.1:$APP_PORT/session/screenshot" -o "$out" 2>/dev/null \
    && ok "Saved $out (scp it to view)" || warn "Could not capture screenshot."
}

# ── 3. Services submenu ───────────────────────────────────────────────────────
services_status() {
  hr
  printf '  %-22s %s\n' "redis-server"      "$(svc_active redis-server)"
  printf '  %-22s %s\n' "gmweb-chrome"      "$(svc_active gmweb-chrome)"
  printf '  %-22s %s\n' "gmweb-api"         "$(svc_active gmweb-api)"
  printf '  %-22s %s\n' "gmweb-vnc"         "$(svc_active gmweb-vnc)"
  printf '  %-22s %s\n' "gmweb-novnc"       "$(svc_active gmweb-novnc)"
  printf '  %-22s %s\n' "gmweb-monitor.timer" "$(svc_active gmweb-monitor.timer)"
  hr
}
services_menu() {
  while true; do
    banner; echo "${BOLD}Services${RST}"; services_status
    echo "  1) Start core (chrome + api)"
    echo "  2) Stop core"
    echo "  3) Restart all"
    echo "  4) VNC console ON"
    echo "  5) VNC console OFF"
    echo "  6) Enable watchdog timer    7) Disable watchdog timer"
    echo "  0) Back"
    case "$(ask 'Choose' '')" in
      1) systemctl restart gmweb-chrome gmweb-api; ok done; pause;;
      2) systemctl stop gmweb-api gmweb-chrome; ok done; pause;;
      3) systemctl restart gmweb-chrome gmweb-api; systemctl restart redis-server; ok done; pause;;
      4) systemctl start gmweb-vnc gmweb-novnc; ok "VNC on :$NOVNC_PORT"; pause;;
      5) systemctl stop gmweb-novnc gmweb-vnc; ok "VNC off"; pause;;
      6) systemctl enable --now gmweb-monitor.timer; ok "watchdog on"; pause;;
      7) systemctl disable --now gmweb-monitor.timer; ok "watchdog off"; pause;;
      0) return;;
    esac
  done
}

# ── 4. Logs & monitoring submenu ──────────────────────────────────────────────
logs_menu() {
  while true; do
    banner; echo "${BOLD}Logs & Monitoring${RST}"; hr
    echo "  1) Live API logs        (journalctl -fu gmweb-api)"
    echo "  2) Live Chrome logs     (journalctl -fu gmweb-chrome)"
    echo "  3) Watchdog log         ($LOG_DIR/monitor.log)"
    echo "  4) Install log          ($INSTALL_LOG)"
    echo "  5) Health + queue snapshot"
    echo "  6) Capture screenshot of the messages page"
    echo "  7) Run watchdog once now"
    echo "  0) Back"
    case "$(ask 'Choose' '')" in
      1) journalctl -fu gmweb-api --no-hostname 2>/dev/null || true;;
      2) journalctl -fu gmweb-chrome --no-hostname 2>/dev/null || true;;
      3) tail -n 60 "$LOG_DIR/monitor.log" 2>/dev/null || warn "no log yet"; pause;;
      4) tail -n 80 "$INSTALL_LOG" 2>/dev/null || warn "no log yet"; pause;;
      5) health_snapshot; pause;;
      6) screenshot_now; pause;;
      7) "$APP_DIR/scripts/gmweb-monitor.sh"; ok "ran"; pause;;
      0) return;;
    esac
  done
}
health_snapshot() {
  local token; token="$(grep -m1 '^API_TOKEN=' "$APP_DIR/.env" 2>/dev/null | cut -d= -f2-)"
  hr
  echo "${BOLD}/health${RST}"; curl -fsS -m 8 "http://127.0.0.1:$APP_PORT/health" 2>/dev/null | (jq . 2>/dev/null || cat); echo
  echo "${BOLD}/ready${RST}";  curl -fsS -m 15 -H "Authorization: Bearer $token" "http://127.0.0.1:$APP_PORT/ready" 2>/dev/null | (jq . 2>/dev/null || cat); echo
  echo "${BOLD}/admin/queue${RST}"; curl -fsS -m 10 -H "Authorization: Bearer $token" "http://127.0.0.1:$APP_PORT/admin/queue" 2>/dev/null | (jq . 2>/dev/null || cat); echo
  hr
}

# ── 5. Security submenu ───────────────────────────────────────────────────────
security_menu() {
  while true; do
    banner; echo "${BOLD}Security${RST}"; hr
    echo "  1) Run security audit"
    echo "  2) Firewall: allow only SSH (ufw)"
    echo "  3) Rotate API master token"
    echo "  4) Change dashboard password"
    echo "  5) Lock down .env permissions"
    echo "  0) Back"
    case "$(ask 'Choose' '')" in
      1) security_audit; pause;;
      2) firewall_lockdown; pause;;
      3) rotate_token; pause;;
      4) change_dashboard_password; pause;;
      5) chown "$APP_USER:$APP_USER" "$APP_DIR/.env"; chmod 600 "$APP_DIR/.env"; ok ".env locked to 600"; pause;;
      0) return;;
    esac
  done
}
security_audit() {
  hr; echo "${BOLD}Security audit${RST}"
  local env="$APP_DIR/.env"
  [[ "$(stat -c '%a' "$env" 2>/dev/null)" == "600" ]] && ok ".env is 600" || warn ".env not 600 → run option 5"
  grep -q '^API_TOKEN=change-me' "$env" 2>/dev/null && err "API_TOKEN is the default! rotate it." || ok "API token is not default"
  grep -q '^HOST=127.0.0.1' "$env" 2>/dev/null && ok "API bound to localhost (not public)" || warn "HOST is not 127.0.0.1 — port may be exposed"
  if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then ok "ufw firewall active"; else warn "ufw firewall not active → option 2"; fi
  ss -ltn 2>/dev/null | grep -q "0.0.0.0:$APP_PORT" && err "Port $APP_PORT listening on 0.0.0.0 (public!)" || ok "Port $APP_PORT not public"
  command -v fail2ban-client >/dev/null 2>&1 && ok "fail2ban present" || warn "fail2ban not installed (optional, blocks SSH brute force)"
  hr
}
firewall_lockdown() {
  command -v ufw >/dev/null 2>&1 || { logged apt-get install -y ufw; }
  ufw allow OpenSSH >/dev/null 2>&1 || ufw allow 22/tcp >/dev/null 2>&1
  confirm "Also allow 80/443 (for public dashboard)?" && { ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null; }
  yes | ufw enable >/dev/null 2>&1 || true
  ok "Firewall enabled (SSH allowed; GMweb ports stay localhost-only)"
  ufw status verbose | sed 's/^/  /'
}
rotate_token() {
  local new; new="$(runuser -u "$APP_USER" -- bash -lc "cd '$APP_DIR' && node scripts/new-token.js")"
  sed -i "s|^API_TOKEN=.*|API_TOKEN=$new|" "$APP_DIR/.env"
  systemctl restart gmweb-api
  ok "New API token: ${BOLD}$new${RST}"
  warn "Update every client (Eve, dashboard) with the new token."
}
change_dashboard_password() {
  local pass hash; pass="$(ask 'New dashboard password (blank = random)' '')"
  [[ -z "$pass" ]] && pass="$(node -e "console.log(require('node:crypto').randomBytes(33).toString('base64url'))")"
  hash="$(runuser -u "$APP_USER" -- bash -lc "cd '$APP_DIR' && node scripts/hash-password.js '$pass'")"
  sed -i "s|^DASHBOARD_PASSWORD_HASH=.*|DASHBOARD_PASSWORD_HASH=$hash|" "$APP_DIR/.env"
  printf '%s' "$pass" >"$STATE_DIR/dashboard-password.txt"; chmod 600 "$STATE_DIR/dashboard-password.txt"
  systemctl restart gmweb-api
  ok "Dashboard password set to: ${BOLD}$pass${RST}"
}

# ── 6. Public dashboard ───────────────────────────────────────────────────────
public_dashboard_menu() {
  banner; echo "${BOLD}Public dashboard (HTTPS via nginx)${RST}"; hr
  if [[ ! -x "$APP_DIR/scripts/public-dashboard.sh" ]]; then warn "public-dashboard.sh missing in $APP_DIR/scripts"; pause; return; fi
  echo "Exposes the dashboard over HTTPS with a real or nip.io domain + Let's Encrypt."
  local dom email
  dom="$(ask 'Domain (blank = auto nip.io)' '')"
  email="$(ask 'Email for Lets-Encrypt TLS (blank = skip)' '')"
  bash "$APP_DIR/scripts/public-dashboard.sh" install ${dom:+"$dom"} ${email:+"$email"} || warn "public-dashboard returned an error"
  pause
}

# ── 7. Update ─────────────────────────────────────────────────────────────────
update_app() {
  banner; step "Updating GMweb"
  if [[ -d "$APP_DIR/.git" ]]; then
    git -C "$APP_DIR" pull --ff-only | tee -a "$INSTALL_LOG"
  else
    warn "$APP_DIR is not a git checkout; re-run install to refresh files."
  fi
  runuser -u "$APP_USER" -- bash -lc "cd '$APP_DIR' && (npm ci --omit=dev || npm install --omit=dev)" >>"$INSTALL_LOG" 2>&1
  systemctl restart gmweb-api
  ok "Updated and restarted."
  pause
}

# ── 8. Uninstall ──────────────────────────────────────────────────────────────
uninstall_menu() {
  banner; echo "${BOLD}${RED}Uninstall${RST}"; hr
  echo "  1) Remove GMweb (services, app, user) — keep Chrome/VNC/Redis packages"
  echo "  2) ${RED}Nuke everything${RST} — also purge packages, logs, and this script"
  echo "  0) Back"
  case "$(ask 'Choose' '')" in
    1) do_uninstall false;;
    2) do_uninstall true;;
    0) return;;
  esac
  pause
}
do_uninstall() {
  local purge="$1"
  echo
  warn "This permanently removes GMweb and the paired Google Messages session."
  [[ "$(ask 'Type DELETE GMWEB to confirm' '')" == "DELETE GMWEB" ]] || { info "Cancelled."; return; }

  step "Stopping & removing services"
  local units=(gmweb-api gmweb-chrome gmweb-vnc gmweb-novnc gmweb-monitor.timer gmweb-monitor.service)
  systemctl stop "${units[@]}" 2>/dev/null || true
  systemctl disable "${units[@]}" 2>/dev/null || true
  rm -f /etc/systemd/system/gmweb-*.service /etc/systemd/system/gmweb-*.timer
  systemctl daemon-reload; systemctl reset-failed "${units[@]}" 2>/dev/null || true

  step "Removing nginx, sudoers, logrotate, commands"
  rm -f /etc/nginx/sites-enabled/gmweb-api.conf /etc/nginx/sites-available/gmweb-api.conf \
        /etc/nginx/conf.d/gmweb-api-websocket-map.conf /etc/sudoers.d/gmweb-api /etc/logrotate.d/gmweb
  command -v nginx >/dev/null 2>&1 && { nginx -t >/dev/null 2>&1 && systemctl reload nginx 2>/dev/null || true; }
  rm -f /usr/local/bin/gmweb /usr/local/bin/gmweb-* /usr/local/bin/gmweb-install

  step "Removing app, data, logs, user"
  rm -rf "$APP_DIR" "$LOG_DIR" "$STATE_DIR"
  if id "$APP_USER" >/dev/null 2>&1; then pkill -u "$APP_USER" 2>/dev/null || true; userdel -r "$APP_USER" 2>/dev/null || userdel "$APP_USER" 2>/dev/null || true; fi

  if [[ "$purge" == true ]]; then
    step "Purging packages (Chrome, VNC, Redis)"
    apt-get purge -y google-chrome-stable xvfb x11vnc fluxbox novnc websockify redis-server 2>/dev/null || true
    rm -f /etc/apt/sources.list.d/google-chrome.list /etc/apt/keyrings/google-linux.gpg
    apt-get autoremove -y 2>/dev/null || true
  fi

  ok "GMweb removed."
  if [[ "$purge" == true && -n "$SELF_PATH" && -f "$SELF_PATH" ]]; then
    local repo; repo="$(cd "$(dirname "$SELF_PATH")/.." 2>/dev/null && pwd || echo '')"
    if [[ -n "$repo" && -f "$repo/package.json" ]] && confirm "Also delete the installer checkout at $repo?"; then
      info "Removing $repo and exiting."; rm -rf "$repo"; exit 0
    fi
    rm -f "$SELF_PATH" 2>/dev/null || true
  fi
}

# ── Main menu ─────────────────────────────────────────────────────────────────
main_menu() {
  while true; do
    banner
    local installed="${RED}not installed${RST}"
    [[ -f "$APP_DIR/.env" ]] && installed="${GRN}installed${RST} ($APP_DIR)"
    echo "  Status: $installed"
    hr
    echo "  ${BOLD}1${RST}) Quick install / repair        ${DIM}full guided setup${RST}"
    echo "  ${BOLD}2${RST}) Pairing wizard               ${DIM}connect Google Messages${RST}"
    echo "  ${BOLD}3${RST}) Services                     ${DIM}start / stop / VNC / watchdog${RST}"
    echo "  ${BOLD}4${RST}) Logs & monitoring"
    echo "  ${BOLD}5${RST}) Security"
    echo "  ${BOLD}6${RST}) Public dashboard (HTTPS)"
    echo "  ${BOLD}7${RST}) Update from git"
    echo "  ${BOLD}8${RST}) ${RED}Uninstall${RST}"
    echo "  ${BOLD}9${RST}) Show credentials"
    echo "  ${BOLD}0${RST}) Exit"
    hr
    case "$(ask 'Choose' '')" in
      1) do_full_install;;
      2) [[ -f "$APP_DIR/.env" ]] && pairing_wizard || { warn "Install first (option 1)."; pause; };;
      3) services_menu;;
      4) logs_menu;;
      5) security_menu;;
      6) public_dashboard_menu;;
      7) update_app;;
      8) uninstall_menu;;
      9) [[ -f "$APP_DIR/.env" ]] && { show_credentials; pause; } || { warn "Not installed."; pause; };;
      0|q|Q) echo "Bye."; exit 0;;
      *) ;;
    esac
  done
}

require_root "$@"
mkdir -p "$LOG_DIR" "$STATE_DIR"
main_menu
