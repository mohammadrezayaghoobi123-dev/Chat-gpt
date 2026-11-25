"""Hostile tests for fail-closed EGIS gate semantics."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from egis_tla_gate import _rooted_path, run_command, run_gate


class GateTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.jar = self.root / "tools.jar"
        self.jar.write_bytes(b"mock-tla-tools")
        self.module = self.root / "model.tla"
        self.module.write_text("---- MODULE Model ----\\n", encoding="utf-8")
        self.config = self.root / "model.cfg"
        self.config.write_text("SPECIFICATION Spec\nINVARIANT Safety\n", encoding="utf-8")
        self.output = self.root / "evidence.json"
        self.pin = hashlib.sha256(self.jar.read_bytes()).hexdigest()
        self.commit = "a" * 40
        self.identity = {"status": "PASS", "commit": self.commit, "dirty": False}

    def tearDown(self):
        self.temp.cleanup()

    def args(self, **overrides):
        values = dict(root=self.root, jar=self.jar, expected_sha256=self.pin,
                      expected_commit=self.commit, module=self.module,
                      config=self.config, output=self.output)
        values.update(overrides)
        return values

    def mock_pass(self, command, cwd, timeout):
        output = "OK"
        if "tlc2.TLC" in command:
            output = ("Checking 1 invariant...\\n"
                      "Model checking completed. No error has been found.\\n"
                      "  12 states generated, 8 distinct states found, 0 states left on queue.\\n")
        return {"status": "PASS", "exit_code": 0, "stdout": output,
                "stderr": "", "command": list(command)}

    def test_relative_inputs_are_anchored_to_root(self):
        self.assertEqual(self.jar.resolve(), _rooted_path(self.root, Path("tools.jar")))
        self.assertEqual((self.root / "nested" / "model.tla").resolve(),
                         _rooted_path(self.root, Path("nested/model.tla")))

    def test_timeout_bytes_are_normalized_and_json_serializable(self):
        from subprocess import TimeoutExpired
        with patch("egis_tla_gate.subprocess.run",
                   side_effect=TimeoutExpired(["java"], 1, output=b"partial\\xff", stderr=b"timed out")):
            result = run_command(["java"], self.root, 1)
        self.assertEqual("FAIL", result["status"])
        self.assertIn("partial", result["stdout"])
        self.assertEqual("timed out", result["stderr"])
        json.dumps(result)

    def test_hash_mismatch_fails_before_tools(self):
        with patch("egis_tla_gate.git_identity", return_value=self.identity):
            with patch("egis_tla_gate.run_command") as mocked:
                result = run_gate(**self.args(expected_sha256="0" * 64))
        self.assertEqual("FAIL", result["overall"])
        mocked.assert_not_called()

    def test_missing_jar_blocks(self):
        with patch("egis_tla_gate.git_identity", return_value=self.identity):
            result = run_gate(**self.args(jar=self.root / "missing.jar"))
        self.assertEqual("BLOCKED", result["overall"])

    def test_missing_module_blocks(self):
        with patch("egis_tla_gate.git_identity", return_value=self.identity):
            result = run_gate(**self.args(module=self.root / "missing.tla"))
        self.assertEqual("BLOCKED", result["overall"])

    def test_commit_mismatch_fails_before_tool_execution(self):
        bad_identity = {**self.identity, "commit": "b" * 40}
        with patch("egis_tla_gate.git_identity", return_value=bad_identity):
            with patch("egis_tla_gate.run_command") as mocked:
                result = run_gate(**self.args())
        self.assertEqual("FAIL", result["overall"])
        mocked.assert_not_called()

    def test_unavailable_git_metadata_blocks(self):
        unavailable = {"status": "BLOCKED", "commit": None, "dirty": None}
        with patch("egis_tla_gate.git_identity", return_value=unavailable):
            with patch("egis_tla_gate.run_command") as mocked:
                result = run_gate(**self.args())
        self.assertEqual("BLOCKED", result["overall"])
        mocked.assert_not_called()

    def test_dirty_checkout_fails_closed(self):
        dirty_identity = {**self.identity, "status": "FAIL", "dirty": True}
        with patch("egis_tla_gate.git_identity", return_value=dirty_identity):
            result = run_gate(**self.args())
        self.assertEqual("FAIL", result["overall"])

    def test_sany_failure_blocks_tlc(self):
        fake = {"status": "FAIL", "exit_code": 1, "stdout": "",
                "stderr": "parse error", "command": ["sany"]}
        with patch("egis_tla_gate.git_identity", return_value=self.identity):
            with patch("egis_tla_gate.run_command", return_value=fake) as mocked:
                result = run_gate(**self.args())
        self.assertEqual("FAIL", result["overall"])
        self.assertEqual(1, mocked.call_count)
        self.assertEqual("BLOCKED", result["checks"]["tlc"]["status"])

    def test_both_tools_pass_produces_pass_and_digests(self):
        with patch("egis_tla_gate.git_identity", return_value=self.identity):
            with patch("egis_tla_gate.run_command", side_effect=self.mock_pass) as mocked:
                result = run_gate(**self.args())
        self.assertEqual("PASS", result["overall"])
        self.assertEqual(2, mocked.call_count)
        payload = json.loads(self.output.read_text(encoding="utf-8"))
        self.assertEqual("PASS", payload["overall"])
        self.assertEqual(self.pin, payload["scope"]["tool_sha256_actual"])
        self.assertTrue(payload["scope"]["module_sha256"])
        self.assertTrue(payload["scope"]["config_sha256"])
        self.assertEqual(self.commit, payload["checks"]["source_identity"]["commit"])

    def test_tlc_failure_not_pass(self):
        calls = [self.mock_pass(["sany"], self.root, 10),
                  {"status": "FAIL", "exit_code": 1, "stdout": "",
                   "stderr": "invariant violated", "command": ["tlc"]}]
        with patch("egis_tla_gate.git_identity", return_value=self.identity):
            with patch("egis_tla_gate.run_command", side_effect=calls):
                result = run_gate(**self.args())
        self.assertEqual("FAIL", result["overall"])

    def test_timeout_is_fail(self):
        calls = [self.mock_pass(["sany"], self.root, 10),
                  {"status": "FAIL", "exit_code": None, "stdout": "",
                   "stderr": "timeout", "command": ["tlc"]}]
        with patch("egis_tla_gate.git_identity", return_value=self.identity):
            with patch("egis_tla_gate.run_command", side_effect=calls):
                result = run_gate(**self.args())
        self.assertEqual("FAIL", result["overall"])

    def test_evidence_is_written_atomically(self):
        with patch("egis_tla_gate.git_identity", return_value=self.identity):
            with patch("egis_tla_gate.run_command", side_effect=self.mock_pass):
                result = run_gate(**self.args())
        self.assertEqual("PASS", result["overall"])
        self.assertTrue(self.output.is_file())
        self.assertFalse(any(p.name.startswith("tmp") for p in self.root.iterdir()))

    def test_missing_inputs_never_pass(self):
        with patch("egis_tla_gate.git_identity", return_value=self.identity):
            result = run_gate(**self.args(module=self.root / "missing.tla"))
        self.assertEqual("BLOCKED", result["overall"])
        self.assertEqual("BLOCKED", json.loads(self.output.read_text())["overall"])


if __name__ == "__main__":
    unittest.main(verbosity=2)


class TlcOutputValidatorTests(unittest.TestCase):
    def test_complete_success_requires_summary_and_expected_invariant_count(self):
        from egis_tlc_output_validator import validate_tlc_output
        output = """Checking 1 invariant...
Model checking completed. No error has been found.
  12 states generated, 8 distinct states found, 0 states left on queue.
"""
        result = validate_tlc_output(output, ["Safety"], exit_code=0)
        self.assertEqual("PASS", result["status"])
        self.assertEqual(8, result["distinct_states"])
        self.assertEqual(["Safety"], result["expected_invariants"])

    def test_zero_exit_without_completion_summary_is_not_pass(self):
        from egis_tlc_output_validator import validate_tlc_output
        result = validate_tlc_output("TLC started successfully", ["Safety"], exit_code=0)
        self.assertNotEqual("PASS", result["status"])

    def test_missing_invariant_check_is_not_pass(self):
        from egis_tlc_output_validator import validate_tlc_output
        output = """Model checking completed. No error has been found.
  12 states generated, 8 distinct states found, 0 states left on queue.
"""
        result = validate_tlc_output(output, ["Safety"], exit_code=0)
        self.assertNotEqual("PASS", result["status"])

    def test_invariant_count_mismatch_is_not_pass(self):
        from egis_tlc_output_validator import validate_tlc_output
        output = """Checking 0 invariants...
Model checking completed. No error has been found.
  12 states generated, 8 distinct states found, 0 states left on queue.
"""
        result = validate_tlc_output(output, ["Safety"], exit_code=0)
        self.assertEqual("FAIL", result["status"])

    def test_error_or_violation_marker_overrides_success_summary(self):
        from egis_tlc_output_validator import validate_tlc_output
        output = """Checking 1 invariant...
Error: Invariant Safety is violated.
Model checking completed. No error has been found.
  12 states generated, 8 distinct states found, 0 states left on queue.
"""
        result = validate_tlc_output(output, ["Safety"], exit_code=0)
        self.assertEqual("FAIL", result["status"])

    def test_nonzero_exit_and_timeout_never_pass(self):
        from egis_tlc_output_validator import validate_tlc_output
        output = """Checking 1 invariant...
Model checking completed. No error has been found.
  12 states generated, 8 distinct states found, 0 states left on queue.
"""
        self.assertEqual("FAIL", validate_tlc_output(output, ["Safety"], exit_code=2)["status"])
        self.assertEqual("FAIL", validate_tlc_output(output, ["Safety"], exit_code=0, timed_out=True)["status"])

    def test_malformed_or_inconsistent_state_counts_never_pass(self):
        from egis_tlc_output_validator import validate_tlc_output
        malformed = """Checking 1 invariant...
Model checking completed. No error has been found.
  8 states generated, 12 distinct states found, 0 states left on queue.
"""
        self.assertNotEqual("PASS", validate_tlc_output(malformed, ["Safety"], exit_code=0)["status"])
