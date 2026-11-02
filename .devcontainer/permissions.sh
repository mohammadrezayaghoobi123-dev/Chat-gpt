#!/usr/bin/env bash
set -euo pipefail

secure_tailscale_log() {
  local log_file="${TAILSCALE_LOG_PATH:-/tmp/tailscaled.log}"
  if [[ -f "$log_file" ]]; then
    chmod 600 "$log_file"
  fi
}
