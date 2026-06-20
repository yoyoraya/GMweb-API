#!/usr/bin/env bash
set -euo pipefail

APP_NAME="${APP_NAME:-GMweb API}"
APP_USER="${APP_USER:-gmweb}"
APP_DIR="${APP_DIR:-/opt/gmweb-api}"
SERVICE_PREFIX="${SERVICE_PREFIX:-gmweb}"
FORCE=false
PURGE_PACKAGES=false

for arg in "$@"; do
  case "$arg" in
    --force)
      FORCE=true
      ;;
    --purge-packages)
      PURGE_PACKAGES=true
      ;;
    -h|--help)
      cat <<HELP
Usage: sudo scripts/uninstall.sh [--force] [--purge-packages]

Removes GMweb services, command wrappers, app files, browser profile, and the
service user. Package removal is optional because Chrome/VNC packages may be
shared by other apps.
HELP
      exit 0
      ;;
    *)
      echo "Unknown option: $arg"
      exit 2
      ;;
  esac
done

if [[ "$(id -u)" -ne 0 ]]; then
  if command -v sudo >/dev/null 2>&1; then
    exec sudo -E "$0" "$@"
  fi
  echo "Run as root: sudo $0"
  exit 1
fi

confirm() {
  if [[ "$FORCE" == "true" ]]; then
    return 0
  fi

  echo "This will permanently remove $APP_NAME from this server."
  echo "It removes:"
  echo "  - systemd services: ${SERVICE_PREFIX}-api/chrome/vnc/novnc"
  echo "  - app directory: $APP_DIR"
  echo "  - browser profile and cached Google Messages session"
  echo "  - command wrappers under /usr/local/bin/gmweb*"
  echo "  - service user: $APP_USER"
  echo
  read -r -p "Type DELETE GMWEB to continue: " answer
  if [[ "$answer" != "DELETE GMWEB" ]]; then
    echo "Uninstall cancelled."
    exit 0
  fi
}

remove_services() {
  local services=(
    "${SERVICE_PREFIX}-api.service"
    "${SERVICE_PREFIX}-chrome.service"
    "${SERVICE_PREFIX}-vnc.service"
    "${SERVICE_PREFIX}-novnc.service"
  )

  echo "==> Stopping services"
  systemctl stop "${services[@]}" 2>/dev/null || true

  echo "==> Disabling services"
  systemctl disable "${services[@]}" 2>/dev/null || true

  echo "==> Removing service files"
  for service in "${services[@]}"; do
    rm -f "/etc/systemd/system/$service"
  done
  systemctl daemon-reload
  systemctl reset-failed "${services[@]}" 2>/dev/null || true
}

remove_commands() {
  echo "==> Removing command wrappers"
  rm -f \
    /usr/local/bin/gmweb \
    /usr/local/bin/gmweb-token \
    /usr/local/bin/gmweb-status \
    /usr/local/bin/gmweb-smoke \
    /usr/local/bin/gmweb-vnc-on \
    /usr/local/bin/gmweb-vnc-off \
    /usr/local/bin/gmweb-uninstall
}

remove_files_and_user() {
  echo "==> Removing app directory"
  rm -rf "$APP_DIR"

  if id "$APP_USER" >/dev/null 2>&1; then
    echo "==> Removing service user: $APP_USER"
    pkill -u "$APP_USER" 2>/dev/null || true
    userdel -r "$APP_USER" 2>/dev/null || userdel "$APP_USER" 2>/dev/null || true
  fi
}

maybe_purge_packages() {
  if [[ "$FORCE" != "true" && "$PURGE_PACKAGES" != "true" ]]; then
    echo
    read -r -p "Type REMOVE PACKAGES to also purge Chrome/VNC packages: " answer
    if [[ "$answer" == "REMOVE PACKAGES" ]]; then
      PURGE_PACKAGES=true
    fi
  fi

  if [[ "$PURGE_PACKAGES" == "true" ]]; then
    echo "==> Purging optional packages"
    apt-get purge -y google-chrome-stable xvfb x11vnc fluxbox novnc websockify || true
    rm -f /etc/apt/sources.list.d/google-chrome.list
    rm -f /etc/apt/keyrings/google-linux.gpg
    apt-get autoremove -y || true
  fi
}

confirm
remove_services
remove_commands
remove_files_and_user
maybe_purge_packages

echo
echo "$APP_NAME has been removed."
