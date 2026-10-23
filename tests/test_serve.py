"""Gate 2d-2: the runnable server (python -m master_brain.serve) — configuration, fail-closed start-up, and
durability across a real process kill."""
import http.client
import json
import os
import signal
import stat
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path

from master_brain.accounts import AccountStore
from master_brain.serve import (
    ServeConfig, StartupRefused, build, load_trust_store, preflight,
)

PW = "correct horse battery"
ENV = {**os.environ, "PYTHONPATH": "src:."}


def keyfile(path, keys):
    path.write_text(json.dumps({"keys": keys}))
    os.chmod(path, 0o600)
    return path


def good_key(key_id="k-boss", subject="user:boss", public="ab" * 32):
    return {"key_id": key_id, "subject": subject, "public_key_hex": public}


class Dirs(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.data = Path(self.tmp.name) / "data"


class TrustStoreFile(Dirs):
    def setUp(self):
        super().setUp()
        self.path = Path(self.tmp.name) / "keys.json"

    def load(self, keys):
        return load_trust_store(keyfile(self.path, keys))

    def test_valid_keys_load(self):
        from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
        from master_brain.approval_signing_ed25519 import Ed25519Signer
        signer = Ed25519Signer.generate("k-boss")
        store = self.load([good_key(public=signer.public_key_bytes().hex())])
        message = b"hello"
        self.assertIsNone(store.verify(key_id="k-boss", algorithm="ed25519", subject="user:boss",
                                       message=message, signature=signer.sign(message)))
        self.assertIsNotNone(store.verify(key_id="k-boss", algorithm="ed25519", subject="user:other",
                                          message=message, signature=signer.sign(message)))

    def test_a_malformed_file_is_refused(self):
        bad = [
            [good_key(public="ab" * 31)],                          # wrong length
            [good_key(public="zz" * 32)],                          # not hex
            [good_key(key_id="bad id!")],
            [good_key(subject="bad subject!")],
            [good_key(), good_key()],                              # duplicate key id
            [dict(good_key(), extra="x")],                         # unknown field
            [{"key_id": "k"}],                                     # missing fields
            "not a list",
            [good_key(key_id=f"k{i}") for i in range(101)],        # too many
        ]
        for keys in bad:
            with self.subTest(keys=str(keys)[:60]), self.assertRaises(StartupRefused):
                self.load(keys)

    def test_not_json_or_missing_or_writable_by_others_is_refused(self):
        self.path.write_text("{")
        os.chmod(self.path, 0o600)
        with self.assertRaises(StartupRefused):
            load_trust_store(self.path)
        with self.assertRaises(StartupRefused):
            load_trust_store(self.path.with_name("nope.json"))
        if os.name != "nt":
            keyfile(self.path, [good_key()])
            os.chmod(self.path, 0o666)
            with self.assertRaisesRegex(StartupRefused, "writable"):
                load_trust_store(self.path)


class TrustStoreEdges(Dirs):
    def setUp(self):
        super().setUp()
        self.path = Path(self.tmp.name) / "keys.json"

    def write(self, raw, mode=0o600):
        self.path.write_text(raw if isinstance(raw, str) else json.dumps(raw))
        os.chmod(self.path, mode)

    @unittest.skipIf(os.name == "nt", "POSIX permissions")
    def test_only_group_or_other_write_bits_make_a_key_file_unacceptable(self):
        for mode in (0o620, 0o602, 0o666, 0o660):
            self.write({"keys": []}, mode)
            with self.subTest(mode=oct(mode)), self.assertRaisesRegex(StartupRefused, "writable"):
                load_trust_store(self.path)
        for mode in (0o600, 0o644, 0o605, 0o640, 0o400):
            self.write({"keys": []}, mode)
            with self.subTest(mode=oct(mode)):
                load_trust_store(self.path)

    def test_the_top_level_shape_is_strict(self):
        for raw in ([], [1], {}, {"keys": "x"}, {"keys": [], "extra": 1}, {"other": []}, "null", "5"):
            self.write(raw)
            with self.subTest(raw=str(raw)), self.assertRaisesRegex(StartupRefused, "must be"):
                load_trust_store(self.path)

    def test_non_string_fields_are_refused(self):
        for entry in (good_key(subject=5), good_key(public=12345), good_key(key_id=7), good_key(public=None)):
            self.write({"keys": [entry]})
            with self.subTest(entry=str(entry)), self.assertRaises(StartupRefused):
                load_trust_store(self.path)

    def test_an_unreadable_file_is_a_clean_refusal(self):
        from unittest import mock
        self.write({"keys": []})
        with mock.patch.object(Path, "read_text", side_effect=OSError("io")):
            with self.assertRaisesRegex(StartupRefused, "not valid JSON"):
                load_trust_store(self.path)

    def test_a_missing_signing_extra_is_explained(self):
        from unittest import mock
        self.write({"keys": [good_key()]})
        with mock.patch.dict(sys.modules, {"master_brain.approval_signing_ed25519": None}):
            with self.assertRaisesRegex(StartupRefused, "signing"):
                load_trust_store(self.path)


class Preflight(Dirs):
    def test_nested_data_directories_are_created_and_forced_private_whatever_the_umask(self):
        nested = self.data / "a" / "b"
        old = os.umask(0o277)
        try:
            preflight(nested)
        finally:
            os.umask(old)
        self.assertTrue(nested.is_dir())
        if os.name != "nt":
            self.assertEqual(stat.S_IMODE(nested.stat().st_mode), 0o700)

    @unittest.skipIf(os.name == "nt", "POSIX permissions")
    def test_the_directory_is_private_from_the_instant_it_exists_not_only_after_the_chmod(self):
        from unittest import mock
        old = os.umask(0)
        try:
            with mock.patch("master_brain.serve.os.chmod"):
                preflight(self.data)
        finally:
            os.umask(old)
        self.assertEqual(stat.S_IMODE(self.data.stat().st_mode), 0o700)

    def test_a_data_path_that_is_a_file_is_refused(self):
        self.data.write_text("x")
        with self.assertRaisesRegex(StartupRefused, "not a directory"):
            preflight(self.data)

    @unittest.skipIf(os.name == "nt", "POSIX permissions")
    def test_any_group_or_other_access_bit_on_the_directory_is_refused(self):
        self.data.mkdir()
        for mode in (0o701, 0o710, 0o750, 0o705, 0o770, 0o777):
            os.chmod(self.data, mode)
            with self.subTest(mode=oct(mode)), self.assertRaisesRegex(StartupRefused, "permissions"):
                preflight(self.data)
        os.chmod(self.data, 0o700)
        preflight(self.data)


    def test_a_new_data_directory_is_created_private(self):
        warnings = preflight(self.data)
        self.assertTrue(self.data.is_dir())
        if os.name != "nt":
            self.assertEqual(stat.S_IMODE(self.data.stat().st_mode), 0o700)
        self.assertTrue(any("no accounts" in w for w in warnings))

    @unittest.skipIf(os.name == "nt", "POSIX permissions")
    def test_an_exposed_data_directory_is_refused(self):
        self.data.mkdir(mode=0o755)
        os.chmod(self.data, 0o755)
        with self.assertRaisesRegex(StartupRefused, "permissions"):
            preflight(self.data)

    def test_a_torn_audit_tail_stops_start_up_and_points_at_the_recovery_tool(self):
        preflight(self.data)
        (self.data / "audit.jsonl").write_bytes(b'{"torn":')
        with self.assertRaisesRegex(StartupRefused, "audit_recovery"):
            preflight(self.data)

    def test_a_tampered_log_stops_start_up_without_suggesting_a_repair(self):
        from master_brain.audit_store import AuditStore, NOW
        preflight(self.data)
        store = AuditStore(self.data / "audit.jsonl")
        for i in range(2):
            store.append(event_id=f"e{i}", event_type="mission.contract_registered", recorded_at=NOW,
                         actor="user:a", subject_ref=f"mission:mission-{i:016x}",
                         payload={"mission_id": f"mission-{i:016x}", "contract_schema_version": "1",
                                  "contract_digest": "a" * 64})
        raw = (self.data / "audit.jsonl").read_bytes().replace(b"user:a", b"user:z", 1)
        (self.data / "audit.jsonl").write_bytes(raw)
        with self.assertRaises(StartupRefused) as ctx:
            preflight(self.data)
        self.assertNotIn("audit_recovery", str(ctx.exception))

    def test_the_warnings_name_what_is_not_configured(self):
        warnings = preflight(self.data)
        AccountStore(self.data / "accounts.sqlite").create_account("user:boss", PW)
        again = preflight(self.data)
        self.assertTrue(any("no accounts" in w for w in warnings))
        self.assertFalse(any("no accounts" in w for w in again))
        self.assertTrue(any("approver" in w for w in again))


class Build(Dirs):
    def config(self, **kw):
        return ServeConfig(data_dir=self.data, **kw)

    def test_defaults_are_the_safe_ones(self):
        from master_brain.serve import _parse
        config = ServeConfig(data_dir=self.data)
        self.assertEqual((config.host, config.allow_non_loopback, config.secure_cookies, config.demo_echo_task,
                          config.approval_keys, config.allowed_hosts), ("127.0.0.1", False, False, False, None, ()))
        parsed = _parse(["--data-dir", str(self.data)])
        self.assertEqual(parsed, ServeConfig(data_dir=self.data))

    def test_a_non_loopback_bind_warns_about_tls_and_a_loopback_bind_does_not(self):
        wide = build(self.config(host="0.0.0.0", port=0, allow_non_loopback=True, allowed_hosts=("brain.example.org",)))
        self.addCleanup(wide.close)
        self.assertTrue(any("TLS" in w for w in wide.warnings))
        narrow = build(self.config(port=0))
        self.addCleanup(narrow.close)
        self.assertFalse(any("TLS" in w for w in narrow.warnings))

    def test_a_missing_key_file_and_the_demo_flag_are_announced(self):
        built = build(self.config(port=0, demo_echo_task=True))
        self.addCleanup(built.close)
        self.assertTrue(any("--approval-keys" in w for w in built.warnings))
        self.assertTrue(any("demo" in w for w in built.warnings))

    def test_a_non_loopback_bind_needs_explicit_hosts(self):
        with self.assertRaises((StartupRefused, ValueError)):
            build(self.config(host="0.0.0.0"))

    def test_the_server_starts_on_loopback_with_only_session_authentication(self):
        built = build(self.config(port=0))
        self.addCleanup(built.close)
        threading.Thread(target=built.run, daemon=True).start()
        port = built.server.server_address[1]
        c = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
        c.request("GET", "/v1/tasks", headers={"Authorization": "Bearer " + "x" * 40})
        self.assertEqual(c.getresponse().status, 401)  # no static tokens exist in a served instance
        c.close()

    def test_without_the_demo_flag_no_task_can_run(self):
        built = build(self.config(port=0))
        self.addCleanup(built.close)
        self.assertIsNone(built.service._execution)

    def test_the_demo_flag_registers_exactly_one_offline_task(self):
        built = build(self.config(port=0, demo_echo_task=True))
        self.addCleanup(built.close)
        tasks = built.service._execution.catalog.list()
        self.assertEqual([t.task_id for t in tasks], ["echo"])
        self.assertEqual(tasks[0].integration.limitations, ("offline only",))


class RealProcess(Dirs):
    """The scientific check: a REAL process, killed with SIGKILL, restarted on the same files."""

    def start(self, *extra):
        proc = subprocess.Popen([sys.executable, "-m", "master_brain.serve", "--data-dir", str(self.data),
                                 "--port", "0", *extra], stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                text=True, env=ENV)
        self.addCleanup(lambda: (proc.poll() is None and proc.kill(), proc.wait(10),
                                 proc.stdout.close(), proc.stderr.close()))
        line = proc.stdout.readline()
        self.assertIn("listening on http://127.0.0.1:", line, proc.stderr.read() if proc.poll() else "")
        port = int(line.split("127.0.0.1:")[1].split("/")[0])
        return proc, port

    def call(self, port, method, path, body=None, cookie=None):
        c = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
        headers = {"Content-Type": "application/json", "Origin": f"http://127.0.0.1:{port}"}
        if cookie:
            headers["Cookie"] = cookie
        c.request(method, path, json.dumps(body) if body is not None else None, headers)
        r = c.getresponse()
        data = r.read()
        set_cookie = r.getheader("Set-Cookie")
        c.close()
        return r.status, (json.loads(data) if data and data[:1] == b"{" else data), set_cookie

    def login(self, port, subject):
        status, _body, cookie = self.call(port, "POST", "/v1/session", {"subject": subject, "password": PW})
        self.assertEqual(status, 201)
        return cookie.split(";")[0]

    def test_approval_survives_kill_9_and_a_restart(self):
        from master_brain.approval_signing_ed25519 import Ed25519Signer
        signer = Ed25519Signer.generate("k-boss")
        self.data.mkdir(mode=0o700)
        os.chmod(self.data, 0o700)
        accounts = AccountStore(self.data / "accounts.sqlite")
        accounts.create_account("user:boss", PW, roles=("approver",), actor="operator:test")
        accounts.create_account("user:dave", PW, actor="operator:test")
        keys = keyfile(Path(self.tmp.name) / "keys.json",
                       [good_key("k-boss", "user:boss", signer.public_key_bytes().hex())])
        proc, port = self.start("--approval-keys", str(keys), "--demo-echo-task")
        dave, boss = self.login(port, "user:dave"), self.login(port, "user:boss")
        status, mission, _ = self.call(port, "POST", "/v1/missions", {
            "idempotency_key": "key-0000000001", "objective": "Pay supplier", "success_criteria": ["receipt"],
            "risk_tier": "high"}, cookie=dave)
        self.assertEqual(status, 201, mission)
        mid = mission["mission_id"]
        tasks = self.call(port, "GET", "/v1/tasks", cookie=dave)[1]["tasks"]
        digest = tasks[0]["action_digest"]
        self.assertEqual(self.call(port, "GET", "/v1/approvals", cookie=dave)[0], 403)  # dave is not an approver
        queue = self.call(port, "GET", "/v1/approvals", cookie=boss)[1]["missions"]
        self.assertEqual([m["mission_id"] for m in queue], [mid])
        challenge = self.call(port, "POST", f"/v1/missions/{mid}/approval-challenges", {
            "contract_digest": mission["contract_digest"], "signing_key_id": "k-boss",
            "signature_alg": "ed25519", "action_digest": digest}, cookie=boss)[1]
        signature = signer.sign(bytes.fromhex(challenge["signing_message_hex"])).hex()
        status, approved, _ = self.call(port, "POST", f"/v1/missions/{mid}/approvals", {
            "idempotency_key": "approve-0000001", "approval_event_id": challenge["approval_event_id"],
            "signing_key_id": "k-boss", "signature_alg": "ed25519", "signature_hex": signature}, cookie=boss)
        self.assertEqual((status, approved["approval_status"]), (201, "granted"), approved)

        os.kill(proc.pid, signal.SIGKILL)
        proc.wait(10)

        proc2, port2 = self.start("--approval-keys", str(keys), "--demo-echo-task")
        self.assertEqual(self.call(port2, "GET", f"/v1/missions/{mid}", cookie=self.login(port2, "user:dave"))[1]
                         ["approval_status"], "granted")  # approval, mission and accounts all survived
        self.assertEqual(self.call(port2, "GET", "/v1/approvals", cookie=self.login(port2, "user:boss"))[1]["missions"], [])
        status, result, _ = self.call(port2, "POST", f"/v1/missions/{mid}/executions", {
            "idempotency_key": "exec-00000001", "task_id": "echo"}, cookie=self.login(port2, "user:dave"))
        self.assertEqual((status, result["state"]), (201, "response_received"), result)

    def test_start_up_refuses_a_torn_log_and_works_again_after_recovery(self):
        self.data.mkdir(mode=0o700)
        os.chmod(self.data, 0o700)
        (self.data / "audit.jsonl").write_bytes(b'{"torn":')
        proc = subprocess.run([sys.executable, "-m", "master_brain.serve", "--data-dir", str(self.data), "--port", "0"],
                              capture_output=True, text=True, env=ENV, timeout=60)
        self.assertEqual(proc.returncode, 2)
        self.assertIn("audit_recovery", proc.stderr)
        recovered = subprocess.run([sys.executable, "-m", "master_brain.audit_recovery", "--path",
                                    str(self.data / "audit.jsonl"), "--apply"],
                                   capture_output=True, text=True, env=ENV, timeout=60)
        self.assertEqual(recovered.returncode, 0, recovered.stderr)
        proc2, port = self.start()
        self.assertEqual(self.call(port, "GET", "/app/")[0], 200)

    def test_sigterm_stops_the_server_cleanly(self):
        proc, port = self.start()
        proc.send_signal(signal.SIGTERM)
        self.assertEqual(proc.wait(15), 0)


if __name__ == "__main__":
    unittest.main()
