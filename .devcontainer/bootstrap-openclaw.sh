#!/usr/bin/env bash
set -euo pipefail

WORKSPACE="${OPENCLAW_WORKSPACE:-$HOME/.openclaw/workspace}"
SOURCE="$(cd "$(dirname "${BASH_SOURCE[0]}")/../openclaw/bootstrap" && pwd)"

mkdir -p "$WORKSPACE/memory" "$WORKSPACE/skills"

copy_if_missing() {
  local src="$1"
  local dst="$2"
  if [ ! -e "$dst" ]; then
    cp "$src" "$dst"
  fi
}

copy_if_missing "$SOURCE/AGENTS.md" "$WORKSPACE/AGENTS.md"
copy_if_missing "$SOURCE/SOUL.md" "$WORKSPACE/SOUL.md"
copy_if_missing "$SOURCE/USER.md" "$WORKSPACE/USER.md"
copy_if_missing "$SOURCE/MEMORY.md" "$WORKSPACE/MEMORY.md"

echo "OpenClaw workspace bootstrap prepared at: $WORKSPACE"
