#!/usr/bin/env bash
# GMweb watchdog — run by gmweb-monitor.timer every couple of minutes.
# Checks the API is alive and Google Messages is still paired; self-heals by
# restarting Chrome + API when the session wedges (e.g. Google cookie rotation
# that outlives the in-app retry window). All actions are logged.
set -uo pipefail

APP_DIR="${APP_DIR:-/opt/gmweb-api}"
LOG_DIR="${LOG_DIR:-/var/log/gmweb}"
STATE_DIR="${STATE_DIR:-/var/lib/gmweb}"
LOG="$LOG_DIR/monitor.log"
STATE="$STATE_DIR/unpaired-count"
FAIL_THRESHOLD="${FAIL_THRESHOLD:-3}"   # consecutive bad cycles before recovering

mkdir -p "$LOG_DIR" "$STATE_DIR"

log() { echo "$(date '+%F %T') $*" >>"$LOG"; }

PORT="$(grep -m1 '^PORT=' "$APP_DIR/.env" 2>/dev/null | cut -d= -f2- || echo 3030)"
PORT="${PORT:-3030}"
TOKEN="$(grep -m1 '^API_TOKEN=' "$APP_DIR/.env" 2>/dev/null | cut -d= -f2-)"
BASE="http://127.0.0.1:${PORT}"

count="$(cat "$STATE" 2>/dev/null || echo 0)"
[[ "$count" =~ ^[0-9]+$ ]] || count=0

# 1) Is the API process answering at all?
if ! curl -fsS -m 8 "$BASE/health" >/dev/null 2>&1; then
  log "health DOWN -> restarting gmweb-api"
  systemctl restart gmweb-api.service
  echo 0 >"$STATE"
  exit 0
fi

# 2) Is Google Messages paired?
ready="$(curl -fsS -m 15 -H "Authorization: Bearer $TOKEN" "$BASE/ready" 2>/dev/null || echo '')"
if echo "$ready" | grep -q '"paired":true'; then
  [[ "$count" != "0" ]] && log "paired OK again (was $count bad cycles)"
  echo 0 >"$STATE"
  exit 0
fi

# Not paired / not ready.
count=$((count + 1))
echo "$count" >"$STATE"
log "not paired (cycle $count/$FAIL_THRESHOLD): ${ready:-no response}"

if (( count >= FAIL_THRESHOLD )); then
  log "threshold reached -> recovering: restart gmweb-chrome + gmweb-api"
  systemctl restart gmweb-chrome.service
  sleep 6
  systemctl restart gmweb-api.service
  echo 0 >"$STATE"
fi
