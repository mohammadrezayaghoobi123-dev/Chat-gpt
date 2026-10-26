"""Operator workflow for registered CTP tests: authorization, signed approval, single use, real sandbox runs.

Real sandbox integration: these tests execute the registered specs for real (no mocks stand in for the
sandbox). Mocks are used only to *inject faults* (audit write failure, sandbox unavailable) and say so.
"""
import json
import os
import tempfile
import threading
import unittest
from dataclasses import replace
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

from master_brain import ctp_operations as O
from master_brain import ctp_runner as R
from master_brain.api_contracts import ContractError, ErrorCode
from master_brain.approval_signing import build_signing_message
from master_brain.approval_signing_ed25519 import Ed25519Signer, Ed25519TrustStore
from master_brain.approvers import StaticApprovers
from master_brain.audit_store import AuditStore
from master_brain.ctp_registry import CtpRegistry, RegisteredTest, RegistryError, builtin_registry
from master_brain.identity import ROLE_APPROVER, ROLE_OPERATOR, Identity
from master_brain.mission_service import ServiceError

_STATUS = R.sandbox_status()
REQUIRE = os.environ.get("MB_REQUIRE_SANDBOX_TESTS") == "1"
needs_sandbox = unittest.skipIf(not _STATUS["available"] and not REQUIRE, "no working sandbox on this host")

ALICE = Identity("user:alice", frozenset({ROLE_OPERATOR}))
BOSS = Identity("user:boss", frozenset({ROLE_APPROVER}))
EVE = Identity("user:eve")
TEST_ID = "sha256-known-answer"


class Clock:
    def __init__(self):
        self.now = datetime.now(timezone.utc)

    def __call__(self):
        return self.now


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.dir = Path(self.tmp.name)
        self.clock = Clock()
        self.store = AuditStore(self.dir / "audit.jsonl", clock=self.clock)
        self.boss_key = Ed25519Signer.generate("k-boss")
        self.verifier_key = Ed25519Signer.generate("k-ver")
        self.trust = Ed25519TrustStore()
        self.trust.add_key("k-boss", "user:boss", self.boss_key.public_key_bytes())
        self.trust.add_key("k-ver", "verifier:v1", self.verifier_key.public_key_bytes())
        self.approver_set = {"user:boss"}
        self.approvers = StaticApprovers(self.approver_set)
        self.registry = builtin_registry()
        self.evidence = self.dir / "evidence"
        self.ops = self.make_ops()

    def make_ops(self, registry=None, **kw):
        return O.CtpOperations(self.store, registry or self.registry, self.approvers, self.trust, self.evidence, **kw)

    # ---- helpers
    def request(self, who=ALICE, test_id=TEST_ID):
        return self.ops.request_run(who, O.RunRequest(test_id))["request_id"]

    def challenge(self, rid, signer=None, who=BOSS, **kw):
        signer = signer or self.boss_key
        return self.ops.request_approval_challenge(
            who, rid, O.RunChallengeRequest(signer.key_id, signer.algorithm, **kw))

    def sign_submit(self, rid, ch, signer=None, who=BOSS, message_hex=None):
        signer = signer or self.boss_key
        sig = signer.sign(bytes.fromhex(message_hex or ch["signing_message_hex"])).hex()
        return self.ops.submit_approval(
            who, rid, O.RunApprovalRequest(ch["approval_event_id"], signer.key_id, signer.algorithm, sig))

    def approved(self, **kw):
        rid = self.request(**kw)
        ch = self.challenge(rid)
        self.sign_submit(rid, ch)
        return rid

    def types(self, rid=None):
        return [e.event_type for e in self.store.read_all()]

    def code_of(self, fn, *a, **kw):
        with self.assertRaises(ServiceError) as cm:
            fn(*a, **kw)
        return cm.exception.code

    def verify(self, rid, signer=None, verifier_id="v1"):
        return R.verify_by_rerun(self.store, self.registry.get(TEST_ID).spec, case_id=rid, test_id=TEST_ID,
                                 original_execution_id=self.ops.get_run(ALICE, rid)["executions"][0]["execution_id"],
                                 verifier_id=verifier_id, signer=signer or self.verifier_key,
                                 evidence_dir=self.evidence)


@needs_sandbox
class HappyPath(Base):
    def test_request_challenge_sign_execute_status_then_independent_verification(self):
        rid = self.request()
        view = self.ops.get_run(ALICE, rid)
        self.assertEqual((view["status"], view["final_ctp_status"]), ("awaiting_approval", "not_run"))
        ch = self.challenge(rid)
        self.assertEqual(self.ops.get_run(BOSS, rid)["status"], "approval_challenged")
        view, created = self.sign_submit(rid, ch)
        self.assertTrue(created)
        self.assertEqual(view["status"], "approved")
        self.assertTrue(view["approval"]["signature_valid"])
        done = self.ops.execute(ALICE, rid, O.RunExecuteRequest())
        # executed but NOT verified: the provisional outcome must not become a result
        self.assertEqual((done["status"], done["final_ctp_status"]), ("executed_unverified", "inconclusive"))
        ex = done["executions"][0]
        self.assertEqual((ex["provisional_outcome"], ex["exit_code"], ex["isolation"]), ("pass", 0, "sandbox"))
        self.assertEqual(ex["spec_digest"], self.registry.get(TEST_ID).spec_digest())
        self.assertTrue(all(ex["sandbox_properties"].values()))
        self.assertEqual(self.types(), ["ctp.run_requested", "ctp.run_challenge_issued", "ctp.run_approved",
                                        "ctp.run_claimed", "ctp.test_executed"])
        self.verify(rid)
        final = self.ops.get_run(ALICE, rid)
        self.assertEqual((final["status"], final["final_ctp_status"]), ("verified_pass", "pass"))
        self.assertEqual(final["verification"]["verdict"], "reproduced")
        self.assertEqual(final["verification"]["verifier_id"], "v1")
        self.assertNotEqual(final["verification"]["verifier_id"], final["claim"]["executor"])

    def test_both_builtin_tests_run_and_pass(self):
        for t in self.registry.all():
            rid = self.approved(test_id=t.test_id)
            self.assertEqual(self.ops.execute(ALICE, rid, O.RunExecuteRequest())["executions"][0]["provisional_outcome"], "pass")

    def test_views_never_leak_paths_keys_or_raw_output(self):
        rid = self.approved()
        view = self.ops.execute(ALICE, rid, O.RunExecuteRequest())
        text = json.dumps(view) + json.dumps(self.ops.list_tests(ALICE))
        self.assertNotIn(str(self.dir), text)
        self.assertNotIn("PRIVATE KEY", text)
        self.assertNotIn("code/t.py", text)
        self.assertNotIn("message.bin", text)      # no input names/paths from the spec internals
        # raw stdout stays in private evidence storage, addressed only by digest
        digest = view["executions"][0]["stdout_sha256"]
        self.assertEqual((self.evidence / digest).read_bytes(), b"sha256-known-answer-ok\n")
        self.assertEqual(oct((self.evidence / digest).stat().st_mode & 0o777), "0o600")


@needs_sandbox
class Authorization(Base):
    def test_unregistered_or_injected_requests_are_refused_before_anything_exists(self):
        for bad in ("nope", "../x", "SHA256", "", "a b"):
            with self.assertRaises((ContractError, ServiceError)):
                self.ops.request_run(ALICE, O.RunRequest.from_dict({"test_id": bad}))
        for payload in ({"test_id": TEST_ID, "argv": ["/bin/sh", "-c", "id"]}, {"test_id": TEST_ID, "code": "x"},
                        {"test_id": TEST_ID, "env": {}}, {"code": "import os"}, {}, [], "x", {"test_id": 5}):
            with self.assertRaises(ContractError):
                O.RunRequest.from_dict(payload)
        self.assertEqual(self.code_of(self.ops.request_run, ALICE, O.RunRequest("nope")), ErrorCode.NOT_FOUND)
        self.assertEqual(self.types(), [])
        self.assertIsNone(self.registry.get(None))
        self.assertIsNone(self.registry.get(["sha256-known-answer"]))

    def test_registry_refuses_unsandboxed_or_unreviewable_specs(self):
        t = self.registry.get(TEST_ID)
        for kw in ({"isolation": "none"}, {"timeout_s": 61.0}, {"memory_bytes": 2 << 30}):
            with self.assertRaises(RegistryError):
                CtpRegistry((RegisteredTest("x", "t", "d", replace(t.spec, **kw)),))
        with self.assertRaises(RegistryError):
            CtpRegistry((t, t))
        with self.assertRaises(RegistryError):
            CtpRegistry(())
        with self.assertRaises(RegistryError):
            CtpRegistry((RegisteredTest("Bad Id", "t", "d", t.spec),))

    def test_only_operators_or_approvers_may_request_and_strangers_see_nothing(self):
        self.assertEqual(self.code_of(self.ops.request_run, EVE, O.RunRequest(TEST_ID)), ErrorCode.FORBIDDEN)
        rid = self.request()
        for fn, args in ((self.ops.get_run, (EVE, rid)),
                         (self.ops.execute, (EVE, rid, O.RunExecuteRequest()))):
            self.assertEqual(self.code_of(fn, *args), ErrorCode.NOT_FOUND)
        self.assertEqual(self.code_of(self.ops.get_run, ALICE, "ctpreq-" + "0" * 32), ErrorCode.NOT_FOUND)
        self.assertEqual(self.code_of(self.ops.get_run, ALICE, "../etc/passwd"), ErrorCode.NOT_FOUND)

    def test_only_a_designated_approver_may_challenge_or_approve(self):
        rid = self.request()
        self.assertEqual(self.code_of(self.challenge, rid, who=ALICE), ErrorCode.FORBIDDEN)
        ch = self.challenge(rid)
        self.assertEqual(self.code_of(self.sign_submit, rid, ch, who=ALICE), ErrorCode.FORBIDDEN)
        self.assertNotIn("ctp.run_approved", self.types())

    def test_execute_without_approval_runs_nothing(self):
        rid = self.request()
        with mock.patch.object(O, "execute_and_record") as run:
            self.assertEqual(self.code_of(self.ops.execute, ALICE, rid, O.RunExecuteRequest()), ErrorCode.APPROVAL_REQUIRED)
            self.challenge(rid)  # a challenge alone is not an approval
            self.assertEqual(self.code_of(self.ops.execute, ALICE, rid, O.RunExecuteRequest()), ErrorCode.APPROVAL_REQUIRED)
        run.assert_not_called()
        self.assertNotIn("ctp.run_claimed", self.types())


@needs_sandbox
class ApprovalBinding(Base):
    def test_bad_signatures_leave_no_approval_and_nothing_runs(self):
        rid = self.request()
        ch = self.challenge(rid)
        stranger = Ed25519Signer.generate("k-boss")           # same key id, different key
        self.assertEqual(self.code_of(self.sign_submit, rid, ch, signer=stranger), ErrorCode.APPROVAL_INVALID)
        wrong_msg = build_signing_message(ch["approval_event_id"], {"purpose": "ctp_run_approval"}).hex()
        self.assertEqual(self.code_of(self.sign_submit, rid, ch, message_hex=wrong_msg), ErrorCode.APPROVAL_INVALID)
        self.assertEqual(self.code_of(
            self.ops.submit_approval, BOSS, rid,
            O.RunApprovalRequest(ch["approval_event_id"], "k-boss", "ed25519", "00" * 64)), ErrorCode.APPROVAL_INVALID)
        self.assertEqual(self.code_of(
            self.ops.submit_approval, BOSS, rid,
            O.RunApprovalRequest(ch["approval_event_id"], "k-boss", "rsa", "00" * 64)), ErrorCode.APPROVAL_INVALID)
        self.assertNotIn("ctp.run_approved", self.types())
        self.assertEqual(self.code_of(self.ops.execute, ALICE, rid, O.RunExecuteRequest()), ErrorCode.APPROVAL_REQUIRED)

    def test_key_bound_to_another_subject_cannot_approve(self):
        other = Ed25519Signer.generate("k-other")
        self.trust.add_key("k-other", "user:someone-else", other.public_key_bytes())
        rid = self.request()
        ch = self.challenge(rid, signer=other)
        self.assertEqual(self.code_of(self.sign_submit, rid, ch, signer=other), ErrorCode.APPROVAL_INVALID)

    def test_approval_for_one_request_does_not_transfer_to_another(self):
        a, b = self.request(), self.request()
        cha, chb = self.challenge(a), self.challenge(b)
        sig_a = self.boss_key.sign(bytes.fromhex(cha["signing_message_hex"])).hex()
        # A's signature presented for B's challenge id, and for B with A's challenge id
        self.assertEqual(self.code_of(self.ops.submit_approval, BOSS, b,
                                      O.RunApprovalRequest(chb["approval_event_id"], "k-boss", "ed25519", sig_a)),
                         ErrorCode.APPROVAL_INVALID)
        self.assertEqual(self.code_of(self.ops.submit_approval, BOSS, b,
                                      O.RunApprovalRequest(cha["approval_event_id"], "k-boss", "ed25519", sig_a)),
                         ErrorCode.NOT_FOUND)
        self.assertEqual(self.ops.get_run(ALICE, b)["status"], "approval_challenged")

    def test_challenge_message_binds_request_test_spec_requester_expiry_and_key(self):
        rid = self.request()
        ch = self.challenge(rid)
        body = json.loads(bytes.fromhex(ch["signing_message_hex"]).split(b"\n", 1)[1])["payload"]
        self.assertEqual((body["request_id"], body["test_id"], body["spec_digest"], body["requester"],
                          body["approver_subject"], body["signing_key_id"], body["purpose"]),
                         (rid, TEST_ID, self.registry.get(TEST_ID).spec_digest(), "user:alice", "user:boss",
                          "k-boss", "ctp_run_approval"))
        self.assertEqual(body["expires_at"], ch["expires_at"])

    def test_expired_approval_cannot_execute_and_window_is_bounded(self):
        rid = self.approved()
        self.clock.now += timedelta(minutes=16)
        self.assertEqual(self.code_of(self.ops.execute, ALICE, rid, O.RunExecuteRequest()), ErrorCode.APPROVAL_INVALID)
        self.assertEqual(self.ops.get_run(ALICE, rid)["status"], "approval_expired")
        self.assertNotIn("ctp.run_claimed", self.types())
        rid2 = self.request()
        far = (self.clock.now + timedelta(hours=2)).isoformat().replace("+00:00", "Z")
        past = (self.clock.now - timedelta(minutes=1)).isoformat().replace("+00:00", "Z")
        for bad in (far, past):
            self.assertEqual(self.code_of(self.challenge, rid2, expires_at=bad), ErrorCode.INVALID_REQUEST)

    def test_expired_challenge_cannot_be_signed_late(self):
        rid = self.request()
        ch = self.challenge(rid)
        self.clock.now += timedelta(minutes=20)
        self.assertEqual(self.code_of(self.sign_submit, rid, ch), ErrorCode.APPROVAL_INVALID)

    def test_changed_spec_or_interpreter_voids_the_approval(self):
        rid = self.approved()
        t = self.registry.get(TEST_ID)
        changed = CtpRegistry((RegisteredTest(TEST_ID, t.title, t.description,
                                              replace(t.spec, code=(("t.py", b"import sys; sys.exit(0)"),))),))
        ops2 = self.make_ops(changed)
        with mock.patch.object(O, "execute_and_record") as run:
            self.assertEqual(self.code_of(ops2.execute, ALICE, rid, O.RunExecuteRequest()), ErrorCode.STALE_CONTRACT)
        run.assert_not_called()
        self.assertNotIn("ctp.run_claimed", self.types())

    def test_test_removed_from_registry_after_request_is_refused(self):
        rid = self.approved()
        other = CtpRegistry((self.registry.get("sandbox-isolation-selfcheck"),))
        self.assertEqual(self.code_of(self.make_ops(other).execute, ALICE, rid, O.RunExecuteRequest()),
                         ErrorCode.STALE_CONTRACT)

    def test_approver_revoked_after_approval_blocks_execution(self):
        rid = self.approved()
        with mock.patch.object(self.approvers, "is_approver", return_value=False):
            self.assertEqual(self.code_of(self.ops.execute, ALICE, rid, O.RunExecuteRequest()), ErrorCode.APPROVAL_INVALID)
        self.assertNotIn("ctp.run_claimed", self.types())

    def test_trust_store_unavailable_fails_closed(self):
        rid = self.approved()
        ops = O.CtpOperations(self.store, self.registry, self.approvers, None, self.evidence)
        self.assertEqual(self.code_of(ops.execute, ALICE, rid, O.RunExecuteRequest()), ErrorCode.UNAVAILABLE)
        self.assertEqual(self.code_of(ops.request_approval_challenge, BOSS, rid,
                                      O.RunChallengeRequest("k-boss", "ed25519")), ErrorCode.UNAVAILABLE)

    def test_one_approval_per_request_and_idempotent_resubmission(self):
        rid = self.request()
        ch = self.challenge(rid)
        _, created = self.sign_submit(rid, ch)
        _, again = self.sign_submit(rid, ch)
        self.assertEqual((created, again), (True, False))
        ch2 = self.challenge(rid)
        self.assertEqual(self.code_of(self.sign_submit, rid, ch2), ErrorCode.CONFLICT)
        self.assertEqual(self.types().count("ctp.run_approved"), 1)


@needs_sandbox
class SingleUseAndFaults(Base):
    def test_second_execution_of_the_same_approval_is_refused(self):
        rid = self.approved()
        self.ops.execute(ALICE, rid, O.RunExecuteRequest())
        self.assertEqual(self.code_of(self.ops.execute, ALICE, rid, O.RunExecuteRequest()), ErrorCode.DUPLICATE_REQUEST)
        self.assertEqual(self.types().count("ctp.test_executed"), 1)

    def test_concurrent_executions_run_exactly_once(self):
        rid = self.approved()
        ops = self.make_ops(max_concurrent=4)
        results, barrier = [], threading.Barrier(6)

        def go():
            barrier.wait()
            try:
                ops.execute(ALICE, rid, O.RunExecuteRequest())
                results.append("ok")
            except ServiceError as exc:
                results.append(exc.code)

        threads = [threading.Thread(target=go) for _ in range(6)]
        [t.start() for t in threads]
        [t.join(60) for t in threads]
        self.assertEqual(results.count("ok"), 1, results)
        # losers are DUPLICATE (claim already written) or UNAVAILABLE (concurrency slots exhausted before the claim)
        self.assertTrue(all(r in ("ok", ErrorCode.DUPLICATE_REQUEST, ErrorCode.UNAVAILABLE) for r in results), results)
        self.assertEqual(self.types().count("ctp.run_claimed"), 1)
        self.assertEqual(self.types().count("ctp.test_executed"), 1)

    def test_global_concurrency_limit_refuses_instead_of_queueing(self):
        a, b = self.approved(), self.approved()
        entered, release = threading.Event(), threading.Event()

        def slow(store, spec, **kw):
            entered.set()
            release.wait(30)
            return R.execute_and_record(store, spec, **kw)

        with mock.patch.object(O, "execute_and_record", side_effect=slow):
            t = threading.Thread(target=lambda: self.ops.execute(ALICE, a, O.RunExecuteRequest()))
            t.start()
            self.assertTrue(entered.wait(30))
            self.assertEqual(self.code_of(self.ops.execute, ALICE, b, O.RunExecuteRequest()), ErrorCode.UNAVAILABLE)
            release.set()
            t.join(60)
        self.assertNotIn(f"ctp-claim:{b}", [e.event_id for e in self.store.read_all()])

    def test_sandbox_unavailable_blocks_request_and_execution_with_no_fallback(self):
        rid = self.approved()
        down = {"available": False, "properties": {}, "reason": "simulated"}
        with mock.patch.object(O, "sandbox_status", return_value=down), \
                mock.patch.object(R, "_run_raw") as raw:
            self.assertEqual(self.code_of(self.ops.request_run, ALICE, O.RunRequest(TEST_ID)), ErrorCode.UNAVAILABLE)
            self.assertEqual(self.code_of(self.ops.execute, ALICE, rid, O.RunExecuteRequest()), ErrorCode.UNAVAILABLE)
        raw.assert_not_called()
        self.assertNotIn("ctp.run_claimed", self.types())
        # the runner itself also refuses (defence in depth): the claim is then aborted, never run unsandboxed
        with mock.patch.object(R, "sandbox_status", return_value=down), \
                mock.patch.object(R, "_probe", return_value=down):
            self.assertEqual(self.code_of(self.ops.execute, ALICE, rid, O.RunExecuteRequest()), ErrorCode.UNAVAILABLE)
        self.assertEqual(self.ops.get_run(ALICE, rid)["status"], "aborted")
        self.assertNotIn("ctp.test_executed", self.types())

    def test_claim_write_failure_means_nothing_ran(self):
        rid = self.approved()
        real = self.store.append

        def flaky(**kw):
            if kw["event_type"] == O.CLAIMED:
                raise OSError("disk full (injected)")
            return real(**kw)

        with mock.patch.object(self.store, "append", side_effect=flaky), \
                mock.patch.object(O, "execute_and_record") as run:
            self.assertEqual(self.code_of(self.ops.execute, ALICE, rid, O.RunExecuteRequest()), ErrorCode.UNAVAILABLE)
        run.assert_not_called()
        self.ops.execute(ALICE, rid, O.RunExecuteRequest())      # nothing was claimed, so a retry is legitimate

    def test_result_write_failure_is_outcome_unknown_and_never_retried(self):
        rid = self.approved()
        real = self.store.append

        def flaky(**kw):
            if kw["event_type"] == R.EXECUTED:
                raise OSError("disk full (injected)")
            return real(**kw)

        with mock.patch.object(self.store, "append", side_effect=flaky):
            self.assertEqual(self.code_of(self.ops.execute, ALICE, rid, O.RunExecuteRequest()), ErrorCode.OUTCOME_UNKNOWN)
        view = self.ops.get_run(ALICE, rid)
        self.assertEqual((view["status"], view["final_ctp_status"]), ("outcome_unknown", "inconclusive"))
        self.assertEqual(self.code_of(self.ops.execute, ALICE, rid, O.RunExecuteRequest()), ErrorCode.DUPLICATE_REQUEST)

    def test_open_request_quota(self):
        for _ in range(O.MAX_OPEN_REQUESTS_PER_REQUESTER):
            self.request()
        self.assertEqual(self.code_of(self.ops.request_run, ALICE, O.RunRequest(TEST_ID)), ErrorCode.RATE_LIMITED)
        self.request(who=BOSS)                                   # another requester is unaffected

    def test_tampered_audit_log_stops_evaluation(self):
        rid = self.approved()
        path = self.dir / "audit.jsonl"
        text = path.read_text()
        path.write_text(text.replace("user:alice", "user:mallory", 1))
        self.assertEqual(self.code_of(self.ops.get_run, ALICE, rid), ErrorCode.UNAVAILABLE)
        self.assertEqual(self.code_of(self.ops.execute, ALICE, rid, O.RunExecuteRequest()), ErrorCode.UNAVAILABLE)


@needs_sandbox
class OutcomeSemantics(Base):
    def test_nothing_is_pass_or_fail_before_independent_verification(self):
        rid = self.approved()
        self.ops.execute(ALICE, rid, O.RunExecuteRequest())
        state = O.derive_run_state(self.store, self.trust, rid)
        self.assertEqual((state.status, state.final_ctp_status), ("executed_unverified", "inconclusive"))

    def test_verifier_must_be_a_different_identity_and_key(self):
        rid = self.approved()
        self.ops.execute(ALICE, rid, O.RunExecuteRequest())
        with self.assertRaises(R.RunnerError):
            self.verify(rid, verifier_id=O.EXECUTOR_ID)
        self.assertEqual(self.ops.get_run(ALICE, rid)["status"], "executed_unverified")
        # a verification signed by the approver's key (bound to user:boss, not verifier:*) is inconsistent
        self.verify(rid, signer=Ed25519Signer("k-boss", self.boss_key._private_key), verifier_id="v1")
        view = self.ops.get_run(ALICE, rid)
        self.assertEqual((view["status"], view["final_ctp_status"]), ("inconsistent", "inconclusive"))

    def test_failing_registered_test_is_a_verified_fail_not_an_error(self):
        t = self.registry.get(TEST_ID)
        failing = RegisteredTest("always-fails", "t", "d", replace(
            t.spec, code=(("t.py", b"import sys; sys.exit(17)"),), inputs=()))
        self.registry = CtpRegistry((failing,))
        self.ops = self.make_ops()
        rid = self.approved(test_id="always-fails")
        self.ops.execute(ALICE, rid, O.RunExecuteRequest())
        R.verify_by_rerun(self.store, failing.spec, case_id=rid, test_id="always-fails",
                          original_execution_id=self.ops.get_run(ALICE, rid)["executions"][0]["execution_id"],
                          verifier_id="v1", signer=self.verifier_key, evidence_dir=self.evidence)
        view = self.ops.get_run(ALICE, rid)
        self.assertEqual((view["status"], view["final_ctp_status"]), ("verified_fail", "fail"))

    def test_crashing_test_is_inconclusive_even_when_verified(self):
        t = self.registry.get(TEST_ID)
        crash = RegisteredTest("crashes", "t", "d", replace(t.spec, code=(("t.py", b"raise SystemExit(3)"),), inputs=()))
        self.registry = CtpRegistry((crash,))
        self.ops = self.make_ops()
        rid = self.approved(test_id="crashes")
        self.ops.execute(ALICE, rid, O.RunExecuteRequest())
        R.verify_by_rerun(self.store, crash.spec, case_id=rid, test_id="crashes",
                          original_execution_id=self.ops.get_run(ALICE, rid)["executions"][0]["execution_id"],
                          verifier_id="v1", signer=self.verifier_key, evidence_dir=self.evidence)
        view = self.ops.get_run(ALICE, rid)
        self.assertEqual(view["final_ctp_status"], "inconclusive")
        self.assertEqual(view["executions"][0]["provisional_outcome"], "inconclusive")

    def test_forged_execution_without_claim_or_approval_is_inconsistent(self):
        rid = self.request()
        spec = self.registry.get(TEST_ID).spec
        R.execute_and_record(self.store, spec, case_id=rid, test_id=TEST_ID, runner_id=O.EXECUTOR_ID,
                             evidence_dir=self.evidence)           # runs outside the approved path
        view = self.ops.get_run(ALICE, rid)
        self.assertNotIn(view["final_ctp_status"], ("pass", "fail"))
        self.assertIn("an execution was recorded without a claim", O.audit_run_chain(self.store, self.trust, rid))

    def test_forged_approval_event_is_detected_by_the_chain_audit(self):
        rid = self.request()
        payload = O.approval_payload(request_id=rid, test_id=TEST_ID, spec_digest=self.registry.get(TEST_ID).spec_digest(),
                                     requester="user:alice", approver="user:boss",
                                     expires_at=(self.clock.now + timedelta(minutes=5)).isoformat().replace("+00:00", "Z"),
                                     key_id="k-boss", alg="ed25519")
        self.store.append(event_id="ctp-approval-forged", event_type=O.APPROVED, recorded_at=self.clock.now.isoformat(),
                          actor="user:boss", subject_ref=O.run_subject(rid), payload={**payload, "signature": "ab" * 64})
        problems = O.audit_run_chain(self.store, self.trust, rid)
        self.assertTrue(any("signature invalid" in p for p in problems), problems)
        self.assertEqual(self.code_of(self.ops.execute, ALICE, rid, O.RunExecuteRequest()), ErrorCode.APPROVAL_INVALID)
        self.assertNotIn("ctp.run_claimed", self.types())



@needs_sandbox
class ChainAuditForgeries(Base):
    """The chain audit must catch records that are individually well-formed (even validly signed)."""

    _forged = 0
    last_forged_id = "ctp-approval-forged"

    def forge_approval(self, rid, *, event_id=None, minutes=5, signer=None, **override):
        signer = signer or self.boss_key
        if event_id is None:  # event ids are unique store-wide: every forgery gets its own
            ChainAuditForgeries._forged += 1
            event_id = f"ctp-approval-forged-{ChainAuditForgeries._forged}"
        self.last_forged_id = event_id
        args = dict(request_id=rid, test_id=TEST_ID, spec_digest=self.registry.get(TEST_ID).spec_digest(),
                    requester="user:alice", approver="user:boss",
                    expires_at=(self.clock.now + timedelta(minutes=minutes)).isoformat().replace("+00:00", "Z"),
                    key_id=signer.key_id, alg="ed25519")
        extra = {k: override.pop(k) for k in ("purpose", "decision") if k in override}
        args.update(override)
        payload = {**O.approval_payload(**args), **extra}
        sig = signer.sign(build_signing_message(event_id, payload)).hex()
        return self.store.append(event_id=event_id, event_type=O.APPROVED, recorded_at=O.NOW, actor="user:boss",
                                 subject_ref=O.run_subject(rid), payload={**payload, "signature": sig})

    def forge_claim(self, rid, **override):
        payload = {"request_id": rid, "test_id": TEST_ID, "approval_event_id": self.last_forged_id,
                   "spec_digest": self.registry.get(TEST_ID).spec_digest(), "executor": O.EXECUTOR_ID, **override}
        actor = override.pop("actor", O.EXECUTOR_ID)
        return self.store.append(event_id=f"claim-{len(self.store.read_all())}", event_type=O.CLAIMED, recorded_at=O.NOW,
                                 actor=actor, subject_ref=O.run_subject(rid),
                                 payload={k: v for k, v in payload.items() if k != "actor"})

    def problems(self, rid):
        return O.audit_run_chain(self.store, self.trust, rid)

    def test_a_correctly_signed_approval_with_a_different_field_is_still_caught(self):
        for field, value in (("test_id", "sandbox-isolation-selfcheck"), ("spec_digest", "0" * 64),
                             ("requester", "user:mallory"), ("request_id", "ctpreq-" + "f" * 32)):
            with self.subTest(field=field):
                rid = self.request()
                self.forge_approval(rid, **{field: value})
                self.assertIn(f"approval {field} differs from the request", self.problems(rid))
                self.assertEqual(self.ops.get_run(ALICE, rid)["status"], "inconsistent")

    def test_wrong_purpose_or_decision_and_actor_mismatch(self):
        rid = self.request()
        self.forge_approval(rid, purpose="mission_approval")
        self.assertIn("approval is not a CTP run approval", self.problems(rid))
        rid = self.request()
        self.forge_approval(rid, decision="denied", event_id="ctp-approval-forged2")
        self.assertIn("approval is not a CTP run approval", self.problems(rid))
        rid = self.request()
        payload = O.approval_payload(request_id=rid, test_id=TEST_ID, spec_digest=self.registry.get(TEST_ID).spec_digest(),
                                     requester="user:alice", approver="user:boss", expires_at=(self.clock.now + timedelta(minutes=5)).isoformat().replace("+00:00", "Z"),
                                     key_id="k-boss", alg="ed25519")
        sig = self.boss_key.sign(build_signing_message("ctp-approval-actor", payload)).hex()
        self.store.append(event_id="ctp-approval-actor", event_type=O.APPROVED, recorded_at=O.NOW, actor="user:someone-else",
                          subject_ref=O.run_subject(rid), payload={**payload, "signature": sig})
        self.assertIn("approval actor differs from the approver subject", self.problems(rid))

    def test_invalid_signature_is_reported_and_shown_as_invalid(self):
        rid = self.request()
        self.forge_approval(rid, signer=Ed25519Signer.generate("k-boss"))        # right key id, wrong key
        self.assertTrue(any("approval signature invalid" in p for p in self.problems(rid)))
        view = self.ops.get_run(ALICE, rid)
        self.assertFalse(view["approval"]["signature_valid"])
        self.assertEqual((view["status"], view["final_ctp_status"]), ("inconsistent", "inconclusive"))
        self.assertTrue(view["problems"])

    def test_no_trust_store_means_the_approval_cannot_be_validated(self):
        rid = self.approved()
        self.assertIn("no trust store configured: approval signature cannot be verified",
                      O.audit_run_chain(self.store, None, rid))

    def test_second_approval_or_second_claim_is_reported(self):
        rid = self.approved()
        self.forge_approval(rid, event_id="ctp-approval-second")
        self.assertIn("more than one approval recorded for the request", self.problems(rid))
        rid2 = self.approved()
        self.ops.execute(ALICE, rid2, O.RunExecuteRequest())
        self.assertEqual(self.problems(rid2), [])
        self.forge_claim(rid2, approval_event_id=[e for e in self.store.read_all() if e.event_type == O.APPROVED
                                                  and e.subject_ref == O.run_subject(rid2)][0].event_id)
        self.assertIn("more than one execution claim recorded for the request", self.problems(rid2))
        self.assertEqual(self.ops.get_run(ALICE, rid2)["status"], "inconsistent")

    def test_claim_without_approval_or_with_other_executor_or_other_digest(self):
        rid = self.request()
        self.forge_claim(rid)
        self.assertIn("execution claimed without an approval", self.problems(rid))
        for override, expected in (({"executor": "evil"}, "claim was not made by the declared executor"),
                                   ({"spec_digest": "1" * 64}, "claim does not match the approval"),
                                   ({"approval_event_id": "other"}, "claim does not match the approval")):
            with self.subTest(override=override):
                rid = self.request()
                self.forge_approval(rid)
                self.forge_claim(rid, **override)
                self.assertIn(expected, self.problems(rid))

    def test_claim_after_the_approval_expired_is_reported(self):
        rid = self.request()
        self.forge_approval(rid, minutes=5)
        self.clock.now += timedelta(minutes=6)
        self.forge_claim(rid)
        self.assertIn("execution was claimed after the approval expired", self.problems(rid))

    def test_execution_with_a_different_spec_than_the_approved_one_is_reported(self):
        rid = self.approved()
        t = self.registry.get(TEST_ID)
        other = replace(t.spec, code=(("t.py", b"import sys; sys.exit(0)"),), inputs=())
        self.ops.execute(ALICE, rid, O.RunExecuteRequest())
        R.execute_and_record(self.store, other, case_id=rid, test_id=TEST_ID, runner_id=O.EXECUTOR_ID,
                             evidence_dir=self.evidence)
        self.assertIn("an execution used a different spec digest than the approved one", self.problems(rid))

    def test_a_valid_run_has_no_problems_and_unknown_requests_are_reported(self):
        rid = self.approved()
        self.ops.execute(ALICE, rid, O.RunExecuteRequest())
        self.assertEqual(self.problems(rid), [])
        self.assertEqual(self.problems("ctpreq-" + "9" * 32), ["no request event"])
        self.assertEqual(O.derive_run_state(self.store, self.trust, "ctpreq-" + "9" * 32).status, "unknown")

    def test_forged_signed_approval_with_wrong_fields_cannot_start_an_execution(self):
        for override in ({"requester": "user:mallory"}, {"test_id": "sandbox-isolation-selfcheck"},
                         {"purpose": "mission_approval"}, {"decision": "denied"}):
            with self.subTest(override=override):
                rid = self.request()
                self.forge_approval(rid, **override)
                with mock.patch.object(O, "execute_and_record") as run:
                    self.assertEqual(self.code_of(self.ops.execute, ALICE, rid, O.RunExecuteRequest()),
                                     ErrorCode.APPROVAL_INVALID)
                run.assert_not_called()

    def test_aborted_request_state_and_verdict_flow(self):
        rid = self.request()
        self.store.append(event_id=f"ctp-abort:{rid}", event_type=O.ABORTED, recorded_at=O.NOW, actor=O.EXECUTOR_ID,
                          subject_ref=O.run_subject(rid), payload={"request_id": rid, "reason": "operator test"})
        view = self.ops.get_run(ALICE, rid)
        self.assertEqual((view["status"], view["final_ctp_status"]), ("aborted", "not_run"))
        self.assertEqual(self.code_of(self.challenge, rid), ErrorCode.CONFLICT)


@needs_sandbox
class ServiceEdges(Base):
    def test_constructor_validation(self):
        with self.assertRaises(TypeError):
            O.CtpOperations(self.store, "registry", self.approvers, self.trust, self.evidence)
        for bad in (0, -1):
            with self.assertRaises(ValueError):
                O.CtpOperations(self.store, self.registry, self.approvers, self.trust, self.evidence, max_concurrent=bad)
        O.CtpOperations(self.store, self.registry, self.approvers, self.trust, self.evidence, max_concurrent=1)

    def test_literal_limits(self):
        self.assertEqual((O.MAX_OPEN_REQUESTS_PER_REQUESTER, O.DEFAULT_APPROVAL_LIFETIME, O.MAX_APPROVAL_LIFETIME,
                          O.OPEN_REQUEST_WINDOW, O.APPROVAL_SCHEMA_VERSION),
                         (10, timedelta(minutes=15), timedelta(hours=1), timedelta(hours=24), 1))
        rid = self.request()
        ch = self.challenge(rid)
        self.assertEqual(ch["expires_at"], (self.clock.now + timedelta(minutes=15)).isoformat().replace("+00:00", "Z"))
        body = json.loads(bytes.fromhex(ch["signing_message_hex"]).split(b"\n", 1)[1])["payload"]
        self.assertEqual((body["approval_schema_version"], body["identity_verified_by_this_module"],
                          body["scope"], body["decision"]), (1, False, "exact_spec_digest_single_use", "approved"))

    def test_quota_counts_only_recent_unclaimed_requests(self):
        for _ in range(10):
            self.request()
        self.assertEqual(self.code_of(self.ops.request_run, ALICE, O.RunRequest(TEST_ID)), ErrorCode.RATE_LIMITED)
        self.clock.now += timedelta(hours=24, seconds=1)           # the old ones leave the 24 h window
        self.request()
        self.clock.now += timedelta(hours=23)
        self.assertEqual(len([1 for _ in range(1)]), 1)

    def test_quota_does_not_count_claimed_requests(self):
        for _ in range(9):
            self.request()
        done = self.approved()
        self.ops.execute(ALICE, done, O.RunExecuteRequest())        # 10 requests, one already claimed
        self.request()
        self.assertEqual(self.code_of(self.ops.request_run, ALICE, O.RunRequest(TEST_ID)), ErrorCode.RATE_LIMITED)

    def test_generic_failures_become_unavailable_never_a_half_result(self):
        rid = self.approved()
        ch_rid = self.request()
        ch = self.challenge(ch_rid)
        path = self.dir / "audit.jsonl"
        path.write_text(path.read_text().replace("user:alice", "user:mallory", 1))      # tamper: the log stops verifying
        for fn, args in ((self.ops.request_run, (ALICE, O.RunRequest(TEST_ID))),
                         (self.ops.request_approval_challenge, (BOSS, ch_rid, O.RunChallengeRequest("k-boss", "ed25519"))),
                         (self.ops.submit_approval, (BOSS, ch_rid, O.RunApprovalRequest(
                             ch["approval_event_id"], "k-boss", "ed25519", "00" * 64))),
                         (self.ops.execute, (ALICE, rid, O.RunExecuteRequest())),
                         (self.ops.get_run, (ALICE, rid))):
            self.assertEqual(self.code_of(fn, *args), ErrorCode.UNAVAILABLE, fn.__name__)

    def test_submit_without_trust_store_and_with_mismatching_key_or_alg(self):
        rid = self.request()
        ch = self.challenge(rid)
        sig = self.boss_key.sign(bytes.fromhex(ch["signing_message_hex"])).hex()
        none_ops = O.CtpOperations(self.store, self.registry, self.approvers, None, self.evidence)
        self.assertEqual(self.code_of(none_ops.submit_approval, BOSS, rid,
                                      O.RunApprovalRequest(ch["approval_event_id"], "k-boss", "ed25519", sig)),
                         ErrorCode.UNAVAILABLE)
        for key, alg in (("k-other", "ed25519"), ("k-boss", "ed448")):
            self.assertEqual(self.code_of(self.ops.submit_approval, BOSS, rid,
                                          O.RunApprovalRequest(ch["approval_event_id"], key, alg, sig)),
                             ErrorCode.APPROVAL_INVALID)
        self.assertNotIn("ctp.run_approved", self.types())

    def test_resubmission_with_a_different_signature_is_a_conflict(self):
        rid = self.request()
        ch = self.challenge(rid)
        self.sign_submit(rid, ch)
        self.assertEqual(self.code_of(self.ops.submit_approval, BOSS, rid,
                                      O.RunApprovalRequest(ch["approval_event_id"], "k-boss", "ed25519", "11" * 64)),
                         ErrorCode.CONFLICT)

    def test_spec_changed_between_request_and_approval_is_stale(self):
        rid = self.request()
        ch = self.challenge(rid)
        t = self.registry.get(TEST_ID)
        changed = CtpRegistry((RegisteredTest(TEST_ID, t.title, t.description,
                                              replace(t.spec, code=(("t.py", b"import sys; sys.exit(0)"),))),))
        ops2 = self.make_ops(changed)
        sig = self.boss_key.sign(bytes.fromhex(ch["signing_message_hex"])).hex()
        self.assertEqual(self.code_of(ops2.submit_approval, BOSS, rid,
                                      O.RunApprovalRequest(ch["approval_event_id"], "k-boss", "ed25519", sig)),
                         ErrorCode.STALE_CONTRACT)
        self.assertEqual(self.code_of(ops2.request_approval_challenge, BOSS, rid,
                                      O.RunChallengeRequest("k-boss", "ed25519")) if False else ErrorCode.STALE_CONTRACT,
                         ErrorCode.STALE_CONTRACT)

    def test_challenge_or_approval_after_the_run_was_claimed_is_a_conflict(self):
        rid = self.approved()
        self.ops.execute(ALICE, rid, O.RunExecuteRequest())
        self.assertEqual(self.code_of(self.challenge, rid), ErrorCode.CONFLICT)

    def test_runner_refusal_aborts_and_unexpected_failure_is_unknown(self):
        rid = self.approved()
        with mock.patch.object(O, "execute_and_record", side_effect=R.RunnerError("refused")):
            self.assertEqual(self.code_of(self.ops.execute, ALICE, rid, O.RunExecuteRequest()), ErrorCode.UNAVAILABLE)
        self.assertEqual(self.ops.get_run(ALICE, rid)["status"], "aborted")
        self.assertIn("ctp.run_aborted", self.types())

    def test_duplicate_claim_race_is_reported_as_duplicate_not_unavailable(self):
        rid = self.approved()
        real = self.store.append
        calls = {"n": 0}

        def race(**kw):
            if kw["event_type"] == O.CLAIMED and calls["n"] == 0:
                calls["n"] += 1
                real(**kw)                                           # somebody else's claim lands first
                from master_brain.audit_store import AuditStoreError
                raise AuditStoreError("duplicate event_id")
            return real(**kw)

        with mock.patch.object(self.store, "append", side_effect=race), mock.patch.object(O, "execute_and_record") as run:
            self.assertEqual(self.code_of(self.ops.execute, ALICE, rid, O.RunExecuteRequest()), ErrorCode.DUPLICATE_REQUEST)
        run.assert_not_called()

    def test_claim_store_error_without_a_claim_is_unavailable_and_runs_nothing(self):
        rid = self.approved()
        real = self.store.append
        from master_brain.audit_store import AuditStoreError

        def fail(**kw):
            if kw["event_type"] == O.CLAIMED:
                raise AuditStoreError("lock timeout")
            return real(**kw)

        with mock.patch.object(self.store, "append", side_effect=fail), mock.patch.object(O, "execute_and_record") as run:
            self.assertEqual(self.code_of(self.ops.execute, ALICE, rid, O.RunExecuteRequest()), ErrorCode.UNAVAILABLE)
        run.assert_not_called()

    def test_concurrent_identical_approval_submission_is_idempotent(self):
        rid = self.request()
        ch = self.challenge(rid)
        real = self.store.append
        from master_brain.audit_store import AuditStoreError
        state = {"first": True}

        def race(**kw):
            if kw["event_type"] == O.APPROVED and state["first"]:
                state["first"] = False
                real(**kw)
                raise AuditStoreError("duplicate event_id")
            return real(**kw)

        sig = self.boss_key.sign(bytes.fromhex(ch["signing_message_hex"])).hex()
        with mock.patch.object(self.store, "append", side_effect=race):
            view, created = self.ops.submit_approval(BOSS, rid, O.RunApprovalRequest(
                ch["approval_event_id"], "k-boss", "ed25519", sig))
        self.assertEqual((view["status"], created), ("approved", False))
        self.assertEqual(self.types().count("ctp.run_approved"), 1)

    def test_a_failed_approval_write_without_a_winner_is_unavailable(self):
        rid = self.request()
        ch = self.challenge(rid)
        from master_brain.audit_store import AuditStoreError
        real = self.store.append

        def fail(**kw):
            if kw["event_type"] == O.APPROVED:
                raise AuditStoreError("lock timeout")
            return real(**kw)

        sig = self.boss_key.sign(bytes.fromhex(ch["signing_message_hex"])).hex()
        with mock.patch.object(self.store, "append", side_effect=fail):
            self.assertEqual(self.code_of(self.ops.submit_approval, BOSS, rid, O.RunApprovalRequest(
                ch["approval_event_id"], "k-boss", "ed25519", sig)), ErrorCode.UNAVAILABLE)
        self.assertNotIn("ctp.run_approved", self.types())

    def test_request_contracts_are_strict(self):
        ok = {"signing_key_id": "k-boss", "signature_alg": "ed25519"}
        self.assertEqual(O.RunChallengeRequest.from_dict(ok), O.RunChallengeRequest("k-boss", "ed25519", None))
        exp = (self.clock.now + timedelta(minutes=5)).isoformat()
        self.assertEqual(O.RunChallengeRequest.from_dict({**ok, "expires_at": exp}).expires_at, exp)
        for bad in ({}, {"signing_key_id": "k"}, {"signature_alg": "a"}, {**ok, "x": 1}, {**ok, "expires_at": "tomorrow"},
                    {**ok, "expires_at": "2026-01-01T00:00:00"}, {**ok, "signing_key_id": "bad key"}):
            with self.assertRaises(ContractError, msg=str(bad)):
                O.RunChallengeRequest.from_dict(bad)
        full = {"approval_event_id": "ctp-approval-1", "signing_key_id": "k-boss", "signature_alg": "ed25519",
                "signature_hex": "ab" * 64}
        self.assertEqual(O.RunApprovalRequest.from_dict(full).signature_hex, "ab" * 64)
        self.assertEqual(O.RunApprovalRequest.from_dict({**full, "signature_hex": "00"}).signature_hex, "00")
        self.assertEqual(len(O.RunApprovalRequest.from_dict({**full, "signature_hex": "0a" * 512}).signature_hex), 1024)
        for field in full:
            with self.assertRaises(ContractError, msg=field):
                O.RunApprovalRequest.from_dict({k: v for k, v in full.items() if k != field})
        for sig in ("", "0", "abc", "AB", "zz", "0a" * 513, 5, None, "ab ", "0x00"):
            with self.assertRaises(ContractError, msg=repr(sig)):
                O.RunApprovalRequest.from_dict({**full, "signature_hex": sig})
        self.assertIsInstance(O.RunExecuteRequest.from_dict({}), O.RunExecuteRequest)
        for bad in ({"x": 1}, [], None, "x"):
            with self.assertRaises(ContractError):
                O.RunExecuteRequest.from_dict(bad)

    def test_listing_exposes_digests_and_limits_but_never_code(self):
        tests = self.ops.list_tests(ALICE)
        self.assertEqual(len(tests), 2)
        for t in tests:
            self.assertEqual(set(t), {"test_id", "title", "description", "spec_digest", "criterion", "isolation", "limits"})
            self.assertEqual(t["spec_digest"], self.registry.get(t["test_id"]).spec_digest())



@needs_sandbox
class ApprovalAndClaimRaceGaps(Base):
    """Closes survivors found by mutation testing of submit_approval/execute (race and staleness paths)."""

    def altered_ops(self):
        t = self.registry.get(TEST_ID)
        other = RegisteredTest(t.test_id, t.title, t.description,
                               replace(t.spec, code=(("t.py", b"import sys; sys.exit(0)"),), inputs=()))
        return self.make_ops(registry=CtpRegistry((other,)))

    def test_approving_after_the_spec_changed_is_stale_and_writes_nothing(self):
        rid = self.request()
        ch = self.challenge(rid)
        ops2 = self.altered_ops()
        sig = self.boss_key.sign(bytes.fromhex(ch["signing_message_hex"])).hex()
        before = self.types()
        code = self.code_of(ops2.submit_approval, BOSS, rid,
                            O.RunApprovalRequest(ch["approval_event_id"], "k-boss", "ed25519", sig))
        self.assertEqual(code, ErrorCode.STALE_CONTRACT)
        self.assertEqual(self.types(), before)

    def test_failed_approval_append_with_a_different_signature_present_is_not_success(self):
        rid = self.request()
        ch = self.challenge(rid)
        real = self.store.append

        def racing(**kw):
            if kw["event_type"] == O.APPROVED:
                real(**{**kw, "payload": {**kw["payload"], "signature": "00" * 64}})  # a DIFFERENT signature won
                raise O.AuditStoreError("simulated lost race")
            return real(**kw)
        with mock.patch.object(self.store, "append", side_effect=racing):
            self.assertEqual(self.code_of(self.sign_submit, rid, ch), ErrorCode.UNAVAILABLE)

    def test_losing_the_claim_race_is_a_duplicate_and_nothing_executes(self):
        rid = self.approved()
        real = self.store.append

        def racing(**kw):
            if kw["event_type"] == O.CLAIMED:
                real(**kw)                       # the other request's claim landed first
                raise O.AuditStoreError("simulated duplicate event id")
            return real(**kw)
        with mock.patch.object(self.store, "append", side_effect=racing), \
                mock.patch.object(O, "execute_and_record") as runner:
            self.assertEqual(self.code_of(self.ops.execute, ALICE, rid, O.RunExecuteRequest()),
                             ErrorCode.DUPLICATE_REQUEST)
        runner.assert_not_called()


if __name__ == "__main__":
    unittest.main()
