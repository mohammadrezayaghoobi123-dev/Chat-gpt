#!/usr/bin/env bash
set -u
mkdir -p /tmp/openclaw /var/tmp/openclaw-compile-cache

while true; do
  if ! curl -fsS --max-time 2 http://127.0.0.1:18789/ >/dev/null 2>&1; then
    echo "[$(date -Is)] Gateway down; restarting" >> /tmp/openclaw/watchdog.log
    nohup openclaw gateway run --verbose >>/tmp/openclaw/gateway-codespace.log 2>&1 </dev/null &
    sleep 5
  else
    sleep 15
  fi
done
