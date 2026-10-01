#!/usr/bin/env bash
set -euo pipefail
curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash -s -- --no-prompt --no-onboard --verify
bash "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/bootstrap-openclaw.sh"
