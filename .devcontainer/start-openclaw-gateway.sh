#!/usr/bin/env bash
set -euo pipefail
export TS_SOCKET="/tmp/tailscaled.sock"
export TS_STATE_DIR="/var/lib/tailscale"
export OPENCLAW_NO_RESPAWN="1"
export NODE_COMPILE_CACHE="/var/tmp/openclaw-compile-cache"
mkdir -p /var/tmp/openclaw-compile-cache /tmp/openclaw
if curl -fsS --max-time 2 http://127.0.0.1:18789/ >/dev/null 2>&1; then
  echo "OpenClaw Gateway already listening on 18789"
  exit 0
fi
nohup openclaw gateway run --verbose >/tmp/openclaw/gateway-codespace.log 2>&1 </dev/null &
gateway_pid=$!
echo "OpenClaw Gateway launch requested (pid $gateway_pid)"
for _ in $(seq 1 30); do
  if curl -fsS --max-time 1 http://127.0.0.1:18789/ >/dev/null 2>&1; then
    echo "OpenClaw Gateway is listening on 18789"
    if ! pgrep -f '/workspaces/Chat-gpt/.devcontainer/keep-openclaw-alive.sh' >/dev/null 2>&1; then
      nohup /workspaces/Chat-gpt/.devcontainer/keep-openclaw-alive.sh >/tmp/openclaw/watchdog-console.log 2>&1 </dev/null &
    fi
    exit 0
  fi
  sleep 1
done
echo "OpenClaw Gateway did not become ready within 30s" >&2
exit 1
