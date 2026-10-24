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
from unittest import mock

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
    def test_missing_parent_directories_are_created(self):
        nested = self.data / "a" / "b"
        preflight(nested)
        self.assertTrue(nested.is_dir())

    @unittest.skipIf(os.name == "nt", "POSIX permissions")
    def test_the_directory_is_forced_private_whatever_the_umask(self):
        self.data.mkdir()  # the parent exists: a hostile umask would otherwise also strip the owner's own write bit
        target = self.data / "private"
        old = os.umask(0o277)
        try:
            preflight(target)
        finally:
            os.umask(old)
        self.assertEqual(stat.S_IMODE(target.stat().st_mode), 0o700)

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

    def test_the_server_uses_the_verified_prefix_cache_for_both_logs(self):
        import master_brain.serve as serve_module
        self.assertEqual(serve_module.FULL_VERIFY_SECONDS, 300.0)
        with mock.patch.object(serve_module, "AuditStore", wraps=serve_module.AuditStore) as audit, \
                mock.patch.object(serve_module, "AccountStore", wraps=serve_module.AccountStore) as accounts:
            built = build(self.config(port=0))
            self.addCleanup(built.close)
        self.assertEqual(audit.call_args_list[-1].kwargs["full_verify_interval_seconds"], 300.0)
        self.assertEqual(accounts.call_args_list[-1].kwargs["full_verify_interval_seconds"], 300.0)
        self.assertEqual(built.service._store._full_interval, 300.0)

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

    def test_pubmed_specs_register_read_only_free_tasks_and_are_announced(self):
        calls = []
        built = build(self.config(port=0, pubmed_searches=("pm-a=metformin AND trial", "pm-b=aspirin")),
                      pubmed_fetcher=lambda url: calls.append(url) or b"{}")
        self.addCleanup(built.close)
        tasks = built.service._execution.catalog.list()
        self.assertEqual([t.task_id for t in tasks], ["pm-a", "pm-b"])
        self.assertEqual(tasks[0].payload(), {"query": "metformin AND trial", "max_results": 10})
        self.assertEqual((tasks[0].integration.risk_level, tasks[0].integration.estimated_cost_per_call), (0, 0.0))
        self.assertTrue(any("eutils.ncbi.nlm.nih.gov" in w for w in built.warnings))
        self.assertEqual(calls, [])  # registering never touches the network

    def test_pubmed_specs_coexist_with_the_demo_task(self):
        built = build(self.config(port=0, demo_echo_task=True, pubmed_searches=("pm=x",)))
        self.addCleanup(built.close)
        self.assertEqual([t.task_id for t in built.service._execution.catalog.list()], ["echo", "pm"])

    def test_malformed_or_duplicate_pubmed_specs_refuse_to_start(self):
        for specs, demo in ((("no-equals",), False), (("=q",), False), (("Bad ID=q",), False), (("ok=",), False),
                            (("ok=" + "x" * 501,), False), (("a=q", "a=r"), False), (("echo=q",), True)):
            with self.assertRaises(StartupRefused, msg=specs):
                build(self.config(port=0, demo_echo_task=demo, pubmed_searches=specs))

    def test_a_spec_without_equals_says_how_to_write_it(self):
        with self.assertRaises(StartupRefused) as ctx:
            build(self.config(port=0, pubmed_searches=("no-equals",)))
        self.assertIn("TASK_ID=QUERY", str(ctx.exception))

    def test_abstract_tasks_register_with_their_own_integration_and_share_the_id_space(self):
        built = build(self.config(port=0, pubmed_searches=("pm=a",), pubmed_abstracts=("pa=b",)),
                      pubmed_fetcher=lambda url: b"{}")
        self.addCleanup(built.close)
        tasks = {t.task_id: t for t in built.service._execution.catalog.list()}
        self.assertEqual({k: v.integration.integration_id for k, v in tasks.items()},
                         {"pm": "pubmed-esearch", "pa": "pubmed-abstracts"})
        self.assertEqual(tasks["pa"].payload(), {"query": "b", "max_results": 10})
        self.assertTrue(any("eutils.ncbi.nlm.nih.gov" in w for w in built.warnings))
        for bad in (("pm=x",), ("no-equals",), ("=q",)):
            with self.assertRaises(StartupRefused, msg=bad):
                build(self.config(port=0, pubmed_searches=("pm=a",), pubmed_abstracts=bad))
        with self.assertRaises(StartupRefused) as ctx:
            build(self.config(port=0, pubmed_abstracts=("no-equals",)))
        self.assertIn("--pubmed-abstracts", str(ctx.exception))
        self.assertIn("TASK_ID=QUERY", str(ctx.exception))

    def test_abstracts_alone_announce_network_use(self):
        built = build(self.config(port=0, pubmed_abstracts=("pa=b",)))
        self.addCleanup(built.close)
        self.assertTrue(any("eutils.ncbi.nlm.nih.gov" in w for w in built.warnings))

    def test_the_command_line_flag_is_repeatable(self):
        from master_brain.serve import _parse
        cfg = _parse(["--data-dir", "d", "--pubmed-search", "a=x", "--pubmed-search", "b=y"])
        self.assertEqual(cfg.pubmed_searches, ("a=x", "b=y"))
        self.assertEqual(_parse(["--data-dir", "d"]).pubmed_searches, ())
        both = _parse(["--data-dir", "d", "--pubmed-abstracts", "c=z", "--pubmed-abstracts", "e=y"])
        self.assertEqual((both.pubmed_abstracts, both.pubmed_searches), (("c=z", "e=y"), ()))
        self.assertEqual(_parse(["--data-dir", "d"]).pubmed_abstracts, ())


class StopRace(unittest.TestCase):
    """A shutdown request that arrives before the serve loop has started must not be lost."""

    class FakeServer:
        def __init__(self):
            self.calls = []

        def serve_forever(self):
            self.calls.append("serve_forever")

        def shutdown(self):
            self.calls.append("shutdown")

    def built(self):
        from master_brain.serve import Built
        server = self.FakeServer()
        return Built(server, None, []), server

    def test_stop_before_run_makes_run_return_without_serving(self):
        b, server = self.built()
        b.stop()
        b.run()
        self.assertEqual(server.calls, [])

    def test_stop_after_run_started_shuts_the_loop_down(self):
        b, server = self.built()
        b.run()
        b.stop()
        self.assertEqual(server.calls, ["serve_forever", "shutdown"])

    def test_stop_is_idempotent_and_run_after_stop_stays_a_no_op(self):
        b, server = self.built()
        b.stop()
        b.stop()
        b.run()
        b.run()
        self.assertEqual(server.calls, [])

    def test_stop_while_the_loop_runs_in_another_thread(self):
        import http.server
        built = build(ServeConfig(Path(tempfile.mkdtemp()) / "d", port=0))
        self.addCleanup(built.server.server_close)
        t = threading.Thread(target=built.run, daemon=True)
        t.start()
        time.sleep(0.2)
        built.stop()
        t.join(10)
        self.assertFalse(t.is_alive())


class ProcessHelpers:
    """Helpers shared by the real-process and through-the-gates suites (no tests of their own)."""

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

class RealProcess(ProcessHelpers, Dirs):
    """The scientific check: a REAL process, killed with SIGKILL, restarted on the same files."""

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


class PubMedThroughTheGates(ProcessHelpers, Dirs):
    """Gate 3a: the PubMed task travels the whole approved path over real HTTP (fake network only)."""

    GOOD = json.dumps({"esearchresult": {"count": "2144", "idlist": ["42870643", "42655937"]}}).encode()

    def serve(self, fetcher, signer=None, **specs):
        from master_brain.approval_signing_ed25519 import Ed25519Signer
        self.signer = signer or Ed25519Signer.generate("k-boss")
        self.data.mkdir(mode=0o700)
        os.chmod(self.data, 0o700)
        accounts = AccountStore(self.data / "accounts.sqlite")
        accounts.create_account("user:boss", PW, roles=("approver",), actor="operator:test")
        accounts.create_account("user:dave", PW, actor="operator:test")
        keys = keyfile(Path(self.tmp.name) / "keys.json",
                       [good_key("k-boss", "user:boss", self.signer.public_key_bytes().hex())])
        specs = specs or {"pubmed_searches": ("pm=metformin trial",)}
        built = build(ServeConfig(self.data, port=0, approval_keys=keys, **specs), pubmed_fetcher=fetcher)
        self.addCleanup(built.close)
        threading.Thread(target=built.run, daemon=True).start()
        port = built.server.server_address[1]
        self.dave, self.boss = self.login(port, "user:dave"), self.login(port, "user:boss")
        return port

    def approved_mission(self, port, tag):
        status, mission, _ = self.call(port, "POST", "/v1/missions", {
            "idempotency_key": f"key-{tag}-000001", "objective": "Literature scan", "success_criteria": ["ids"],
            "risk_tier": "high"}, cookie=self.dave)
        self.assertEqual(status, 201, mission)
        self.approve_mission(port, mission["mission_id"], mission["contract_digest"], tag)
        return mission["mission_id"]

    def approve_mission(self, port, mid, contract_digest, tag):
        digest = self.call(port, "GET", "/v1/tasks", cookie=self.dave)[1]["tasks"][0]["action_digest"]
        challenge = self.call(port, "POST", f"/v1/missions/{mid}/approval-challenges", {
            "contract_digest": contract_digest, "signing_key_id": "k-boss",
            "signature_alg": "ed25519", "action_digest": digest}, cookie=self.boss)[1]
        signature = self.signer.sign(bytes.fromhex(challenge["signing_message_hex"])).hex()
        status, approved, _ = self.call(port, "POST", f"/v1/missions/{mid}/approvals", {
            "idempotency_key": f"appr-{tag}-0000001", "approval_event_id": challenge["approval_event_id"],
            "signing_key_id": "k-boss", "signature_alg": "ed25519", "signature_hex": signature}, cookie=self.boss)
        self.assertEqual((status, approved["approval_status"]), (201, "granted"), approved)

    def test_approval_signed_by_the_key_tool_is_accepted_end_to_end(self):
        from master_brain import approval_keys

        class ToolSigner:  # signs only through the real tool, with the real refusals
            def __init__(self, path, passphrase, public):
                self.path, self.passphrase, self.public = path, passphrase, public

            def public_key_bytes(self):
                return bytes.fromhex(self.public)

            def sign(self, message):
                return bytes.fromhex(approval_keys.sign(self.path, message.hex(), self.passphrase,
                                                        confirm=lambda: True))
        key_path = Path(self.tmp.name) / "boss.key"
        entry = approval_keys.keygen("k-boss", "user:boss", key_path, "a long passphrase 42")
        port = self.serve(lambda url: self.GOOD, signer=ToolSigner(key_path, "a long passphrase 42",
                                                                  entry["public_key_hex"]))
        mid = self.approved_mission(port, "tool")
        status, result, _ = self.call(port, "POST", f"/v1/missions/{mid}/executions", {
            "idempotency_key": "exec-tool-00001", "task_id": "pm"}, cookie=self.dave)
        self.assertEqual((status, result["state"]), (201, "response_received"), result)

    def test_an_approved_search_returns_pmids_and_touches_the_network_exactly_once_with_the_approved_query(self):
        urls = []
        port = self.serve(lambda url: urls.append(url) or self.GOOD)
        self.assertEqual(urls, [])  # nothing before approval and execution
        mid = self.approved_mission(port, "ok")
        status, result, _ = self.call(port, "POST", f"/v1/missions/{mid}/executions", {
            "idempotency_key": "exec-ok-000001", "task_id": "pm"}, cookie=self.dave)
        self.assertEqual((status, result["state"]), (201, "response_received"), result)
        self.assertEqual(len(urls), 1)
        self.assertIn("term=metformin+trial", urls[0])
        self.assertIn("retmax=10", urls[0])
        self.assertIn("42870643", json.dumps(result))

    def test_an_approved_abstract_task_makes_exactly_two_requests_and_returns_abstracts(self):
        urls = []
        xml = (b"<PubmedArticleSet><PubmedArticle><MedlineCitation><PMID>42870643</PMID><Article>"
               b"<Journal><JournalIssue><PubDate><Year>2026</Year></PubDate></JournalIssue><Title>J</Title></Journal>"
               b"<ArticleTitle>T</ArticleTitle><Abstract><AbstractText>ABSTRACT-OK</AbstractText></Abstract>"
               b"</Article></MedlineCitation></PubmedArticle></PubmedArticleSet>")

        def fetch(url):
            urls.append(url)
            return self.GOOD.replace(b'"42655937"', b'"42870643"').replace(b'["42870643", "42870643"]', b'["42870643"]') \
                if "esearch" in url else xml
        port = self.serve(fetch, pubmed_abstracts=("pa=metformin trial",))
        mid = self.approved_mission(port, "abs")
        status, result, _ = self.call(port, "POST", f"/v1/missions/{mid}/executions", {
            "idempotency_key": "exec-abs-00001", "task_id": "pa"}, cookie=self.dave)
        self.assertEqual((status, result["state"]), (201, "response_received"), result)
        self.assertEqual([("esearch" in u, "efetch" in u) for u in urls], [(True, False), (False, True)])
        self.assertIn("ABSTRACT-OK", json.dumps(result))

    def test_a_hostile_upstream_answer_fails_cleanly_and_leaks_nothing(self):
        port = self.serve(lambda url: b'{"esearchresult": {"ERROR": "SECRET-UPSTREAM-TEXT"}}')
        mid = self.approved_mission(port, "bad")
        status, result, _ = self.call(port, "POST", f"/v1/missions/{mid}/executions", {
            "idempotency_key": "exec-bad-00001", "task_id": "pm"}, cookie=self.dave)
        self.assertNotIn("SECRET-UPSTREAM-TEXT", json.dumps(result))
        self.assertEqual((status, result["error"]["code"]), (502, "dispatch_failed"), result)
        audit = (self.data / "audit.jsonl").read_text()
        self.assertNotIn("SECRET-UPSTREAM-TEXT", audit)

    def test_a_transient_upstream_failure_is_definite_and_a_retry_with_a_new_key_succeeds(self):
        state = {"up": False}

        def fetch(url):
            if not state["up"]:
                raise OSError("network down")
            return self.GOOD
        port = self.serve(fetch)
        mid = self.approved_mission(port, "retry")
        status, result, _ = self.call(port, "POST", f"/v1/missions/{mid}/executions", {
            "idempotency_key": "exec-rt-000001", "task_id": "pm"}, cookie=self.dave)
        self.assertEqual((status, result["error"]["code"]), (502, "dispatch_failed"), result)
        mission = self.call(port, "GET", f"/v1/missions/{mid}", cookie=self.dave)[1]
        self.assertEqual(mission["state"], "dispatch_failed_no_effect", mission)  # no reconciliation needed
        state["up"] = True
        # approvals stay single-use: the failed attempt consumed this one, so a retry needs a fresh approval
        status, result, _ = self.call(port, "POST", f"/v1/missions/{mid}/executions", {
            "idempotency_key": "exec-rt-000002", "task_id": "pm"}, cookie=self.dave)
        self.assertEqual((status, result["error"]["code"]), (403, "approval_required"), result)
        self.approve_mission(port, mid, mission["contract_digest"], "retry2")
        status, result, _ = self.call(port, "POST", f"/v1/missions/{mid}/executions", {
            "idempotency_key": "exec-rt-000003", "task_id": "pm"}, cookie=self.dave)
        self.assertEqual((status, result["state"]), (201, "response_received"), result)

    def test_without_approval_the_network_is_never_touched(self):
        urls = []
        port = self.serve(lambda url: urls.append(url) or self.GOOD)
        status, mission, _ = self.call(port, "POST", "/v1/missions", {
            "idempotency_key": "key-na-0000001", "objective": "Literature scan", "success_criteria": ["ids"],
            "risk_tier": "high"}, cookie=self.dave)
        status, result, _ = self.call(port, "POST", f"/v1/missions/{mission['mission_id']}/executions", {
            "idempotency_key": "exec-na-000001", "task_id": "pm"}, cookie=self.dave)
        self.assertEqual((status, result["error"]["code"]), (403, "approval_required"), result)
        self.assertEqual(urls, [])
