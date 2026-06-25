#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="${ROOT_DIR:-/opt/google-messages-bridge}"
PROFILE_DIR="${USER_DATA_DIR:-$ROOT_DIR/data/browser-profile}"
DISPLAY_ID="${DISPLAY_ID:-:99}"
CDP_PORT="${BROWSER_CDP_PORT:-9222}"

mkdir -p "$PROFILE_DIR"

export DISPLAY="$DISPLAY_ID"

if ! pgrep -f "Xvfb $DISPLAY_ID" >/dev/null 2>&1; then
  Xvfb "$DISPLAY_ID" -screen 0 1280x900x24 -ac +extension GLX +render -noreset &
fi

# After an unclean shutdown Chrome shows a "Restore pages?" bubble that can
# intercept clicks and break the Start-chat flow. Clear the crash markers and
# suppress the bubble so automation always starts from a clean window.
PREFS="$PROFILE_DIR/Default/Preferences"
if [ -f "$PREFS" ]; then
  sed -i 's/"exit_type":"Crashed"/"exit_type":"Normal"/g; s/"exited_cleanly":false/"exited_cleanly":true/g' "$PREFS" 2>/dev/null || true
fi

google-chrome \
  --user-data-dir="$PROFILE_DIR" \
  --remote-debugging-address=127.0.0.1 \
  --remote-debugging-port="$CDP_PORT" \
  --no-first-run \
  --no-default-browser-check \
  --disable-dev-shm-usage \
  --disable-gpu \
  --disable-session-crashed-bubble \
  --hide-crash-restore-bubble \
  --noerrdialogs \
  --disable-extensions \
  --disable-popup-blocking \
  https://messages.google.com/web
