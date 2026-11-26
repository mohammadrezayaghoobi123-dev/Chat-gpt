import os
import pathlib
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "security" / "run_full_history_secret_scan.sh"
sys.path.insert(0, str(ROOT / "security"))


class FullHistoryScanOrchestrationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.temp_root = pathlib.Path(self.temp.name)
        self.log = self.temp_root / "calls.log"
        self.tmpdir = self.temp_root / "tmp"
        self.tmpdir.mkdir()
        self.gitleaks = self.temp_root / "fake-gitleaks"
        self.python = self.temp_root / "fake-python"
        self.gitleaks.write_text(
            """#!/usr/bin/env bash
set -euo pipefail
report_path=""
previous=""
for argument in "$@"; do
  if [[ "$previous" == "--report-path" ]]; then report_path="$argument"; fi
  previous="$argument"
done
if [[ "$*" == *"--config .gitleaks.toml"* ]]; then
  echo gitleaks-baseline >> "$CALL_LOG"
  status="${BASELINE_STATUS:-0}"
  content="${BASELINE_REPORT_CONTENT:-[]}"
  mode="${BASELINE_REPORT_MODE:-normal}"
else
  echo gitleaks-necessity >> "$CALL_LOG"
  status="${NECESSITY_STATUS:-2}"
  content="${NECESSITY_REPORT_CONTENT:-[]}"
  mode="${NECESSITY_REPORT_MODE:-normal}"
fi
if [[ "$mode" != "missing" ]]; then
  if [[ "$mode" == "empty" ]]; then : > "$report_path"
  else printf '%s' "$content" > "$report_path"
  fi
fi
exit "$status"
""",
            encoding="utf-8",
        )
        self.python.write_text(
            """#!/usr/bin/env bash
set -euo pipefail
validator="$1"
shift
case "${1:-}" in
  --baseline-report)
    echo validator-baseline >> "$CALL_LOG"
    exit "${BASELINE_VALIDATOR_STATUS:-0}"
    ;;
  --necessity-config)
    echo validator-config >> "$CALL_LOG"
    mkdir -p "$(dirname "$2")"
    printf 'test config\\n' > "$2"
    ;;
  --necessity-report)
    echo validator-necessity >> "$CALL_LOG"
    exit "${NECESSITY_VALIDATOR_STATUS:-0}"
    ;;
  *)
    echo "unexpected validator arguments" >&2
    exit 90
    ;;
esac
""",
            encoding="utf-8",
        )
        self.gitleaks.chmod(0o755)
        self.python.chmod(0o755)
        self.bash = None
        if os.name == "nt":
            candidate = pathlib.Path(r"C:\Program Files\Git\bin\bash.exe")
            if candidate.exists():
                self.bash = str(candidate)
        if self.bash is None:
            self.bash = shutil.which("bash")

    def shell_path(self, path):
        if os.name == "nt":
            cygpath = pathlib.Path(self.bash).parents[1] / "usr" / "bin" / "cygpath.exe"
            return subprocess.check_output(
                [str(cygpath), "-u", str(path)], text=True
            ).strip()
        return str(path)

    def tearDown(self):
        self.temp.cleanup()

    def run_orchestrator(self, **overrides):
        self.assertIsNotNone(self.bash, "Bash is required to execute the workflow orchestrator")
        env = os.environ.copy()
        env.update(
            {
                "CALL_LOG": self.shell_path(self.log),
                "TMPDIR": self.shell_path(self.tmpdir),
                "GITLEAKS_BIN": self.shell_path(self.gitleaks),
                "PYTHON_BIN": self.shell_path(self.python),
                "VALIDATOR_SCRIPT": "validator-under-test.py",
                "BASELINE_STATUS": "0",
                "NECESSITY_STATUS": "2",
            }
        )
        env.update({key: str(value) for key, value in overrides.items()})
        return subprocess.run(
            [self.bash, self.shell_path(SCRIPT)],
            cwd=ROOT,
            env=env,
            text=True,
            capture_output=True,
            check=False,
        )

    def calls(self):
        return self.log.read_text(encoding="utf-8").splitlines() if self.log.exists() else []

    def assert_temp_workspace_cleaned(self):
        self.assertEqual(list(self.tmpdir.iterdir()), [])

    def test_baseline_findings_stop_before_any_downstream_action(self):
        result = self.run_orchestrator(BASELINE_STATUS=2)
        self.assertEqual(result.returncode, 2, result.stderr)
        self.assertEqual(self.calls(), ["gitleaks-baseline"])
        self.assert_temp_workspace_cleaned()

    def test_baseline_operational_errors_fail_closed(self):
        for status in (1, 7, 124, 137, 143):
            with self.subTest(status=status):
                self.log.unlink(missing_ok=True)
                result = self.run_orchestrator(BASELINE_STATUS=status)
                self.assertEqual(result.returncode, status, result.stderr)
                self.assertEqual(self.calls(), ["gitleaks-baseline"])
                self.assert_temp_workspace_cleaned()

    def test_baseline_report_validation_failure_stops_before_necessity(self):
        result = self.run_orchestrator(BASELINE_VALIDATOR_STATUS=1)
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertEqual(self.calls(), ["gitleaks-baseline", "validator-baseline"])
        self.assert_temp_workspace_cleaned()

    def test_necessity_scan_must_return_findings_exit_code(self):
        result = self.run_orchestrator(NECESSITY_STATUS=0)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(
            self.calls(),
            [
                "gitleaks-baseline",
                "validator-baseline",
                "validator-config",
                "gitleaks-necessity",
            ],
        )
        self.assert_temp_workspace_cleaned()

    def test_successful_sequence_is_ordered_and_cleans_temporary_files(self):
        result = self.run_orchestrator()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            self.calls(),
            [
                "gitleaks-baseline",
                "validator-baseline",
                "validator-config",
                "gitleaks-necessity",
                "validator-necessity",
            ],
        )
        self.assert_temp_workspace_cleaned()

    def test_baseline_report_contract_accepts_only_an_empty_json_array(self):
        import validate_gitleaks_allowlists as validator

        verify = getattr(validator, "verify_baseline_report", None)
        self.assertTrue(callable(verify), "strict baseline report validator is missing")
        self.assertEqual(verify([]), [])
        self.assertTrue(verify([{"RuleID": "generic-api-key"}]))
        self.assertTrue(verify({}))
        self.assertTrue(verify(None))


if __name__ == "__main__":
    unittest.main()
