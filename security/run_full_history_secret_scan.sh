#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

GITLEAKS_BIN="${GITLEAKS_BIN:-/tmp/gitleaks-8.30.1/gitleaks}"
PYTHON_BIN="${PYTHON_BIN:-python3}"
VALIDATOR_SCRIPT="${VALIDATOR_SCRIPT:-security/validate_gitleaks_allowlists.py}"
TEMP_ROOT="${TMPDIR:-${RUNNER_TEMP:-/tmp}}"
workspace="$(mktemp -d "${TEMP_ROOT%/}/gitleaks-history.XXXXXXXX")"
full_report="$workspace/full-history-redacted.json"
necessity_config="$workspace/necessity-config.toml"
necessity_report="$workspace/necessity-report-redacted.json"
trap 'rm -rf "$workspace"' EXIT

if "$GITLEAKS_BIN" git --config .gitleaks.toml --redact --exit-code 2 \
  --report-format json --report-path "$full_report" --log-opts="--all" .; then
  baseline_status=0
else
  baseline_status=$?
fi

# A baseline finding (Gitleaks exit 2) is a hard stop, not a diagnostic success.
if [ "$baseline_status" -ne 0 ]; then
  echo "Full-history baseline scan must be clean; observed exit code $baseline_status" >&2
  exit "$baseline_status"
fi

if [ ! -s "$full_report" ]; then
  echo "Full-history baseline report is missing or empty" >&2
  exit 1
fi
"$PYTHON_BIN" "$VALIDATOR_SCRIPT" --baseline-report "$full_report"

"$PYTHON_BIN" "$VALIDATOR_SCRIPT" --necessity-config "$necessity_config"

if "$GITLEAKS_BIN" git --config "$necessity_config" --redact --exit-code 2 \
  --report-format json --report-path "$necessity_report" --log-opts="--all" .; then
  necessity_status=0
else
  necessity_status=$?
fi
if [ "$necessity_status" -ne 2 ]; then
  echo "Necessity scan must produce findings (expected exit code 2); observed $necessity_status" >&2
  exit 1
fi
if [ ! -s "$necessity_report" ]; then
  echo "Redacted necessity report missing or empty" >&2
  exit 1
fi
"$PYTHON_BIN" "$VALIDATOR_SCRIPT" --necessity-report "$necessity_report"
