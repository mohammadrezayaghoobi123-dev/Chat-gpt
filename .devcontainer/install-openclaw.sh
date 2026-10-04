#!/usr/bin/env bash
set -euo pipefail

export TS_SOCKET="/tmp/tailscaled.sock"
export TS_STATE_DIR="/var/lib/tailscale"
export OPENCLAW_NO_RESPAWN="1"
export NODE_COMPILE_CACHE="/var/tmp/openclaw-compile-cache"

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

# Keep gateway authentication stable across gateway restarts/rebuilds.
python3 - <<'PY'
import json, os, secrets, stat
p=os.path.expanduser("~/.openclaw/openclaw.json")
try:
    with open(p) as f:
        d=json.load(f)
except FileNotFoundError:
    d={}
g=d.setdefault("gateway", {})
g["bind"]="loopback"
a=g.setdefault("auth", {})
a["mode"]="token"
if not a.get("token"):
    a["token"]=secrets.token_urlsafe(32)
tmp=p+".tmp"
with open(tmp,"w") as f:
    json.dump(d,f,indent=2)
    f.write("\n")
os.chmod(tmp, stat.S_IRUSR|stat.S_IWUSR)
os.replace(tmp,p)
os.chmod(p, stat.S_IRUSR|stat.S_IWUSR)
print("OpenClaw gateway token configured locally (not displayed)")
PY

bash "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/bootstrap-openclaw.sh"
