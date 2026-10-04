#!/usr/bin/env bash
set -euo pipefail

# Install Tailscale in the Codespace image so it survives container creation/rebuilds.
if ! command -v tailscale >/dev/null 2>&1; then
  curl -fsSL https://tailscale.com/install.sh | sh
fi
curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash -s -- --no-prompt --no-onboard --verify
openclaw setup --baseline
bash "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/bootstrap-openclaw.sh"
