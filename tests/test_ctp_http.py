"""CTP operator workflow over a REAL running HTTP server, with the real key tool and the separate verifier process.

Signing/verification tests (real Ed25519 keys, real passphrase-protected key files) and real sandbox runs.
"""
import http.client
import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from master_brain import approval_keys as K
from master_brain import ctp_operations as O
from master_brain import ctp_runner as R
from master_brain import ctp_verify as V
from master_brain.approvers import StaticApprovers
from master_brain.audit_store import AuditStore
from master_brain.ctp_registry import builtin_registry
from master_brain.http_api import MAX_BODY_BYTES, make_server, serve_in_thread
from master_brain.identity import StaticTokenAuthenticator
from master_brain.mission_service import MissionService
from master_brain.serve import load_trust_store

_STATUS = R.sandbox_status()
REQUIRE = os.environ.get("MB_REQUIRE_SANDBOX_TESTS") == "1"
needs_sandbox = unittest.skipIf(not _STATUS["available"] and not REQUIRE, "no working sandbox on this host")

ALICE = "alice-token-" + "a" * 32
BOSS = "boss-token--" + "b" * 32
EVE = "eve-token----" + "e" * 32
PASS = "correct horse battery staple"
TEST_ID = "sha256-known-answer"


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.dir = Path(self.tmp.name)
        self.data = self.dir / "data"
        self.data.mkdir()
        self.boss_key, self.ver_key, self.bad_key = (self.dir / "boss.key", self.dir / "ver.key", self.dir / "bad.key")
        entries = [K.keygen("k-boss", "user:boss", self.boss_key, PASS),
                   K.keygen("k-ver", "verifier:v1", self.ver_key, PASS)]
        self.keys_json = self.dir / "keys.json"
        self.keys_json.write_text(json.dumps({"keys": entries}))
        os.chmod(self.keys_json, 0o600)
        self.store = AuditStore(self.data / "audit.jsonl")
        trust = load_trust_store(self.keys_json)
        (self.data / "ctp-evidence").mkdir(mode=0o700)
        self.ops = O.CtpOperations(self.store, builtin_registry(), StaticApprovers({"user:boss"}), trust,
                                   self.data / "ctp-evidence")
        auth = StaticTokenAuthenticator({ALICE: ("user:alice", ("operator",)), BOSS: ("user:boss", ("approver",)),
                                         EVE: "user:eve"})
        self.server = make_server(MissionService(self.store, trust, None, StaticApprovers({"user:boss"})), auth,
                                  ctp=self.ops)
        self.thread = serve_in_thread(self.server)
        self.port = self.server.server_address[1]
        self.addCleanup(self._close)

    def _close(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(5)

    def call(self, method, path, body=None, token=ALICE, raw=None, headers=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=60)
        try:
            h = dict(headers or {})
            if token:
                h["Authorization"] = f"Bearer {token}"
            data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
            if data is not None:
                h.setdefault("Content-Type", "application/json")
            conn.request(method, path, body=data, headers=h)
            r = conn.getresponse()
            payload = r.read()
            return r.status, (json.loads(payload) if payload else {})
        finally:
            conn.close()

    def sign(self, message_hex):
        return K.sign(self.boss_key, message_hex, PASS, confirm=lambda: True)


@needs_sandbox
class OverHttp(Base):
    def full_flow_until_executed(self):
        st, run = self.call("POST", "/v1/ctp/runs", {"test_id": TEST_ID})
        self.assertEqual(st, 201, run)
        rid = run["request_id"]
        st, ch = self.call("POST", f"/v1/ctp/runs/{rid}/approval-challenges",
                           {"signing_key_id": "k-boss", "signature_alg": "ed25519"}, token=BOSS)
        self.assertEqual(st, 201, ch)
        sig = self.sign(ch["signing_message_hex"])      # the REAL key tool, which parses and shows the CTP message
        st, ap = self.call("POST", f"/v1/ctp/runs/{rid}/approvals", {
            "approval_event_id": ch["approval_event_id"], "signing_key_id": "k-boss",
            "signature_alg": "ed25519", "signature_hex": sig}, token=BOSS)
        self.assertEqual(st, 201, ap)
        st, done = self.call("POST", f"/v1/ctp/runs/{rid}/executions", {})
        self.assertEqual(st, 201, done)
        return rid, done

    def verify_cli(self, rid, key=None):
        with mock.patch.object(sys, "stdin", io.StringIO(PASS + "\n")):
            return V.main(["--data-dir", str(self.data), "--approval-keys", str(self.keys_json),
                           "--verifier-key", str(key or self.ver_key), "--request-id", rid, "--passphrase-stdin"])

    def test_whole_operator_path_with_separate_verifier_process(self):
        st, tests = self.call("GET", "/v1/ctp/tests")
        self.assertEqual(st, 200)
        self.assertEqual({t["test_id"] for t in tests["tests"]}, {"sandbox-isolation-selfcheck", TEST_ID})
        for t in tests["tests"]:     # the listing exposes digests and limits, never the code, argv or inputs
            self.assertEqual(set(t), {"test_id", "title", "description", "spec_digest", "criterion", "isolation", "limits"})
        rid, done = self.full_flow_until_executed()
        self.assertEqual((done["status"], done["final_ctp_status"]), ("executed_unverified", "inconclusive"))
        self.assertEqual(self.verify_cli(rid), 0)
        st, final = self.call("GET", f"/v1/ctp/runs/{rid}")
        self.assertEqual((final["status"], final["final_ctp_status"]), ("verified_pass", "pass"))
        self.assertEqual(final["verification"]["verifier_id"], "v1")
        for secret in (str(self.data), "PRIVATE KEY", PASS):
            self.assertNotIn(secret, json.dumps(final))

    def test_key_tool_shows_what_is_being_approved(self):
        st, run = self.call("POST", "/v1/ctp/runs", {"test_id": TEST_ID})
        st, ch = self.call("POST", f"/v1/ctp/runs/{run['request_id']}/approval-challenges",
                           {"signing_key_id": "k-boss", "signature_alg": "ed25519"}, token=BOSS)
        shown = []
        K.sign(self.boss_key, ch["signing_message_hex"], PASS, confirm=lambda: True, show=shown.append)
        text = "\n".join(shown)
        for needle in (run["request_id"], TEST_ID, run["spec_digest"], "user:alice", "RUN A REGISTERED CTP TEST"):
            self.assertIn(needle, text)

    def test_unauthenticated_and_unauthorized_requests(self):
        rid = self.call("POST", "/v1/ctp/runs", {"test_id": TEST_ID})[1]["request_id"]
        routes = [("GET", "/v1/ctp/tests", None), ("POST", "/v1/ctp/runs", {"test_id": TEST_ID}),
                  ("GET", f"/v1/ctp/runs/{rid}", None), ("POST", f"/v1/ctp/runs/{rid}/executions", {}),
                  ("POST", f"/v1/ctp/runs/{rid}/approval-challenges", {"signing_key_id": "k", "signature_alg": "a"}),
                  ("POST", f"/v1/ctp/runs/{rid}/approvals", {"approval_event_id": "x", "signing_key_id": "k",
                                                              "signature_alg": "a", "signature_hex": "00"})]
        for method, path, body in routes:
            self.assertEqual(self.call(method, path, body, token=None)[0], 401, path)
            self.assertEqual(self.call(method, path, body, token="x" * 40)[0], 401, path)
        self.assertEqual(self.call("POST", "/v1/ctp/runs", {"test_id": TEST_ID}, token=EVE)[0], 403)
        self.assertEqual(self.call("GET", f"/v1/ctp/runs/{rid}", token=EVE)[0], 404)
        self.assertEqual(self.call("POST", f"/v1/ctp/runs/{rid}/executions", {}, token=EVE)[0], 404)
        st, _ = self.call("POST", f"/v1/ctp/runs/{rid}/approval-challenges",
                          {"signing_key_id": "k-boss", "signature_alg": "ed25519"}, token=ALICE)
        self.assertEqual(st, 403)          # the requester is not a designated approver
        self.assertEqual(self.call("POST", f"/v1/ctp/runs/{rid}/executions", {})[0], 403)   # APPROVAL_REQUIRED
        self.assertEqual(self.store.read_all()[-1].event_type, "ctp.run_requested")

    def test_malformed_oversized_and_injecting_bodies(self):
        base = "/v1/ctp/runs"
        self.assertEqual(self.call("POST", base, raw=b"{not json")[0], 400)
        self.assertEqual(self.call("POST", base, raw=b"[]")[0], 400)
        self.assertEqual(self.call("POST", base, {"test_id": TEST_ID, "argv": ["/bin/sh"]})[0], 400)
        self.assertEqual(self.call("POST", base, {"test_id": TEST_ID, "code": "import os"})[0], 400)
        self.assertEqual(self.call("POST", base, {"test_id": "../../bin/sh"})[0], 400)
        self.assertEqual(self.call("POST", base, raw=b'{"test_id":"a","test_id":"b"}')[0], 400)   # duplicate key
        self.assertEqual(self.call("POST", base, raw=b'{"test_id":"%s"}' % (b"x" * (MAX_BODY_BYTES + 1)))[0], 400)
        self.assertEqual(self.call("POST", base, {"test_id": "no-such-test"})[0], 404)
        self.assertEqual(self.call("GET", "/v1/ctp/runs/ctpreq-xyz")[0], 404)
        self.assertEqual(self.call("DELETE", "/v1/ctp/runs")[0], 400)
        self.assertEqual(self.call("GET", "/v1/ctp/runs/../tests")[0], 404)
        self.assertEqual(self.call("POST", base, raw=b'{"test_id":"x"}', headers={"Content-Type": "text/plain"})[0], 400)
        self.assertEqual(self.store.read_all(), ())

    def test_replay_and_double_submission_over_http(self):
        rid, _ = self.full_flow_until_executed()
        self.assertEqual(self.call("POST", f"/v1/ctp/runs/{rid}/executions", {})[0], 409)   # DUPLICATE_REQUEST
        self.assertEqual([e.event_type for e in self.store.read_all()].count("ctp.test_executed"), 1)


@needs_sandbox
class SeparateVerifier(Base):
    def run_to_executed(self):
        return OverHttp.full_flow_until_executed(self), None

    def setUp(self):
        super().setUp()
        self.h = OverHttp("full_flow_until_executed")
        self.h.__dict__.update({k: v for k, v in self.__dict__.items() if k not in ("_testMethodName",)})
        self.h.call, self.h.sign = self.call, self.sign
        self.h.assertEqual = self.assertEqual
        self.rid, _ = OverHttp.full_flow_until_executed(self.h)

    def cli(self, key=None, rid=None, keys=None):
        with mock.patch.object(sys, "stdin", io.StringIO(PASS + "\n")):
            return V.main(["--data-dir", str(self.data), "--approval-keys", str(keys or self.keys_json),
                           "--verifier-key", str(key or self.ver_key), "--request-id", rid or self.rid,
                           "--passphrase-stdin"])

    def test_verifier_refuses_a_key_not_bound_to_a_verifier_subject(self):
        self.assertEqual(self.cli(key=self.boss_key), 2)
        self.assertEqual(self.ops.get_run(O.Identity("user:alice", frozenset({"operator"})), self.rid)["status"],
                         "executed_unverified")

    def test_verifier_refuses_wrong_passphrase_and_unknown_or_malformed_request(self):
        with mock.patch.object(sys, "stdin", io.StringIO("not the passphrase 123\n")):
            self.assertEqual(V.main(["--data-dir", str(self.data), "--approval-keys", str(self.keys_json),
                                     "--verifier-key", str(self.ver_key), "--request-id", self.rid,
                                     "--passphrase-stdin"]), 2)
        self.assertEqual(self.cli(rid="ctpreq-" + "1" * 32), 2)
        self.assertEqual(self.cli(rid="../../x"), 2)

    def test_verifier_refuses_when_the_approval_chain_is_invalid(self):
        # remove the approver's key from the trust store: the approval signature can no longer be validated
        other = [json.loads(self.keys_json.read_text())["keys"][1]]
        keys2 = self.dir / "keys2.json"
        keys2.write_text(json.dumps({"keys": other}))
        os.chmod(keys2, 0o600)
        self.assertEqual(self.cli(keys=keys2), 2)
        self.assertNotIn("ctp.test_verified", [e.event_type for e in self.store.read_all()])

    def test_verification_is_single_shot_and_idempotent_refusal(self):
        self.assertEqual(self.cli(), 0)
        self.assertEqual(self.cli(), 2)         # nothing left to verify
        self.assertEqual([e.event_type for e in self.store.read_all()].count("ctp.test_verified"), 1)

    def test_runner_never_holds_the_verifier_key(self):
        text = (Path(O.__file__)).read_text()
        self.assertNotIn("load_signer", text)
        self.assertNotIn("verifier-key", text)

    def test_module_entry_point_runs_as_a_real_subprocess(self):
        env = {**os.environ, "PYTHONPATH": str(Path(O.__file__).parents[1])}
        r = subprocess.run([sys.executable, "-m", "master_brain.ctp_verify", "--data-dir", str(self.data),
                            "--approval-keys", str(self.keys_json), "--verifier-key", str(self.ver_key),
                            "--request-id", self.rid, "--passphrase-stdin"],
                           input=PASS + "\n", capture_output=True, text=True, env=env, timeout=120)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(json.loads(r.stdout)["final_ctp_status"], "pass")
        for secret in (PASS, "PRIVATE KEY"):
            self.assertNotIn(secret, r.stdout + r.stderr)


if __name__ == "__main__":
    unittest.main()
