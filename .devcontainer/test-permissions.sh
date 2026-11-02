#!/usr/bin/env bash
set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/permissions.sh"
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT
log_file="$tmp_dir/tailscaled.log"
printf 'synthetic diagnostic\n' > "$log_file"
chmod 644 "$log_file"
secure_tailscale_log "$log_file"
mode="$(stat -c '%a' "$log_file")"
if [[ "$mode" != "600" ]]; then
  printf 'expected existing Tailscale log mode 600, got %s\n' "$mode" >&2
  exit 1
fi
printf 'PASS: existing Tailscale log is restricted to owner read/write\n'
