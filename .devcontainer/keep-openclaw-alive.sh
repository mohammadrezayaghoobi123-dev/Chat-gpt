#!/usr/bin/env bash
set -u
export PATH="/home/vscode/bin:$PATH"
mkdir -p /tmp/openclaw /var/tmp/openclaw-compile-cache

while true; do
  if curl -fsS --max-time 3 http://127.0.0.1:18789/ >/dev/null 2>&1; then
    sleep 15
    continue
  fi

  # A Gateway restart can briefly make HTTP unavailable. Do not spawn a second
  # Gateway while the existing daemon is still alive; wait for it to recover.
  if pgrep -f '^openclaw-gateway$' >/dev/null 2>&1; then
    echo "[$(date -Is)] Gateway HTTP probe failed; existing gateway process still alive; waiting" >> /tmp/openclaw/watchdog.log
    sleep 10
    continue
  fi

  echo "[$(date -Is)] Gateway process absent; starting gateway" >> /tmp/openclaw/watchdog.log
  nohup openclaw gateway run --verbose >>/tmp/openclaw/gateway-codespace.log 2>&1 </dev/null &
  sleep 8
done
