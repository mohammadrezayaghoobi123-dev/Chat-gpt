"""Hostile tests for the EGIS TLA gate fail-closed semantics."""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from egis_tla_gate import run_gate


class GateTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.jar = self.root / "tools.jar"
        self.jar.write_bytes(b"mock-tla-tools")
        self.module = self.root / "model.tla"
        self.module.write_text("---- MODULE Model ----\n", encoding="utf-8")
        self.config = self.root / "model.cfg"
        self.config.write_text("SPECIFICATION Spec\n", encoding="utf-8")
        self.output = self.root / "evidence.json"
        self.pin = hashlib.sha256(self.jar.read_bytes()).hexdigest()

    def tearDown(self):
        self.temp.cleanup()

    def mock_pass(self, command, cwd, timeout):
        return {"status": "PASS", "exit_code": 0, "stdout": "OK",
                "stderr": "", "command": list(command)}

    def test_hash_mismatch_fails_before_execution(self):
        with patch("egis_tla_gate.run_command") as mocked:
            result = run_gate(self.root, self.jar, "0" * 64,
                              self.module, self.config, self.output)
        self.assertEqual("FAIL", result["overall"])
        mocked.assert_not_called()

    def test_missing_jar_blocks(self):
        result = run_gate(self.root, self.root / "missing.jar", self.pin,
                          self.module, self.config, self.output)
        self.assertEqual("BLOCKED", result["overall"])

    def test_missing_module_blocks(self):
        result = run_gate(self.root, self.jar, self.pin,
                          self.root / "missing.tla", self.config, self.output)
        self.assertEqual("BLOCKED", result["overall"])

    def test_sany_failure_blocks_tlc(self):
        def fake(command, cwd, timeout):
            return {"status": "FAIL", "exit_code": 1, "stdout": "",
                    "stderr": "parse error", "command": list(command)}
        with patch("egis_tla_gate.run_command", side_effect=fake) as mocked:
            result = run_gate(self.root, self.jar, self.pin,
                              self.module, self.config, self.output)
        self.assertEqual("FAIL", result["overall"])
        self.assertEqual(1, mocked.call_count)
        self.assertEqual("BLOCKED", result["checks"]["tlc"]["status"])

    def test_sany_blocked_does_not_run_tlc(self):
        with patch("egis_tla_gate.run_command", return_value={
            "status": "BLOCKED", "exit_code": None, "stdout": "",
            "stderr": "java not found", "command": ["java"]}) as mocked:
            result = run_gate(self.root, self.jar, self.pin,
                              self.module, self.config, self.output)
        self.assertEqual("BLOCKED", result["overall"])
        mocked.assert_called_once()

    def test_both_tools_pass_produces_pass(self):
        with patch("egis_tla_gate.run_command", side_effect=self.mock_pass) as mocked:
            result = run_gate(self.root, self.jar, self.pin,
                              self.module, self.config, self.output)
        self.assertEqual("PASS", result["overall"])
        self.assertEqual(2, mocked.call_count)
        payload = json.loads(self.output.read_text(encoding="utf-8"))
        self.assertEqual("PASS", payload["overall"])
        self.assertEqual(self.pin, payload["scope"]["tool_sha256_actual"])

    def test_tlc_failure_is_not_pass(self):
        calls = [
            self.mock_pass(["sany"], self.root, 100),
            {"status": "FAIL", "exit_code": 1, "stdout": "",
             "stderr": "invariant violated", "command": ["tlc"]}
        ]
        with patch("egis_tla_gate.run_command", side_effect=calls):
            result = run_gate(self.root, self.jar, self.pin,
                              self.module, self.config, self.output)
        self.assertEqual("FAIL", result["overall"])

    def test_timeout_is_fail(self):
        calls = [
            self.mock_pass(["sany"], self.root, 100),
            {"status": "FAIL", "exit_code": None, "stdout": "",
             "stderr": "timeout", "command": ["tlc"]}
        ]
        with patch("egis_tla_gate.run_command", side_effect=calls):
            result = run_gate(self.root, self.jar, self.pin,
                              self.module, self.config, self.output)
        self.assertEqual("FAIL", result["overall"])

    def test_evidence_write_is_atomic_replace(self):
        with patch("egis_tla_gate.run_command", side_effect=self.mock_pass):
            result = run_gate(self.root, self.jar, self.pin,
                              self.module, self.config, self.output)
        self.assertEqual("PASS", result["overall"])
        self.assertTrue(self.output.is_file())
        self.assertFalse(any(p.name.startswith("tmp") for p in self.root.iterdir()))

    def test_result_has_no_success_when_gate_is_blocked(self):
        result = run_gate(self.root, self.jar, self.pin,
                          self.root / "missing.tla", self.config, self.output)
        self.assertNotEqual("PASS", result["overall"])
        self.assertEqual("BLOCKED", json.loads(self.output.read_text())["overall"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
