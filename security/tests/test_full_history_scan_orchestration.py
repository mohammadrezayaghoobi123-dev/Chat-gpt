import contextlib
import io
import json
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

ROOT = pathlib.Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "security" / "run_full_history_secret_scan.sh"
sys.path.insert(0, str(ROOT / "security"))


class FullHistoryScanOrchestrationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.temp_root = pathlib.Path(self.temp.name)
        self.log = self.temp_root / "calls.log"
        self.args_log = self.temp_root / "gitleaks-args.log"
        self.tmpdir = self.temp_root / "tmp"
        self.tmpdir.mkdir()
        self.gitleaks = self.temp_root / "fake-gitleaks"
        self.python = self.temp_root / "fake-python"
        self.fake_rm = self.temp_root / "fake-rm"
        self.gitleaks.write_text(
            """#!/usr/bin/env bash
set -euo pipefail
report_path=""
previous=""
printf '%s\\n' "$@" >> "$ARGS_LOG"
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
if [[ "${GITLEAKS_SIGNAL:-}" == "TERM" ]]; then kill -TERM "$$"; fi
sleep "${GITLEAKS_SLEEP_SECONDS:-0}"
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
        self.fake_rm.write_text(
            """#!/usr/bin/env bash
set -euo pipefail
echo rm-cleanup >> "$CALL_LOG"
exit 1
""",
            encoding="utf-8",
        )
        self.gitleaks.chmod(0o755)
        self.python.chmod(0o755)
        self.fake_rm.chmod(0o755)
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

    def run_orchestrator(self, script_path=SCRIPT, **overrides):
        self.assertIsNotNone(self.bash, "Bash is required to execute the workflow orchestrator")
        env = os.environ.copy()
        env.update(
            {
                "CALL_LOG": self.shell_path(self.log),
                "ARGS_LOG": self.shell_path(self.args_log),
                "RUNNER_TEMP": self.shell_path(self.tmpdir),
                "TMPDIR": self.shell_path(self.tmpdir),
                "GITLEAKS_BIN": self.shell_path(self.gitleaks),
                "PYTHON_BIN": self.shell_path(self.python),
                "RM_BIN": "rm",
                "VALIDATOR_SCRIPT": "validator-under-test.py",
                "BASELINE_STATUS": "0",
                "NECESSITY_STATUS": "2",
                "GITLEAKS_TIMEOUT_SECONDS": "180",
            }
        )
        env.update({key: str(value) for key, value in overrides.items()})
        return subprocess.run(
            [self.bash, self.shell_path(script_path)],
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

    def test_missing_runner_temp_root_fails_before_scanning(self):
        missing_root = self.temp_root / "does-not-exist"
        result = self.run_orchestrator(RUNNER_TEMP=self.shell_path(missing_root))
        self.assertEqual(result.returncode, 73, result.stderr)
        self.assertEqual(self.calls(), [])
        self.assertEqual(list(self.tmpdir.iterdir()), [])

    def test_both_history_scans_request_merge_resolution_diffs(self):
        result = self.run_orchestrator()
        self.assertEqual(result.returncode, 0, result.stderr)
        arguments = self.args_log.read_text(encoding="utf-8").splitlines()
        self.assertEqual(
            arguments.count("--log-opts=--all --diff-merges=first-parent"),
            2,
            arguments,
        )

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

    def test_signal_termination_stops_before_downstream_action(self):
        result = self.run_orchestrator(GITLEAKS_SIGNAL="TERM")
        self.assertEqual(result.returncode, 143, result.stderr)
        self.assertEqual(self.calls(), ["gitleaks-baseline"])
        self.assert_temp_workspace_cleaned()

    @unittest.skipIf(os.name == "nt", "POSIX signal delivery is required")
    def test_parent_sigterm_runs_cleanup_and_preserves_signal_status(self):
        env = os.environ.copy()
        env.update(
            {
                "CALL_LOG": self.shell_path(self.log),
                "RUNNER_TEMP": self.shell_path(self.tmpdir),
                "TMPDIR": self.shell_path(self.tmpdir),
                "GITLEAKS_BIN": self.shell_path(self.gitleaks),
                "PYTHON_BIN": self.shell_path(self.python),
                "RM_BIN": "rm",
                "VALIDATOR_SCRIPT": "validator-under-test.py",
                "BASELINE_STATUS": "0",
                "NECESSITY_STATUS": "2",
                "GITLEAKS_TIMEOUT_SECONDS": "1",
                "GITLEAKS_SLEEP_SECONDS": "3",
            }
        )
        process = subprocess.Popen(
            [self.bash, self.shell_path(SCRIPT)],
            cwd=ROOT,
            env=env,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        deadline = time.monotonic() + 5
        while not self.log.exists() and time.monotonic() < deadline:
            time.sleep(0.02)
        self.assertTrue(self.log.exists(), "baseline child did not start")
        process.terminate()
        stdout, stderr = process.communicate(timeout=5)
        self.assertEqual(process.returncode, 143, stdout + stderr)
        self.assertEqual(self.calls(), ["gitleaks-baseline"])
        self.assert_temp_workspace_cleaned()

    def test_real_child_timeout_stops_before_downstream_action(self):
        result = self.run_orchestrator(
            GITLEAKS_SLEEP_SECONDS=3,
            GITLEAKS_TIMEOUT_SECONDS=1,
        )
        self.assertEqual(result.returncode, 124, result.stderr)
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


    def test_cleanup_failure_fails_clean_scan_and_reports_residual_workspace(self):
        result = self.run_orchestrator(RM_BIN=self.shell_path(self.fake_rm))
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn("cleanup command failed", result.stderr)
        self.assertIn("workspace still exists", result.stderr)
        self.assertEqual(
            self.calls(),
            [
                "gitleaks-baseline",
                "validator-baseline",
                "validator-config",
                "gitleaks-necessity",
                "validator-necessity",
                "rm-cleanup",
            ],
        )
        self.assertTrue(any(path.name.startswith("gitleaks-history.") for path in self.tmpdir.iterdir()))

    def test_cleanup_failure_does_not_mask_primary_scan_failure(self):
        result = self.run_orchestrator(
            BASELINE_STATUS=2,
            RM_BIN=self.shell_path(self.fake_rm),
        )
        self.assertEqual(result.returncode, 2, result.stdout + result.stderr)
        self.assertEqual(self.calls(), ["gitleaks-baseline", "rm-cleanup"])
        self.assertTrue(any(path.name.startswith("gitleaks-history.") for path in self.tmpdir.iterdir()))

    def test_baseline_report_artifact_must_exist_and_be_nonempty(self):
        for mode in ("missing", "empty"):
            with self.subTest(mode=mode):
                self.log.unlink(missing_ok=True)
                result = self.run_orchestrator(BASELINE_REPORT_MODE=mode)
                self.assertEqual(result.returncode, 2, result.stderr)
                self.assertEqual(self.calls(), ["gitleaks-baseline"])
                self.assert_temp_workspace_cleaned()

    def test_orchestrator_integrates_real_validator_and_expected_necessity_findings(self):
        import validate_gitleaks_allowlists as validator

        expected_findings = [
            {
                "Commit": commit,
                "File": path,
                "StartLine": line_number,
                "RuleID": "generic-api-key",
            }
            for commit, path, line_number in validator.EXPECTED_LINE_EXCEPTIONS.values()
        ]
        result = self.run_orchestrator(
            PYTHON_BIN=self.shell_path(pathlib.Path(sys.executable)),
            VALIDATOR_SCRIPT=self.shell_path(
                ROOT / "security" / "validate_gitleaks_allowlists.py"
            ),
            NECESSITY_REPORT_CONTENT=json.dumps(expected_findings),
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(
            self.calls(),
            ["gitleaks-baseline", "gitleaks-necessity"],
        )
        self.assertIn("PASS: baseline redacted report is a valid empty JSON array.", result.stdout)
        self.assertIn("PASS: redacted necessity report contains exactly the 13 expected finding tuples.", result.stdout)
        self.assert_temp_workspace_cleaned()

    def test_baseline_report_cli_rejects_invalid_artifacts(self):
        import validate_gitleaks_allowlists as validator

        config_path = ROOT / ".gitleaks.toml"
        cases = (
            ("missing", None, 2),
            ("empty", "", 2),
            ("malformed", "{not-json", 2),
            ("invalid_utf8", b"\xff", 2),
            ("object", '{"unexpected": true}', 1),
            ("findings", '[{"RuleID": "generic-api-key"}]', 1),
            ("empty_array", "[]", 0),
        )
        original_cwd = pathlib.Path.cwd()
        try:
            os.chdir(ROOT)
            for label, payload, expected in cases:
                with self.subTest(report=label):
                    report_path = self.temp_root / f"{label}.json"
                    report_path.unlink(missing_ok=True)
                    if isinstance(payload, bytes):
                        report_path.write_bytes(payload)
                    elif payload is not None:
                        report_path.write_text(payload, encoding="utf-8")
                    arguments = [
                        "validate_gitleaks_allowlists.py",
                        "--config",
                        str(config_path),
                        "--baseline-report",
                        str(report_path),
                    ]
                    with patch.object(sys, "argv", arguments):
                        with patch.object(validator, "validate_config", return_value=[]):
                            with contextlib.redirect_stdout(io.StringIO()):
                                self.assertEqual(validator.main(), expected)
        finally:
            os.chdir(original_cwd)

    def test_status_two_continuation_mutation_is_detected_by_call_oracle(self):
        source = SCRIPT.read_text(encoding="utf-8")
        safe_guard = 'if [[ "$scan_status" -ne 0 ]]; then'
        unsafe_guard = 'if [[ "$scan_status" -ne 0 && "$scan_status" -ne 2 ]]; then'
        self.assertIn(safe_guard, source)
        mutated = self.temp_root / "mutated-orchestrator.sh"
        mutated.write_text(source.replace(safe_guard, unsafe_guard, 1), encoding="utf-8")
        result = self.run_orchestrator(script_path=mutated, BASELINE_STATUS=2)
        self.assertEqual(result.returncode, 2, result.stderr)
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
        with self.assertRaises(AssertionError):
            self.assertEqual(self.calls(), ["gitleaks-baseline"])
        self.assert_temp_workspace_cleaned()


if __name__ == "__main__":
    unittest.main()
