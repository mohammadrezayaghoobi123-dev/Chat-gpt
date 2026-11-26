#!/usr/bin/env bash
set -euo pipefail
umask 077

GITLEAKS_BIN="${GITLEAKS_BIN:-/tmp/gitleaks-8.30.1/gitleaks}"
PYTHON_BIN="${PYTHON_BIN:-python3}"
VALIDATOR_SCRIPT="${VALIDATOR_SCRIPT:-security/validate_gitleaks_allowlists.py}"
RM_BIN="${RM_BIN:-rm}"
TEMP_ROOT="${RUNNER_TEMP:-${TMPDIR:-/tmp}}"
GITLEAKS_TIMEOUT_SECONDS="${GITLEAKS_TIMEOUT_SECONDS:-180}"

if [[ ! "$GITLEAKS_TIMEOUT_SECONDS" =~ ^[1-9][0-9]*$ ]]; then
  echo "GITLEAKS_TIMEOUT_SECONDS must be a positive integer" >&2
  exit 64
fi
if ! command -v timeout >/dev/null 2>&1; then
  echo "GNU timeout is required for bounded Gitleaks execution" >&2
  exit 127
fi
if ! command -v mktemp >/dev/null 2>&1; then
  echo "mktemp is required for private report storage" >&2
  exit 127
fi
if ! command -v "$RM_BIN" >/dev/null 2>&1; then
  echo "configured cleanup command is unavailable" >&2
  exit 127
fi
if [[ ! -d "$TEMP_ROOT" ]]; then
  echo "private report root does not exist or is not a directory" >&2
  exit 73
fi

work_dir="$(mktemp -d "$TEMP_ROOT/gitleaks-history.XXXXXX")"
cleanup() {
  local primary_status=$?
  local cleanup_status=0
  trap - EXIT
  if ! "$RM_BIN" -rf -- "$work_dir"; then
    cleanup_status=1
    echo "WARNING: temporary Gitleaks report cleanup command failed" >&2
  fi
  if [[ -e "$work_dir" || -L "$work_dir" ]]; then
    cleanup_status=1
    echo "WARNING: temporary Gitleaks report workspace still exists" >&2
  fi
  if [[ "$primary_status" -ne 0 ]]; then
    exit "$primary_status"
  fi
  if [[ "$cleanup_status" -ne 0 ]]; then
    exit "$cleanup_status"
  fi
  exit 0
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

full_report="$work_dir/full-history-redacted.json"
necessity_config="$work_dir/necessity-config.toml"
necessity_report="$work_dir/necessity-report-redacted.json"

run_gitleaks() {
  timeout --foreground --signal=TERM --kill-after=15s \
    "${GITLEAKS_TIMEOUT_SECONDS}s" "$GITLEAKS_BIN" "$@"
}

if run_gitleaks git --config .gitleaks.toml --redact --exit-code 2 \
  --report-format json --report-path "$full_report" --log-opts="--all --diff-merges=first-parent" .; then
  scan_status=0
else
  scan_status=$?
fi

if [[ "$scan_status" -ne 0 ]]; then
  echo "Baseline full-history Gitleaks scan failed with exit code $scan_status" >&2
  exit "$scan_status"
fi

if [[ ! -s "$full_report" ]]; then
  echo "Baseline redacted report is missing or empty" >&2
  exit 2
fi

"$PYTHON_BIN" "$VALIDATOR_SCRIPT" --baseline-report "$full_report"
"$PYTHON_BIN" "$VALIDATOR_SCRIPT" --necessity-config "$necessity_config"

if run_gitleaks git --config "$necessity_config" --redact --exit-code 2 \
  --report-format json --report-path "$necessity_report" --log-opts="--all --diff-merges=first-parent" .; then
  necessity_scan_status=0
else
  necessity_scan_status=$?
fi

if [[ "$necessity_scan_status" -ne 2 ]]; then
  echo "Necessity scan must produce findings (expected exit code 2); observed $necessity_scan_status" >&2
  if [[ "$necessity_scan_status" -eq 0 ]]; then
    exit 1
  fi
  exit "$necessity_scan_status"
fi

if [[ ! -s "$necessity_report" ]]; then
  echo "Redacted necessity report missing or empty" >&2
  exit 1
fi

"$PYTHON_BIN" "$VALIDATOR_SCRIPT" --necessity-report "$necessity_report"
exit "$scan_status"
