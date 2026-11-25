"""Hostile tests for fail-closed EGIS gate semantics."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import MagicMock, patch

from egis_tla_gate import _rooted_path, _snapshot_file, git_identity, run_command, run_gate


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

    def command_result(self, *, status, process_outcome, process_started,
                       reason=None, exit_code=None, stdout="", stderr=""):
        return {
            "status": status,
            "exit_code": exit_code,
            "stdout": stdout,
            "stderr": stderr,
            "command": ["java"],
            "reason": reason,
            "phase": "spawn" if not process_started else "communicate",
            "error_type": None,
            "errno": None,
            "process_started": process_started,
            "process_outcome": process_outcome,
            "process_cleanup": "NOT_STARTED" if not process_started else "UNKNOWN",
        }

    def mock_pass(self, command, cwd, timeout):
        output = "OK"
        if "tlc2.TLC" in command:
            output = ("Checking 1 invariant...\\n"
                      "Model checking completed. No error has been found.\\n"
                      "  12 states generated, 8 distinct states found, 0 states left on queue.\\n")
        return {"status": "PASS", "exit_code": 0, "stdout": output,
                "stderr": "", "command": list(command),
                "reason": None, "phase": None, "error_type": None, "errno": None,
                "process_started": True, "process_outcome": "EXIT_ZERO",
                "process_cleanup": "REAPED"}

    def test_relative_inputs_are_anchored_to_root(self):
        self.assertEqual(self.jar.resolve(), _rooted_path(self.root, Path("tools.jar")))
        self.assertEqual((self.root / "nested" / "model.tla").resolve(),
                         _rooted_path(self.root, Path("nested/model.tla")))

    def test_timeout_bytes_are_normalized_and_json_serializable(self):
        from subprocess import TimeoutExpired
        process = MagicMock()
        process.__enter__.return_value = process
        process.__exit__.return_value = False
        process.returncode = -9
        process.poll.return_value = -9
        process.communicate.side_effect = [
            TimeoutExpired(["java"], 1, output=b"partial\\xff", stderr=b"timed out"),
            (b"partial\\xff", b"timed out"),
        ]
        process.wait.return_value = -9
        process.stdout = MagicMock()
        process.stderr = MagicMock()
        with patch("egis_tla_gate.subprocess.Popen", return_value=process):
            result = run_command(["java"], self.root, 1)
        self.assertEqual("FAIL", result["status"])
        self.assertEqual("process_timed_out", result["reason"])
        self.assertEqual("communicate", result["phase"])
        self.assertTrue(result["process_started"])
        self.assertEqual("TIMED_OUT", result["process_outcome"])
        self.assertEqual("REAPED", result["process_cleanup"])
        self.assertIn("partial", result["stdout"])
        self.assertEqual("timed out", result["stderr"])
        process.kill.assert_called_once()
        process.stdout.close.assert_called_once()
        process.stderr.close.assert_called_once()
        json.dumps(result)

    def _mock_process(self, returncode=0):
        process = MagicMock()
        process.__enter__.return_value = process
        process.__exit__.return_value = False
        process.returncode = returncode
        process.poll.return_value = returncode
        process.wait.return_value = returncode
        process.communicate.return_value = (b"", b"")
        return process

    def test_missing_executable_has_structured_blocked_result(self):
        error = FileNotFoundError(2, "not found", "/private/tool/java")
        with patch("egis_tla_gate.subprocess.Popen", side_effect=error):
            result = run_command(["/private/tool/java"], self.root, 1)
        self.assertEqual("BLOCKED", result["status"])
        self.assertEqual("process_executable_missing", result["reason"])
        self.assertEqual("spawn", result["phase"])
        self.assertEqual("FileNotFoundError", result["error_type"])
        self.assertEqual(2, result["errno"])
        self.assertFalse(result["process_started"])
        self.assertEqual("NOT_STARTED", result["process_outcome"])
        self.assertEqual("NOT_STARTED", result["process_cleanup"])
        self.assertNotIn("/private/tool/java", result["stderr"])
        json.dumps(result)

    def test_permission_error_at_process_start_is_blocked_and_redacted(self):
        error = PermissionError(13, "permission denied", "/private/secret/java")
        with patch("egis_tla_gate.subprocess.Popen", side_effect=error):
            result = run_command(["/private/secret/java"], self.root, 1)
        self.assertEqual("BLOCKED", result["status"])
        self.assertEqual("process_start_unavailable", result["reason"])
        self.assertEqual("spawn", result["phase"])
        self.assertEqual("PermissionError", result["error_type"])
        self.assertEqual(13, result["errno"])
        self.assertFalse(result["process_started"])
        self.assertEqual("NOT_STARTED", result["process_outcome"])
        self.assertNotIn("/private/secret/java", result["stderr"])
        json.dumps(result)

    def test_generic_oserror_without_errno_at_process_start_is_blocked(self):
        error = OSError("simulated process creation failure")
        with patch("egis_tla_gate.subprocess.Popen", side_effect=error):
            result = run_command(["java"], self.root, 1)
        self.assertEqual("BLOCKED", result["status"])
        self.assertEqual("process_start_unavailable", result["reason"])
        self.assertEqual("OSError", result["error_type"])
        self.assertIsNone(result["errno"])
        self.assertFalse(result["process_started"])
        self.assertEqual("NOT_STARTED", result["process_outcome"])
        json.dumps(result)

    def test_communication_oserror_after_spawn_is_blocked_with_unknown_outcome(self):
        import errno

        process = self._mock_process(returncode=-9)
        process.stdout = MagicMock()
        process.stderr = MagicMock()
        process.communicate.side_effect = OSError(errno.EIO, "pipe failed", "/private/pipe")
        with patch("egis_tla_gate.subprocess.Popen", return_value=process):
            result = run_command(["java"], self.root, 1)
        self.assertEqual("BLOCKED", result["status"])
        self.assertEqual("process_result_unavailable", result["reason"])
        self.assertEqual("communicate", result["phase"])
        self.assertTrue(result["process_started"])
        self.assertEqual("UNKNOWN", result["process_outcome"])
        self.assertEqual("REAPED", result["process_cleanup"])
        self.assertNotIn("/private/pipe", result["stderr"])
        process.kill.assert_called_once()
        process.wait.assert_called_once()
        process.stdout.close.assert_called_once()
        process.stderr.close.assert_called_once()
        json.dumps(result)

    def test_pipe_close_oserror_keeps_process_cleanup_unknown(self):
        import errno

        process = self._mock_process(returncode=-9)
        process.stdout = MagicMock()
        process.stderr = MagicMock()
        process.stdout.close.side_effect = OSError(errno.EIO, "close failed", "/private/stdout")
        process.communicate.side_effect = OSError(errno.EIO, "pipe failed", "/private/pipe")
        with patch("egis_tla_gate.subprocess.Popen", return_value=process):
            result = run_command(["java"], self.root, 1)
        self.assertEqual("BLOCKED", result["status"])
        self.assertEqual("UNKNOWN", result["process_cleanup"])
        self.assertEqual("UNKNOWN", result["process_outcome"])
        process.kill.assert_called_once()
        process.wait.assert_called_once()
        process.stdout.close.assert_called_once()
        process.stderr.close.assert_called_once()
        self.assertNotIn("/private/stdout", result["stderr"])
        self.assertNotIn("/private/pipe", result["stderr"])
        json.dumps(result)

    def test_communication_error_with_unconfirmed_reap_remains_unknown(self):
        from subprocess import TimeoutExpired

        process = self._mock_process(returncode=None)
        process.communicate.side_effect = OSError("pipe failure")
        process.wait.side_effect = TimeoutExpired(["java"], 5)
        process.poll.return_value = None
        with patch("egis_tla_gate.subprocess.Popen", return_value=process):
            result = run_command(["java"], self.root, 1)
        self.assertEqual("BLOCKED", result["status"])
        self.assertTrue(result["process_started"])
        self.assertEqual("UNKNOWN", result["process_outcome"])
        self.assertEqual("UNKNOWN", result["process_cleanup"])
        process.kill.assert_called_once()
        json.dumps(result)

    def test_started_process_nonzero_exit_remains_fail(self):
        process = self._mock_process(returncode=7)
        process.communicate.return_value = (b"", b"tool failure")
        with patch("egis_tla_gate.subprocess.Popen", return_value=process):
            result = run_command(["java"], self.root, 1)
        self.assertEqual("FAIL", result["status"])
        self.assertEqual(7, result["exit_code"])
        self.assertEqual("process_nonzero_exit", result["reason"])
        self.assertTrue(result["process_started"])
        self.assertEqual("EXIT_NONZERO", result["process_outcome"])
        self.assertEqual("REAPED", result["process_cleanup"])

    def test_started_process_success_is_pass_and_json_serializable(self):
        process = self._mock_process(returncode=0)
        process.communicate.return_value = ("stdout", "stderr")
        with patch("egis_tla_gate.subprocess.Popen", return_value=process):
            result = run_command(["java"], self.root, 1)
        self.assertEqual("PASS", result["status"])
        self.assertEqual(0, result["exit_code"])
        self.assertEqual("stdout", result["stdout"])
        self.assertEqual("stderr", result["stderr"])
        self.assertTrue(result["process_started"])
        self.assertEqual("EXIT_ZERO", result["process_outcome"])
        self.assertEqual("REAPED", result["process_cleanup"])
        json.dumps(result)

    def test_real_child_process_captures_stdout_and_stderr(self):
        import sys

        result = run_command(
            [sys.executable, "-c",
             "import sys; sys.stdout.write('child-out'); sys.stderr.write('child-err')"],
            self.root,
            5,
        )
        self.assertEqual("PASS", result["status"])
        self.assertEqual("child-out", result["stdout"])
        self.assertEqual("child-err", result["stderr"])
        self.assertTrue(result["process_started"])
        self.assertEqual("EXIT_ZERO", result["process_outcome"])
        self.assertEqual("REAPED", result["process_cleanup"])

    def test_real_timeout_kills_and_reaps_child_and_closes_pipes(self):
        import gc
        import sys
        import time
        import warnings

        started = time.monotonic()
        with warnings.catch_warnings(record=True) as captured:
            warnings.simplefilter("always", ResourceWarning)
            result = run_command(
                [sys.executable, "-c", "import time; time.sleep(20)"],
                self.root,
                0.1,
            )
            gc.collect()
        elapsed = time.monotonic() - started
        resource_warnings = [
            warning for warning in captured
            if issubclass(warning.category, ResourceWarning)
        ]
        self.assertEqual("FAIL", result["status"])
        self.assertEqual("process_timed_out", result["reason"])
        self.assertEqual("TIMED_OUT", result["process_outcome"])
        self.assertEqual("REAPED", result["process_cleanup"])
        self.assertEqual([], resource_warnings)
        self.assertLess(elapsed, 5.0)

    def test_process_control_and_programming_exceptions_are_not_swallowed(self):
        for exception in (KeyboardInterrupt(), SystemExit(9), RuntimeError("bug")):
            with self.subTest(exception=type(exception).__name__):
                with patch("egis_tla_gate.subprocess.Popen", side_effect=exception):
                    with self.assertRaises(type(exception)):
                        run_command(["java"], self.root, 1)

    def _run_gate_with_preflight_mocks(self, **overrides):
        with patch("egis_tla_gate.git_identity", return_value=self.identity) as git_identity_mock:
            with patch("egis_tla_gate.run_command", side_effect=self.mock_pass) as command_mock:
                result = run_gate(**self.args(**overrides))
        return result, git_identity_mock, command_mock

    def _run_gate_without_preflight_exception(self, **overrides):
        try:
            return self._run_gate_with_preflight_mocks(**overrides)
        except Exception as exc:
            self.fail(f"run_gate leaked an input-preflight exception: {type(exc).__name__}")

    def test_b1a_records_sha256_and_filesystem_identity_for_all_inputs(self):
        result, git_mock, command_mock = self._run_gate_with_preflight_mocks()
        self.assertIn("inputs", result["checks"])
        self.assertIn("input_snapshots", result["scope"])
        self.assertEqual("PASS", result["checks"]["inputs"]["status"])
        snapshots = result["scope"]["input_snapshots"]
        expected = {
            "module": self.module,
            "config": self.config,
            "tool_jar": self.jar,
        }
        for role, path in expected.items():
            with self.subTest(role=role):
                snapshot = snapshots[role]
                self.assertEqual(str(path.resolve()), snapshot["canonical_path"])
                self.assertEqual(hashlib.sha256(path.read_bytes()).hexdigest(), snapshot["sha256"])
                identity = snapshot["identity"]
                self.assertGreater(identity["device"], 0)
                self.assertGreater(identity["inode"], 0)
                self.assertEqual(path.stat().st_size, identity["size"])
                self.assertIn("mtime_ns", identity)
                self.assertIn("ctime_ns", identity)
        self.assertEqual(result["scope"]["module_sha256"], snapshots["module"]["sha256"])
        self.assertEqual(result["scope"]["config_sha256"], snapshots["config"]["sha256"])
        self.assertEqual(result["scope"]["tool_sha256_actual"], snapshots["tool_jar"]["sha256"])
        git_mock.assert_called_once()
        self.assertEqual(2, command_mock.call_count)

    def test_b1a_accepts_external_jar_and_records_its_canonical_identity(self):
        import shutil

        external_dir = Path(tempfile.mkdtemp(prefix="egis-external-jar-"))
        try:
            external_jar = external_dir / "approved-tools.jar"
            external_jar.write_bytes(b"external-approved-tools")
            pin = hashlib.sha256(external_jar.read_bytes()).hexdigest()
            result, git_mock, command_mock = self._run_gate_with_preflight_mocks(
                jar=external_jar,
                expected_sha256=pin,
            )
            self.assertIn("inputs", result["checks"])
            self.assertIn("input_snapshots", result["scope"])
            self.assertEqual("PASS", result["checks"]["inputs"]["status"])
            self.assertEqual(str(external_jar.resolve()),
                             result["scope"]["input_snapshots"]["tool_jar"]["canonical_path"])
            self.assertEqual(pin, result["scope"]["input_snapshots"]["tool_jar"]["sha256"])
            git_mock.assert_called_once()
            self.assertEqual(2, command_mock.call_count)
        finally:
            shutil.rmtree(external_dir)

    def test_b1a_non_directory_repository_root_blocks_before_commands(self):
        file_root = self.root / "not-a-directory"
        file_root.write_text("not a directory", encoding="utf-8")
        result, git_mock, command_mock = self._run_gate_with_preflight_mocks(root=file_root)
        self.assertEqual("BLOCKED", result["overall"])
        self.assertEqual("BLOCKED", result["checks"]["inputs"]["status"])
        self.assertEqual("repository_root_unavailable", result["checks"]["inputs"]["reason"])
        git_mock.assert_not_called()
        command_mock.assert_not_called()

    def test_b1a_missing_repository_root_blocks_before_commands(self):
        missing_root = self.root / "missing-root"
        result, git_mock, command_mock = self._run_gate_with_preflight_mocks(root=missing_root)
        self.assertEqual("BLOCKED", result["overall"])
        self.assertEqual("repository_root_unavailable", result["checks"]["inputs"]["reason"])
        git_mock.assert_not_called()
        command_mock.assert_not_called()

    def test_b1a_missing_config_is_classified_as_input_missing(self):
        missing = self.root / "missing.cfg"
        result, git_mock, command_mock = self._run_gate_with_preflight_mocks(config=missing)
        self.assertEqual("BLOCKED", result["overall"])
        self.assertEqual("BLOCKED", result["checks"]["inputs"]["status"])
        self.assertEqual("input_missing", result["checks"]["inputs"]["reason"])
        self.assertEqual("config", result["checks"]["inputs"]["role"])
        git_mock.assert_not_called()
        command_mock.assert_not_called()

    def test_b1a_rejects_module_symlink_escaping_repository_root(self):
        import os

        outside_dir = Path(tempfile.mkdtemp(prefix="egis-outside-root-"))
        try:
            outside_module = outside_dir / "outside.tla"
            outside_module.write_text("---- MODULE Outside ----\n", encoding="utf-8")
            escaped = self.root / "escaped.tla"
            try:
                os.symlink(outside_module, escaped)
            except (OSError, NotImplementedError) as exc:
                self.skipTest(f"symlink creation unavailable on this runner: {type(exc).__name__}")
            result, git_mock, command_mock = self._run_gate_with_preflight_mocks(module=escaped)
            self.assertEqual("BLOCKED", result["overall"])
            self.assertEqual("repository_input_path_escape", result["checks"]["inputs"]["reason"])
            self.assertEqual("module", result["checks"]["inputs"]["role"])
            git_mock.assert_not_called()
            command_mock.assert_not_called()
        finally:
            import shutil
            shutil.rmtree(outside_dir)

    def test_b1a_detects_persistent_symlink_target_change_during_snapshot(self):
        import os
        import shutil

        outside_dir = Path(tempfile.mkdtemp(prefix="egis-snapshot-target-"))
        try:
            outside = outside_dir / "external.tla"
            outside.write_text("---- MODULE External ----\n", encoding="utf-8")
            link = self.root / "model-link.tla"
            try:
                os.symlink(self.module, link)
            except (OSError, NotImplementedError) as exc:
                self.skipTest(f"symlink creation unavailable: {type(exc).__name__}")
            expected_canonical = str(self.module.resolve())
            altered_canonical = str(outside.resolve())
            original_resolve = Path.resolve
            def changed_resolve(path, *args, **kwargs):
                if path == link:
                    return Path(altered_canonical)
                return original_resolve(path, *args, **kwargs)
            with patch.object(Path, "resolve", new=changed_resolve):
                result = _snapshot_file(link, "module", expected_canonical)
            self.assertEqual("FAIL", result["status"])
            self.assertEqual("input_changed_during_read", result["reason"])
        finally:
            shutil.rmtree(outside_dir)

    def test_b1a_rejects_config_symlink_escaping_repository_root(self):
        import os
        import shutil

        outside_dir = Path(tempfile.mkdtemp(prefix="egis-outside-config-"))
        try:
            outside_config = outside_dir / "outside.cfg"
            outside_config.write_text("SPECIFICATION Spec\n", encoding="utf-8")
            escaped = self.root / "escaped.cfg"
            try:
                os.symlink(outside_config, escaped)
            except (OSError, NotImplementedError) as exc:
                self.skipTest(f"symlink creation unavailable: {type(exc).__name__}")
            result, git_mock, command_mock = self._run_gate_with_preflight_mocks(config=escaped)
            self.assertEqual("BLOCKED", result["overall"])
            self.assertEqual("repository_input_path_escape", result["checks"]["inputs"]["reason"])
            self.assertEqual("config", result["checks"]["inputs"]["role"])
            git_mock.assert_not_called()
            command_mock.assert_not_called()
        finally:
            shutil.rmtree(outside_dir)

    def test_b1a_missing_jar_blocks_without_git_or_java(self):
        missing_jar = self.root / "missing-tools.jar"
        result, git_mock, command_mock = self._run_gate_with_preflight_mocks(jar=missing_jar)
        self.assertEqual("BLOCKED", result["overall"])
        self.assertEqual("input_missing", result["checks"]["inputs"]["reason"])
        self.assertEqual("tool_jar", result["checks"]["inputs"]["role"])
        git_mock.assert_not_called()
        command_mock.assert_not_called()

    def test_b1a_rejects_non_regular_required_input(self):
        directory = self.root / "module-directory"
        directory.mkdir()
        result, git_mock, command_mock = self._run_gate_with_preflight_mocks(module=directory)
        self.assertEqual("BLOCKED", result["overall"])
        self.assertEqual("input_not_regular", result["checks"]["inputs"]["reason"])
        self.assertEqual("module", result["checks"]["inputs"]["role"])
        git_mock.assert_not_called()
        command_mock.assert_not_called()

    def test_b1a_stat_io_errors_are_not_reclassified_as_missing(self):
        original_stat = Path.stat
        for role in ("module", "config", "tool_jar"):
            with self.subTest(role=role):
                target = {"module": self.module, "config": self.config,
                          "tool_jar": self.jar}[role]
                def denied_stat(path, *args, **kwargs):
                    if path == target:
                        raise PermissionError(13, "permission denied", str(path))
                    return original_stat(path, *args, **kwargs)
                with patch.object(Path, "stat", new=denied_stat):
                    result, git_mock, command_mock = self._run_gate_without_preflight_exception(
                        **{role if role != "tool_jar" else "jar": target}
                    )
                self.assertEqual("BLOCKED", result["overall"])
                self.assertEqual("input_io_unavailable", result["checks"]["inputs"]["reason"])
                self.assertEqual(role, result["checks"]["inputs"]["role"])
                self.assertEqual("PermissionError", result["checks"]["inputs"]["error_type"])
                git_mock.assert_not_called()
                command_mock.assert_not_called()

    def test_b1a_open_io_errors_are_blocked_with_structured_evidence(self):
        original_open = Path.open
        for role in ("module", "config", "tool_jar"):
            with self.subTest(role=role):
                target = {"module": self.module, "config": self.config,
                          "tool_jar": self.jar}[role]
                def denied_open(path, *args, **kwargs):
                    if path == target:
                        raise OSError(5, "read failed", str(path))
                    return original_open(path, *args, **kwargs)
                with patch.object(Path, "open", new=denied_open):
                    result, git_mock, command_mock = self._run_gate_without_preflight_exception(
                        **{role if role != "tool_jar" else "jar": target}
                    )
                self.assertEqual("BLOCKED", result["overall"])
                self.assertEqual("input_io_unavailable", result["checks"]["inputs"]["reason"])
                self.assertEqual(role, result["checks"]["inputs"]["role"])
                self.assertEqual("OSError", result["checks"]["inputs"]["error_type"])
                self.assertEqual(5, result["checks"]["inputs"]["errno"])
                self.assertTrue(self.output.is_file())
                git_mock.assert_not_called()
                command_mock.assert_not_called()

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

    def test_run_gate_stops_before_java_and_persists_git_unknown_state(self):
        blocked_rev_parse = self.command_result(
            status="BLOCKED", process_outcome="UNKNOWN",
            process_started=True, reason="process_result_unavailable",
        )
        with patch("egis_tla_gate.run_command", return_value=blocked_rev_parse) as mocked:
            result = run_gate(**self.args())
        self.assertEqual("BLOCKED", result["overall"])
        identity = result["checks"]["source_identity"]
        self.assertEqual("BLOCKED", identity["status"])
        self.assertEqual("UNKNOWN", identity["commands"]["rev_parse"]["process_outcome"])
        self.assertEqual("NOT_RUN", identity["commands"]["status"]["status"])
        self.assertEqual("NOT_STARTED", identity["commands"]["status"]["process_outcome"])
        self.assertNotIn("sany", result["checks"])
        self.assertNotIn("tlc", result["checks"])
        mocked.assert_called_once()
        persisted = json.loads(self.output.read_text(encoding="utf-8"))
        self.assertEqual("UNKNOWN", persisted["checks"]["source_identity"]["commands"]["rev_parse"]["process_outcome"])

    def test_unavailable_git_metadata_blocks(self):
        unavailable = {"status": "BLOCKED", "commit": None, "dirty": None}
        with patch("egis_tla_gate.git_identity", return_value=unavailable):
            with patch("egis_tla_gate.run_command") as mocked:
                result = run_gate(**self.args())
        self.assertEqual("BLOCKED", result["overall"])
        mocked.assert_not_called()

    def test_git_identity_short_circuits_after_process_start_failure(self):
        blocked = self.command_result(
            status="BLOCKED", process_outcome="NOT_STARTED",
            process_started=False, reason="process_start_unavailable",
        )
        with patch("egis_tla_gate.run_command", side_effect=[blocked, blocked]) as mocked:
            identity = git_identity(self.root)
        self.assertEqual("BLOCKED", identity["status"])
        self.assertEqual("NOT_STARTED", identity["commands"]["rev_parse"]["process_outcome"])
        self.assertEqual("NOT_RUN", identity["commands"]["status"]["status"])
        mocked.assert_called_once()

    def test_git_identity_preserves_unknown_after_rev_parse_started(self):
        blocked = self.command_result(
            status="BLOCKED", process_outcome="UNKNOWN",
            process_started=True, reason="process_result_unavailable",
        )
        with patch("egis_tla_gate.run_command", side_effect=[blocked, self.mock_pass(["git"], self.root, 10)]) as mocked:
            identity = git_identity(self.root)
        self.assertEqual("BLOCKED", identity["status"])
        self.assertEqual("UNKNOWN", identity["commands"]["rev_parse"]["process_outcome"])
        self.assertEqual("NOT_RUN", identity["commands"]["status"]["status"])
        mocked.assert_called_once()

    def test_git_identity_blocks_when_rev_parse_exit_zero_but_cleanup_unknown(self):
        incomplete = self.command_result(
            status="PASS", process_outcome="EXIT_ZERO",
            process_started=True, exit_code=0,
        )
        with patch("egis_tla_gate.run_command", return_value=incomplete) as mocked:
            identity = git_identity(self.root)
        self.assertEqual("BLOCKED", identity["status"])
        self.assertEqual("UNKNOWN", identity["commands"]["rev_parse"]["process_cleanup"])
        self.assertEqual("NOT_RUN", identity["commands"]["status"]["status"])
        mocked.assert_called_once()

    def test_sany_pass_with_unknown_cleanup_does_not_start_tlc(self):
        incomplete_sany = self.command_result(
            status="PASS", process_outcome="EXIT_ZERO",
            process_started=True, exit_code=0,
        )
        with patch("egis_tla_gate.git_identity", return_value=self.identity):
            with patch("egis_tla_gate.run_command", return_value=incomplete_sany) as mocked:
                result = run_gate(**self.args())
        self.assertEqual("BLOCKED", result["overall"])
        self.assertEqual("PASS", result["checks"]["sany"]["status"])
        self.assertEqual("UNKNOWN", result["checks"]["sany"]["process_cleanup"])
        self.assertEqual("BLOCKED", result["checks"]["tlc"]["status"])
        self.assertEqual("NOT_STARTED", result["checks"]["tlc"]["process_outcome"])
        mocked.assert_called_once()

    def test_tlc_pass_with_unknown_cleanup_never_invokes_validator(self):
        sany = self.mock_pass(["sany"], self.root, 10)
        incomplete_tlc = self.command_result(
            status="PASS", process_outcome="EXIT_ZERO",
            process_started=True, exit_code=0,
        )
        with patch("egis_tla_gate.git_identity", return_value=self.identity):
            with patch("egis_tla_gate.run_command", side_effect=[sany, incomplete_tlc]) as mocked:
                with patch("egis_tla_gate.validate_tlc_output", return_value={"status": "BLOCKED", "reason": "unexpected_validator_call"}) as validator:
                    result = run_gate(**self.args())
        self.assertEqual("BLOCKED", result["overall"])
        self.assertEqual("PASS", result["checks"]["tlc"]["status"])
        self.assertEqual("UNKNOWN", result["checks"]["tlc"]["process_cleanup"])
        self.assertEqual("NOT_RUN", result["checks"]["tlc_output_validation"]["status"])
        self.assertEqual("tlc_result_unavailable", result["checks"]["tlc_output_validation"]["reason"])
        validator.assert_not_called()
        self.assertEqual(2, mocked.call_count)

    def test_git_identity_preserves_unknown_after_status_started(self):
        commit_result = {
            **self.command_result(status="PASS", process_outcome="EXIT_ZERO",
                                  process_started=True, exit_code=0),
            "stdout": self.commit + "\n",
            "process_cleanup": "REAPED",
        }
        blocked = self.command_result(
            status="BLOCKED", process_outcome="UNKNOWN",
            process_started=True, reason="process_result_unavailable",
        )
        with patch("egis_tla_gate.run_command", side_effect=[commit_result, blocked]):
            identity = git_identity(self.root)
        self.assertEqual("BLOCKED", identity["status"])
        self.assertEqual(self.commit, identity["commit"])
        self.assertIsNone(identity["dirty"])
        self.assertEqual("EXIT_ZERO", identity["commands"]["rev_parse"]["process_outcome"])
        self.assertEqual("UNKNOWN", identity["commands"]["status"]["process_outcome"])

    def test_sany_blocked_not_started_blocks_tlc_with_not_started_metadata(self):
        sany = self.command_result(
            status="BLOCKED", process_outcome="NOT_STARTED",
            process_started=False, reason="process_executable_missing",
        )
        with patch("egis_tla_gate.git_identity", return_value=self.identity):
            with patch("egis_tla_gate.run_command", return_value=sany) as mocked:
                result = run_gate(**self.args())
        self.assertEqual("BLOCKED", result["overall"])
        self.assertEqual("NOT_STARTED", result["checks"]["sany"]["process_outcome"])
        self.assertEqual("BLOCKED", result["checks"]["tlc"]["status"])
        self.assertEqual("SANY_not_passed", result["checks"]["tlc"]["reason"])
        self.assertFalse(result["checks"]["tlc"]["process_started"])
        self.assertEqual("NOT_STARTED", result["checks"]["tlc"]["process_outcome"])
        mocked.assert_called_once()

    def test_sany_blocked_unknown_preserves_unknown_and_blocks_tlc(self):
        sany = self.command_result(
            status="BLOCKED", process_outcome="UNKNOWN",
            process_started=True, reason="process_result_unavailable",
        )
        with patch("egis_tla_gate.git_identity", return_value=self.identity):
            with patch("egis_tla_gate.run_command", return_value=sany) as mocked:
                result = run_gate(**self.args())
        self.assertEqual("BLOCKED", result["overall"])
        self.assertEqual("UNKNOWN", result["checks"]["sany"]["process_outcome"])
        self.assertTrue(result["checks"]["sany"]["process_started"])
        self.assertEqual("BLOCKED", result["checks"]["tlc"]["status"])
        self.assertEqual("NOT_STARTED", result["checks"]["tlc"]["process_outcome"])
        mocked.assert_called_once()

    def test_sany_timeout_fails_and_never_starts_tlc(self):
        sany = self.command_result(
            status="FAIL", process_outcome="TIMED_OUT",
            process_started=True, reason="process_timed_out",
        )
        with patch("egis_tla_gate.git_identity", return_value=self.identity):
            with patch("egis_tla_gate.run_command", return_value=sany) as mocked:
                result = run_gate(**self.args())
        self.assertEqual("FAIL", result["overall"])
        self.assertEqual("TIMED_OUT", result["checks"]["sany"]["process_outcome"])
        self.assertEqual("BLOCKED", result["checks"]["tlc"]["status"])
        self.assertEqual("NOT_STARTED", result["checks"]["tlc"]["process_outcome"])
        mocked.assert_called_once()

    def test_tlc_blocked_not_started_skips_output_validator(self):
        sany = self.mock_pass(["sany"], self.root, 10)
        tlc = self.command_result(
            status="BLOCKED", process_outcome="NOT_STARTED",
            process_started=False, reason="process_executable_missing",
        )
        with patch("egis_tla_gate.git_identity", return_value=self.identity):
            with patch("egis_tla_gate.run_command", side_effect=[sany, tlc]) as mocked:
                with patch("egis_tla_gate.validate_tlc_output", return_value={"status": "BLOCKED", "reason": "unexpected_validator_call"}) as validator:
                    result = run_gate(**self.args())
        self.assertEqual("BLOCKED", result["overall"])
        self.assertEqual("BLOCKED", result["checks"]["tlc_output_validation"]["status"])
        self.assertEqual("tlc_not_started", result["checks"]["tlc_output_validation"]["reason"])
        validator.assert_not_called()
        self.assertEqual(2, mocked.call_count)

    def test_tlc_blocked_unknown_marks_validation_not_run(self):
        sany = self.mock_pass(["sany"], self.root, 10)
        tlc = self.command_result(
            status="BLOCKED", process_outcome="UNKNOWN",
            process_started=True, reason="process_result_unavailable",
        )
        with patch("egis_tla_gate.git_identity", return_value=self.identity):
            with patch("egis_tla_gate.run_command", side_effect=[sany, tlc]) as mocked:
                with patch("egis_tla_gate.validate_tlc_output", return_value={"status": "BLOCKED", "reason": "unexpected_validator_call"}) as validator:
                    result = run_gate(**self.args())
        self.assertEqual("BLOCKED", result["overall"])
        self.assertEqual("UNKNOWN", result["checks"]["tlc"]["process_outcome"])
        self.assertEqual("NOT_RUN", result["checks"]["tlc_output_validation"]["status"])
        self.assertEqual("tlc_result_unavailable", result["checks"]["tlc_output_validation"]["reason"])
        validator.assert_not_called()
        self.assertEqual(2, mocked.call_count)

    def test_tlc_nonzero_exit_skips_output_validator(self):
        sany = self.mock_pass(["sany"], self.root, 10)
        tlc = self.command_result(
            status="FAIL", process_outcome="EXIT_NONZERO",
            process_started=True, reason="process_nonzero_exit", exit_code=2,
        )
        with patch("egis_tla_gate.git_identity", return_value=self.identity):
            with patch("egis_tla_gate.run_command", side_effect=[sany, tlc]) as mocked:
                with patch("egis_tla_gate.validate_tlc_output", return_value={"status": "BLOCKED", "reason": "unexpected_validator_call"}) as validator:
                    result = run_gate(**self.args())
        self.assertEqual("FAIL", result["overall"])
        self.assertEqual("NOT_RUN", result["checks"]["tlc_output_validation"]["status"])
        self.assertEqual("tlc_execution_failed", result["checks"]["tlc_output_validation"]["reason"])
        validator.assert_not_called()
        self.assertEqual(2, mocked.call_count)

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
        self.assertEqual("1.3", payload["schema_version"])
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

    def test_duplicate_completion_summary_is_not_pass(self):
        from egis_tlc_output_validator import validate_tlc_output
        line = "Model checking completed. No error has been found."
        output = ("Checking 1 invariant...\\n" + line + "\\n" + line +
                  "\\n  12 states generated, 8 distinct states found, 0 states left on queue.\\n")
        self.assertNotEqual("PASS", validate_tlc_output(output, ["Safety"], exit_code=0)["status"])

    def test_nonempty_queue_is_not_complete(self):
        from egis_tlc_output_validator import validate_tlc_output
        output = """Checking 1 invariant...
Model checking completed. No error has been found.
  12 states generated, 8 distinct states found, 2 states left on queue.
"""
        self.assertEqual("FAIL", validate_tlc_output(output, ["Safety"], exit_code=0)["status"])

    def test_config_inventory_is_extracted_without_guessing(self):
        from egis_tlc_output_validator import invariants_from_config
        config = """SPECIFICATION Spec
INVARIANT Safety
INVARIANT TypeOK
"""
        self.assertEqual(["Safety", "TypeOK"], invariants_from_config(config))
        self.assertEqual([], invariants_from_config("SPECIFICATION Spec"))

    def test_missing_tlc_executable_is_blocked_not_execution_failure(self):
        from egis_tlc_output_validator import validate_tlc_output
        result = validate_tlc_output("", ["Safety"], exit_code=None, timed_out=False)
        self.assertEqual("BLOCKED", result["status"])
        self.assertEqual("tlc_process_unavailable", result["reason"])


class TlcOutputAdversarialOrderingTests(unittest.TestCase):
    def test_completion_before_invariant_check_is_not_pass(self):
        from egis_tlc_output_validator import validate_tlc_output
        output = """Model checking completed. No error has been found.
Checking 1 invariant...
  12 states generated, 8 distinct states found, 0 states left on queue.
"""
        self.assertNotEqual("PASS", validate_tlc_output(output, ["Safety"], exit_code=0)["status"])

    def test_state_summary_before_completion_is_not_pass(self):
        from egis_tlc_output_validator import validate_tlc_output
        output = """Checking 1 invariant...
  12 states generated, 8 distinct states found, 0 states left on queue.
Model checking completed. No error has been found.
"""
        self.assertNotEqual("PASS", validate_tlc_output(output, ["Safety"], exit_code=0)["status"])

    def test_empty_or_malformed_invariant_names_are_not_pass(self):
        from egis_tlc_output_validator import validate_tlc_output
        output = """Checking 2 invariants...
Model checking completed. No error has been found.
  12 states generated, 8 distinct states found, 0 states left on queue.
"""
        for inventory in (["Safety", ""], ["Safety", "Bad Name"], ["Safety", None], ["Safety", []]):
            with self.subTest(inventory=inventory):
                self.assertNotEqual("PASS", validate_tlc_output(output, inventory, exit_code=0)["status"])

    def test_oversized_numeric_field_is_fail_closed_not_exception(self):
        from egis_tlc_output_validator import validate_tlc_output
        output = ("Checking 1 invariant...\\n"
                  "Model checking completed. No error has been found.\\n"
                  "  " + ("9" * 5000) + " states generated, 8 distinct states found, 0 states left on queue.\\n")
        result = validate_tlc_output(output, ["Safety"], exit_code=0)
        self.assertNotEqual("PASS", result["status"])

    def test_oversized_invariant_count_is_fail_closed_not_exception(self):
        from egis_tlc_output_validator import validate_tlc_output
        output = ("Checking " + ("9" * 5000) + " invariants...\\n"
                  "Model checking completed. No error has been found.\\n"
                  "  12 states generated, 8 distinct states found, 0 states left on queue.\\n")
        result = validate_tlc_output(output, ["Safety"], exit_code=0)
        self.assertNotEqual("PASS", result["status"])
