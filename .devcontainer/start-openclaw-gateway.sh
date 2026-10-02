#!/usr/bin/env bash
set -euo pipefail

mkdir -p /var/tmp/openclaw-compile-cache /tmp/openclaw

if curl -fsS --max-time 2 http://127.0.0.1:18789/ >/dev/null 2>&1; then
  echo "OpenClaw Gateway already listening on 18789"
  exit 0
fi

nohup openclaw gateway run --verbose >/tmp/openclaw/gateway-codespace.log 2>&1 </dev/null &
echo "OpenClaw Gateway launch requested (pid $!)"
