#!/usr/bin/env bash
set -euo pipefail

APP_NAME="${APP_NAME:-GMweb API}"
APP_USER="${APP_USER:-gmweb}"
APP_DIR="${APP_DIR:-/opt/gmweb-api}"
API_SERVICE="${API_SERVICE:-gmweb-api.service}"
CHROME_SERVICE="${CHROME_SERVICE:-gmweb-chrome.service}"
VNC_SERVICE="${VNC_SERVICE:-gmweb-vnc.service}"
NOVNC_SERVICE="${NOVNC_SERVICE:-gmweb-novnc.service}"
API_URL="${API_URL:-http://127.0.0.1:3030}"

if [[ -t 1 ]]; then
  C_RESET=$'\033[0m'
  C_BOLD=$'\033[1m'
  C_BLUE=$'\033[34m'
  C_CYAN=$'\033[36m'
  C_GREEN=$'\033[32m'
  C_RED=$'\033[31m'
  C_YELLOW=$'\033[33m'
else
  C_RESET=""
  C_BOLD=""
  C_BLUE=""
  C_CYAN=""
  C_GREEN=""
  C_RED=""
  C_YELLOW=""
fi

need_root() {
  if [[ "$(id -u)" -eq 0 ]]; then
    return 0
  fi
  if command -v sudo >/dev/null 2>&1; then
    exec sudo -E "$0" "$@"
  fi
  echo "Run as root: sudo gmweb $*"
  exit 1
}

pause() {
  if [[ -t 0 ]]; then
    echo
    read -r -p "Press Enter to continue..." _
  fi
}

token() {
  if [[ -f "$APP_DIR/.env" ]]; then
    grep '^API_TOKEN=' "$APP_DIR/.env" | tail -n 1 | sed 's/^API_TOKEN=//'
  fi
}

run_as_app() {
  if id "$APP_USER" >/dev/null 2>&1; then
    runuser -u "$APP_USER" -- bash -lc "$*"
  else
    bash -lc "$*"
  fi
}

service_state() {
  local service="$1"
  local active enabled
  active="$(systemctl is-active "$service" 2>/dev/null || true)"
  enabled="$(systemctl is-enabled "$service" 2>/dev/null || true)"
  printf "%-22s active=%-10s enabled=%s\n" "$service" "${active:-unknown}" "${enabled:-unknown}"
}

ready_check() {
  local api_token
  api_token="$(token || true)"
  if [[ -z "$api_token" ]]; then
    echo "No API_TOKEN found in $APP_DIR/.env"
    return 1
  fi
  curl -fsS -H "Authorization: Bearer $api_token" "$API_URL/ready" || true
}

status() {
  echo "${C_BOLD}${C_BLUE}$APP_NAME status${C_RESET}"
  echo
  service_state "$CHROME_SERVICE"
  service_state "$API_SERVICE"
  service_state "$VNC_SERVICE"
  service_state "$NOVNC_SERVICE"
  echo
  echo "App directory: $APP_DIR"
  echo "API URL:       $API_URL"
  echo "Dashboard:    $API_URL/dashboard"
  if [[ -n "$(token || true)" ]]; then
    echo "API token:     configured"
  else
    echo "API token:     missing"
  fi
  echo
  echo "${C_CYAN}Listening ports${C_RESET}"
  ss -ltnp 2>/dev/null | grep -E ':(3030|9222|6080|5900)\b' || echo "No GMweb ports are listening."
  echo
  echo "${C_CYAN}Readiness${C_RESET}"
  ready_check
  echo
}

start_services() {
  need_root "$@"
  systemctl start "$CHROME_SERVICE"
  systemctl start "$API_SERVICE"
  echo "${C_GREEN}Chrome and API started.${C_RESET}"
}

stop_services() {
  need_root "$@"
  systemctl stop "$API_SERVICE" "$CHROME_SERVICE" 2>/dev/null || true
  echo "${C_YELLOW}Chrome and API stopped.${C_RESET}"
}

restart_api() {
  need_root "$@"
  systemctl restart "$API_SERVICE"
  echo "${C_GREEN}API restarted.${C_RESET}"
}

restart_chrome() {
  need_root "$@"
  systemctl restart "$CHROME_SERVICE"
  sleep 2
  systemctl restart "$API_SERVICE"
  echo "${C_GREEN}Chrome and API restarted.${C_RESET}"
}

vnc_on() {
  need_root "$@"
  systemctl start "$VNC_SERVICE" "$NOVNC_SERVICE"
  echo "${C_GREEN}VNC/noVNC is on.${C_RESET}"
  echo "Tunnel from your computer:"
  echo "  ssh -L 6080:127.0.0.1:6080 root@SERVER_IP"
  echo "Then open:"
  echo "  http://127.0.0.1:6080/vnc.html"
}

vnc_off() {
  need_root "$@"
  systemctl stop "$NOVNC_SERVICE" "$VNC_SERVICE" 2>/dev/null || true
  echo "${C_GREEN}VNC/noVNC is off.${C_RESET}"
}

show_token() {
  local api_token
  api_token="$(token || true)"
  if [[ -z "$api_token" ]]; then
    echo "No API_TOKEN found in $APP_DIR/.env"
    return 1
  fi
  echo "$api_token"
}

smoke() {
  need_root "$@"
  run_as_app "cd '$APP_DIR' && npm run smoke"
}

logs() {
  need_root "$@"
  local target="${1:-api}"
  local service="$API_SERVICE"

  case "$target" in
    api) service="$API_SERVICE" ;;
    chrome) service="$CHROME_SERVICE" ;;
    vnc) service="$VNC_SERVICE" ;;
    novnc) service="$NOVNC_SERVICE" ;;
    *)
      echo "Usage: gmweb logs [api|chrome|vnc|novnc]"
      return 2
      ;;
  esac

  journalctl -u "$service" -n 120 -f
}

update_app() {
  need_root "$@"
  if [[ ! -d "$APP_DIR/.git" ]]; then
    echo "No git checkout found in $APP_DIR."
    echo "Update by rerunning the installer or deploying a fresh release archive."
    return 1
  fi

  git -C "$APP_DIR" pull --ff-only
  chown -R "$APP_USER:$APP_USER" "$APP_DIR"
  run_as_app "cd '$APP_DIR' && npm ci --omit=dev"
  systemctl restart "$API_SERVICE"
  echo "${C_GREEN}Updated and restarted API.${C_RESET}"
}

uninstall_app() {
  need_root "$@"
  if [[ -x "$APP_DIR/scripts/uninstall.sh" ]]; then
    "$APP_DIR/scripts/uninstall.sh"
  else
    echo "Uninstaller not found: $APP_DIR/scripts/uninstall.sh"
    return 1
  fi
}

render_menu() {
  clear || true
  echo "${C_BOLD}${C_BLUE}GMweb API Manager${C_RESET}"
  echo "${C_CYAN}$(hostname)${C_RESET}"
  echo
  echo "  1) Status / readiness"
  echo "  2) Smoke test"
  echo "  3) Restart API"
  echo "  4) Restart Chrome + API"
  echo "  5) Start Chrome + API"
  echo "  6) Stop Chrome + API"
  echo "  7) Turn VNC/noVNC on"
  echo "  8) Turn VNC/noVNC off"
  echo "  9) Show API token"
  echo " 10) Logs"
  echo " 11) Update from git"
  echo " 12) Uninstall GMweb API"
  echo "  0) Exit"
  echo
}

menu_loop() {
  need_root "$@"
  while true; do
    render_menu
    read -r -p "Select: " choice
    echo
    case "$choice" in
      1) status; pause ;;
      2) smoke; pause ;;
      3) restart_api; pause ;;
      4) restart_chrome; pause ;;
      5) start_services; pause ;;
      6) stop_services; pause ;;
      7) vnc_on; pause ;;
      8) vnc_off; pause ;;
      9) show_token; pause ;;
      10)
        echo "api, chrome, vnc, novnc"
        read -r -p "Log target [api]: " target
        logs "${target:-api}"
        ;;
      11) update_app; pause ;;
      12) uninstall_app; exit 0 ;;
      0) exit 0 ;;
      *) echo "${C_RED}Invalid option.${C_RESET}"; pause ;;
    esac
  done
}

cmd="${1:-menu}"
shift || true

case "$cmd" in
  menu) menu_loop "$@" ;;
  status) status "$@" ;;
  ready) ready_check "$@" ;;
  smoke) smoke "$@" ;;
  start) start_services "$@" ;;
  stop) stop_services "$@" ;;
  restart|restart-api) restart_api "$@" ;;
  restart-chrome|chrome-restart) restart_chrome "$@" ;;
  vnc-on) vnc_on "$@" ;;
  vnc-off) vnc_off "$@" ;;
  token) show_token "$@" ;;
  logs) logs "$@" ;;
  update) update_app "$@" ;;
  uninstall) uninstall_app "$@" ;;
  -h|--help|help)
    cat <<HELP
Usage: gmweb [command]

Commands:
  menu             Open interactive menu
  status           Show services, ports, and /ready
  ready            Print /ready response
  smoke            Run no-send smoke test
  start            Start Chrome and API
  stop             Stop Chrome and API
  restart          Restart API
  restart-chrome   Restart Chrome and API
  vnc-on           Start temporary noVNC pairing access
  vnc-off          Stop noVNC pairing access
  token            Print API token
  logs [target]    Follow logs: api, chrome, vnc, novnc
  update           Git pull, npm ci, restart API
  uninstall        Remove GMweb API from the server
HELP
    ;;
  *)
    echo "Unknown command: $cmd"
    echo "Run: gmweb help"
    exit 2
    ;;
esac
