#!/usr/bin/env bash
# Install the hister-attn counter as a macOS LaunchAgent, resolving your machine's
# node path, this repo's location, and your log dir from the plist template. Also
# builds the Hister extension fork. Idempotent — safe to re-run.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
LABEL="com.hister-attn"
AGENT="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG_DIR="$HOME/Library/Logs"

NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ]; then echo "ERROR: node not found on PATH (need >=22.5 for node:sqlite)." >&2; exit 1; fi

echo "node    : $NODE_BIN"
echo "server  : $HERE/service/server.mjs"
echo "agent   : $AGENT"

mkdir -p "$HOME/Library/LaunchAgents" "$LOG_DIR"
sed -e "s#__NODE_BIN__#$NODE_BIN#g" \
    -e "s#__SERVER_JS__#$HERE/service/server.mjs#g" \
    -e "s#__LOG_DIR__#$LOG_DIR#g" \
    "$HERE/com.hister-attn.plist.template" > "$AGENT"

launchctl unload "$AGENT" 2>/dev/null || true
launchctl load "$AGENT"
sleep 1

PORT="${HISTER_ATTN_PORT:-4434}"
if curl -fsS "http://127.0.0.1:$PORT/" >/dev/null 2>&1; then
  echo "service : up on http://127.0.0.1:$PORT"
else
  echo "service : did NOT come up — check $LOG_DIR/hister-attn.err.log" >&2
fi

echo
echo "Building the extension fork..."
"$HERE/apply-fork.sh"
