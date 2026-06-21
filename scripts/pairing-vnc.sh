#!/usr/bin/env bash
set -euo pipefail

DISPLAY_ID="${DISPLAY_ID:-:99}"
VNC_PORT="${VNC_PORT:-5900}"

export DISPLAY="$DISPLAY_ID"
exec x11vnc -localhost -forever -shared -rfbport "$VNC_PORT"
