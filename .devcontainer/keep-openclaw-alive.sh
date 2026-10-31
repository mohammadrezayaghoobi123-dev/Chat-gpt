#!/usr/bin/env bash
set -u
export PATH="/workspaces/Chat-gpt/.devcontainer/bin:$PATH"
export TS_SOCKET="/tmp/tailscaled.sock"
export TS_STATE_DIR="/var/lib/tailscale"
export OPENCLAW_NO_RESPAWN="1"
export NODE_COMPILE_CACHE="/var/tmp/openclaw-compile-cache"
mkdir -p /tmp/openclaw /var/tmp/openclaw-compile-cache
while true; do
  if ! curl -fsS --max-time 2 http://127.0.0.1:18789/ >/dev/null 2>&1; then
    echo "[$(date -Is)] Gateway down; restarting through guarded launcher" >> /tmp/openclaw/watchdog.log
    /workspaces/Chat-gpt/.devcontainer/start-openclaw-gateway.sh >>/tmp/openclaw/watchdog-launch.log 2>&1 || true
    sleep 8
  else
    sleep 15
  fi
done
