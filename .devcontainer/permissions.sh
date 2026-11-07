#!/usr/bin/env bash
set -euo pipefail

secure_tailscale_log() {
  local log_file="${1:-/tmp/tailscaled.log}"
  if [[ -L "$log_file" ]]; then
    printf "Refusing symlinked Tailscale log path: %s\\n" "$log_file" >&2
    return 1
  fi
  if [[ -f "$log_file" ]]; then
    chmod 600 -- "$log_file"
  fi
}
