#!/usr/bin/env bash
set -euo pipefail

APP_NAME="${APP_NAME:-GMweb API}"
APP_DIR="${APP_DIR:-/opt/gmweb-api}"
APP_USER="${APP_USER:-gmweb}"
API_PORT="${API_PORT:-3030}"
SITE_NAME="${SITE_NAME:-gmweb-api}"
NGINX_SITE="/etc/nginx/sites-available/$SITE_NAME.conf"
NGINX_LINK="/etc/nginx/sites-enabled/$SITE_NAME.conf"
NGINX_MAP="/etc/nginx/conf.d/$SITE_NAME-websocket-map.conf"
DASHBOARD_CREDENTIALS="/root/${SITE_NAME}-dashboard-login.txt"

usage() {
  cat <<HELP
Usage:
  sudo gmweb public-dashboard install DOMAIN [EMAIL]
  sudo gmweb public-dashboard status
  sudo gmweb public-dashboard credentials
  sudo gmweb public-dashboard remove [DOMAIN]

Examples:
  sudo gmweb public-dashboard install gmweb.example.com admin@example.com
  sudo gmweb public-dashboard remove gmweb.example.com
HELP
}

need_root() {
  if [[ "$(id -u)" -eq 0 ]]; then
    return 0
  fi
  if command -v sudo >/dev/null 2>&1; then
    exec sudo -E "$0" "$@"
  fi
  echo "Run as root: sudo $0 $*"
  exit 1
}

valid_domain() {
  [[ "$1" =~ ^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$ ]]
}

random_password() {
  openssl rand -base64 33 | tr '+/' '-_' | tr -d '='
}

set_env_value() {
  local key="$1"
  local value="$2"
  local env_file="$APP_DIR/.env"

  touch "$env_file"
  if grep -q "^$key=" "$env_file"; then
    sed -i "s|^$key=.*|$key=$value|" "$env_file"
  else
    printf '%s=%s\n' "$key" "$value" >> "$env_file"
  fi
  chown "$APP_USER:$APP_USER" "$env_file" 2>/dev/null || true
  chmod 600 "$env_file"
}

install_public_dashboard() {
  local domain="${1:-}"
  local email="${2:-}"

  if [[ -z "$domain" ]]; then
    echo "DOMAIN is required."
    usage
    exit 2
  fi
  if ! valid_domain "$domain"; then
    echo "Invalid domain: $domain"
    exit 2
  fi

  echo "==> Installing Nginx and Certbot"
  apt-get update
  apt-get install -y nginx certbot python3-certbot-nginx

  echo "==> Creating dashboard login credentials"
  local dashboard_user="${GMWEB_DASHBOARD_USER:-gmwebadmin}"
  local dashboard_pass="${GMWEB_DASHBOARD_PASS:-$(random_password)}"
  local dashboard_hash
  dashboard_hash="$(node "$APP_DIR/scripts/hash-password.js" "$dashboard_pass")"
  cat > "$DASHBOARD_CREDENTIALS" <<CREDS
URL=https://$domain/dashboard
USERNAME=$dashboard_user
PASSWORD=$dashboard_pass
CREDS
  chmod 600 "$DASHBOARD_CREDENTIALS"

  echo "==> Writing Nginx reverse proxy"
  cat > "$NGINX_MAP" <<'NGINX'
map $http_upgrade $gmweb_connection_upgrade {
  default upgrade;
  '' close;
}

limit_req_zone $binary_remote_addr zone=gmweb_login:10m rate=10r/m;
limit_req_zone $binary_remote_addr zone=gmweb_admin:10m rate=60r/m;
NGINX

  cat > "$NGINX_SITE" <<NGINX
server {
  listen 80;
  listen [::]:80;
  server_name $domain;
  server_tokens off;

  client_max_body_size 20m;

  location = /dashboard/login {
    limit_req zone=gmweb_login burst=5 nodelay;
    proxy_pass http://127.0.0.1:$API_PORT;
    proxy_http_version 1.1;
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \$scheme;
    proxy_read_timeout 3600;
    proxy_send_timeout 3600;
  }

  location = /dashboard/password-login {
    limit_req zone=gmweb_login burst=5 nodelay;
    proxy_pass http://127.0.0.1:$API_PORT;
    proxy_http_version 1.1;
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \$scheme;
    proxy_read_timeout 3600;
    proxy_send_timeout 3600;
  }

  location = /admin/action {
    limit_req zone=gmweb_admin burst=10 nodelay;
    proxy_pass http://127.0.0.1:$API_PORT;
    proxy_http_version 1.1;
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \$scheme;
    proxy_set_header Upgrade \$http_upgrade;
    proxy_set_header Connection \$gmweb_connection_upgrade;
    proxy_read_timeout 3600;
    proxy_send_timeout 3600;
  }

  location / {
    proxy_pass http://127.0.0.1:$API_PORT;
    proxy_http_version 1.1;
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \$scheme;
    proxy_set_header Upgrade \$http_upgrade;
    proxy_set_header Connection \$gmweb_connection_upgrade;
    proxy_read_timeout 3600;
    proxy_send_timeout 3600;
  }
}
NGINX

  ln -sf "$NGINX_SITE" "$NGINX_LINK"
  nginx -t
  systemctl enable nginx
  systemctl reload nginx

  echo "==> Requesting HTTPS certificate"
  local certbot_args=(--nginx -d "$domain" --redirect --agree-tos --non-interactive)
  if [[ -n "$email" ]]; then
    certbot_args+=(--email "$email")
  else
    certbot_args+=(--register-unsafely-without-email)
  fi
  certbot "${certbot_args[@]}"

  echo "==> Securing dashboard cookies and CORS"
  set_env_value HOST "127.0.0.1"
  set_env_value DASHBOARD_ENABLED "true"
  set_env_value DASHBOARD_USERNAME "$dashboard_user"
  set_env_value DASHBOARD_PASSWORD_HASH "$dashboard_hash"
  set_env_value DASHBOARD_PASSWORD_SESSION_TTL_MS "600000"
  set_env_value DASHBOARD_PASSWORD_WINDOW_MS "900000"
  set_env_value DASHBOARD_PASSWORD_MAX "5"
  set_env_value DASHBOARD_COOKIE_SECURE "true"
  set_env_value DASHBOARD_BIND_USER_AGENT "true"
  set_env_value CORS_ORIGIN "https://$domain"
  set_env_value VNC_PROXY_TARGET "http://127.0.0.1:6080"

  systemctl restart gmweb-api.service

  echo
  echo "$APP_NAME dashboard is public:"
  echo "  https://$domain/dashboard"
  echo
  echo "Dashboard login credentials:"
  echo "  user: $dashboard_user"
  echo "  pass: $dashboard_pass"
  echo
  echo "Keep the API token private. You can print it with: gmweb token"
}

status_public_dashboard() {
  echo "$APP_NAME public dashboard status"
  echo
  if [[ -f "$NGINX_SITE" ]]; then
    echo "Nginx site: $NGINX_SITE"
    grep -E 'server_name|proxy_pass' "$NGINX_SITE" || true
  else
    echo "Nginx site: not installed"
  fi
  echo
  systemctl is-active nginx 2>/dev/null | sed 's/^/nginx: /' || echo "nginx: unavailable"
  systemctl is-active gmweb-api.service 2>/dev/null | sed 's/^/gmweb-api: /' || echo "gmweb-api: unavailable"
  echo
  certbot certificates 2>/dev/null | sed -n '/Certificate Name:/,/Expiry Date:/p' || true
}

show_credentials() {
  if [[ -f "$DASHBOARD_CREDENTIALS" ]]; then
    cat "$DASHBOARD_CREDENTIALS"
  else
    echo "No dashboard credentials file found: $DASHBOARD_CREDENTIALS"
    return 1
  fi
}

remove_public_dashboard() {
  local domain="${1:-}"

  echo "==> Removing Nginx public dashboard site"
  rm -f "$NGINX_LINK" "$NGINX_SITE" "$NGINX_MAP" "$DASHBOARD_CREDENTIALS"
  if command -v nginx >/dev/null 2>&1; then
    nginx -t && systemctl reload nginx || true
  fi

  if [[ -n "$domain" ]] && command -v certbot >/dev/null 2>&1; then
    certbot delete --cert-name "$domain" --non-interactive || true
  fi

  if [[ -f "$APP_DIR/.env" ]]; then
    set_env_value DASHBOARD_COOKIE_SECURE "false"
    set_env_value CORS_ORIGIN ""
    systemctl restart gmweb-api.service || true
  fi

  echo "$APP_NAME public dashboard exposure removed."
}

need_root "$@"
cmd="${1:-status}"
shift || true

case "$cmd" in
  install) install_public_dashboard "$@" ;;
  status) status_public_dashboard ;;
  credentials) show_credentials ;;
  remove) remove_public_dashboard "$@" ;;
  -h|--help|help) usage ;;
  *)
    echo "Unknown command: $cmd"
    usage
    exit 2
    ;;
esac
