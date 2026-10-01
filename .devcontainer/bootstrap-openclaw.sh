#!/usr/bin/env bash
set -euo pipefail

WORKSPACE="${OPENCLAW_WORKSPACE:-$HOME/.openclaw/workspace}"
SOURCE="$(cd "$(dirname "${BASH_SOURCE[0]}")/../openclaw/bootstrap" && pwd)"
MARKER="<!-- Chat-gpt OpenClaw policy -->"

mkdir -p "$WORKSPACE/memory" "$WORKSPACE/skills"

append_policy() {
  local src="$1"
  local dst="$2"
  if [ ! -f "$dst" ]; then
    cp "$src" "$dst"
  elif ! grep -qF "$MARKER" "$dst"; then
    {
      printf "\n\n%s\n\n" "$MARKER"
      cat "$src"
    } >> "$dst"
  fi
}

append_policy "$SOURCE/AGENTS.md" "$WORKSPACE/AGENTS.md"
append_policy "$SOURCE/SOUL.md" "$WORKSPACE/SOUL.md"
append_policy "$SOURCE/USER.md" "$WORKSPACE/USER.md"

if [ ! -f "$WORKSPACE/MEMORY.md" ]; then
  cp "$SOURCE/MEMORY.md" "$WORKSPACE/MEMORY.md"
fi

echo "OpenClaw workspace bootstrap prepared at: $WORKSPACE"
