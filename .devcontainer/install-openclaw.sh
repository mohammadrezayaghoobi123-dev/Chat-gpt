#!/usr/bin/env bash
set -euo pipefail

# Install Tailscale in the Codespace image so it survives container creation/rebuilds.
if ! command -v tailscale >/dev/null 2>&1; then
  curl -fsSL https://tailscale.com/install.sh | sh
fi

# In a privileged Codespace, start tailscaled automatically after installation.
if command -v tailscaled >/dev/null 2>&1 && [ "${CODESPACES:-false}" = "true" ]; then
  sudo mkdir -p /var/lib/tailscale
  if [ -f /tmp/tailscaled.state ] && [ ! -f /var/lib/tailscale/tailscaled.state ]; then
    sudo cp -p /tmp/tailscaled.state /var/lib/tailscale/tailscaled.state
  fi
  if ! pgrep -x tailscaled >/dev/null 2>&1; then
    sudo nohup /usr/sbin/tailscaled --statedir=/var/lib/tailscale --socket=/tmp/tailscaled.sock --tun=userspace-networking >/tmp/tailscaled.log 2>&1 </dev/null &
  fi
fi
curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash -s -- --no-prompt --no-onboard --verify
openclaw setup --baseline
bash "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/bootstrap-openclaw.sh"
