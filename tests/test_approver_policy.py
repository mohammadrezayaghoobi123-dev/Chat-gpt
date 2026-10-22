"""Gate 2c-3: approval is a designated duty (only an approver may approve), checked at approval AND at execution."""
import tempfile
import unittest
from pathlib import Path

from master_brain.accounts import AccountStore
from master_brain.approvers import AccountApprovers, NoApprovers, StaticApprovers
from master_brain.identity import ROLE_APPROVER, Identity
from tests.approval_signing_helper import TEST_ALGORITHM, HmacSeamSigner, HmacSeamVerifier
from tests.test_http_api import ALICE, BOB, OPS, KEY, Running
from tests.test_http_approvals import ACTION, SECRET_A, SECRET_B, FakeClock
from tests.test_http_execution import ExecBase

PW = "correct horse battery"


class Switchable:
    """A policy that can change while the server runs (models a role being revoked)."""
    def __init__(self, *subjects):
        self.subjects = set(subjects)

    def is_approver(self, subject):
        return subject in self.subjects


class PolicyUnits(unittest.TestCase):
    def test_no_approvers_approves_nobody(self):
        self.assertIs(NoApprovers().is_approver("user:alice"), False)

    def test_static_approvers(self):
        policy = StaticApprovers({"user:alice"})
        self.assertTrue(policy.is_approver("user:alice"))
        self.assertFalse(policy.is_approver("user:bob"))
        self.assertFalse(policy.is_approver(None))
        with self.assertRaises(ValueError):
            StaticApprovers({"bad subject!"})

    def test_active_roles_refuses_malformed_subjects_with_an_empty_set(self):
        with tempfile.TemporaryDirectory() as tmp:
            accounts = AccountStore(Path(tmp) / "a.sqlite")
            longest = "u" * 128
            accounts.create_account(longest, PW, roles=(ROLE_APPROVER,))
            self.assertEqual(accounts.active_roles(longest), frozenset({ROLE_APPROVER}))
            for bad in (123, None, b"user:x", "u" * 129):
                self.assertEqual(accounts.active_roles(bad), frozenset(), bad)
                self.assertIsInstance(accounts.active_roles(bad), frozenset)
            self.assertIs(AccountApprovers(accounts).is_approver(123), False)

    def test_account_approvers_follow_the_live_role(self):
        with tempfile.TemporaryDirectory() as tmp:
            accounts = AccountStore(Path(tmp) / "a.sqlite")
            accounts.create_account("user:boss", PW, roles=(ROLE_APPROVER,))
            accounts.create_account("user:staff", PW)
            policy = AccountApprovers(accounts)
            self.assertTrue(policy.is_approver("user:boss"))
            self.assertFalse(policy.is_approver("user:staff"))
            self.assertFalse(policy.is_approver("user:nobody"))
            accounts.set_roles("user:boss", ())
            self.assertFalse(policy.is_approver("user:boss"))
            accounts.set_roles("user:boss", (ROLE_APPROVER,))
            accounts.set_disabled("user:boss", True)
            self.assertFalse(policy.is_approver("user:boss"))
            self.assertEqual(accounts.active_roles("user:boss"), frozenset())
            self.assertEqual(Identity("user:x", frozenset({ROLE_APPROVER})).is_approver, True)


class ServiceLevel(unittest.TestCase):
    def test_a_failing_policy_raises_a_service_error_never_returns_a_value(self):
        from master_brain.api_contracts import ErrorCode
        from master_brain.audit_store import AuditStore
        from master_brain.mission_service import MissionService, ServiceError

        class Broken:
            def is_approver(self, subject):
                raise RuntimeError("down")
        with tempfile.TemporaryDirectory() as tmp:
            service = MissionService(AuditStore(Path(tmp) / "a.jsonl"), approvers=Broken())
            with self.assertRaises(ServiceError) as ctx:
                service.list_pending_approvals(Identity("user:alice"))
            self.assertIs(ctx.exception.code, ErrorCode.UNAVAILABLE)


class AccountCli(unittest.TestCase):
    def run_cli(self, db, *argv, stdin=""):
        import io
        from contextlib import redirect_stderr, redirect_stdout
        from unittest import mock
        from master_brain import accounts
        out, err = io.StringIO(), io.StringIO()
        with mock.patch("sys.stdin", io.StringIO(stdin)), redirect_stdout(out), redirect_stderr(err):
            code = accounts._main(["--db", str(db), *argv])
        return code, out.getvalue().strip(), err.getvalue().strip()

    def test_roles_can_be_granted_replaced_and_removed_by_the_operator_tool(self):
        with tempfile.TemporaryDirectory() as tmp:
            db = Path(tmp) / "a.sqlite"
            store = AccountStore(db)
            self.assertEqual(self.run_cli(db, "add", "--subject", "user:boss", "--approver", "--password-stdin",
                                          stdin=PW + "\n")[:2], (0, "ok"))
            self.assertEqual(store.active_roles("user:boss"), frozenset({"approver"}))
            self.assertEqual(self.run_cli(db, "roles", "--subject", "user:boss", "--operator")[:2], (0, "ok"))
            self.assertEqual(store.active_roles("user:boss"), frozenset({"operator"}))  # exact set, not additive
            self.assertEqual(self.run_cli(db, "roles", "--subject", "user:boss", "--operator", "--approver")[0], 0)
            self.assertEqual(store.active_roles("user:boss"), frozenset({"operator", "approver"}))
            self.assertEqual(self.run_cli(db, "roles", "--subject", "user:boss")[0], 0)
            self.assertEqual(store.active_roles("user:boss"), frozenset())
            code, _, err = self.run_cli(db, "roles", "--subject", "user:ghost", "--approver")
            self.assertEqual(code, 1)
            self.assertTrue(err.startswith("error:"))


class Base(unittest.TestCase):
    def start(self, policy):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.clock = FakeClock()
        self.verifier = HmacSeamVerifier()
        self.verifier.add("k-alice", SECRET_A, "user:alice")
        self.verifier.add("k-bob", SECRET_B, "user:bob")
        self.app = Running(Path(self.tmp.name) / "audit.jsonl", self.verifier, self.clock, approvers=policy)
        self.addCleanup(self.app.close)

    def mission(self, token=ALICE):
        status, _, view = self.app.json("POST", "/v1/missions", {
            "idempotency_key": KEY, "objective": "Pay supplier", "success_criteria": ["receipt"],
            "risk_tier": "high"}, token=token)
        self.assertEqual(status, 201, view)
        return view

    def challenge(self, view, token, key_id):
        return self.app.json("POST", f"/v1/missions/{view['mission_id']}/approval-challenges", {
            "contract_digest": view["contract_digest"], "signing_key_id": key_id,
            "signature_alg": TEST_ALGORITHM, "action_digest": ACTION}, token=token)

    def submit(self, view, ch, token, key_id, secret):
        signer = HmacSeamSigner(key_id, secret)
        return self.app.json("POST", f"/v1/missions/{view['mission_id']}/approvals", {
            "idempotency_key": "submit-" + ch["approval_event_id"][-12:],
            "approval_event_id": ch["approval_event_id"], "signing_key_id": key_id,
            "signature_alg": TEST_ALGORITHM,
            "signature_hex": signer.sign(bytes.fromhex(ch["signing_message_hex"])).hex()}, token=token)

    def get(self, view, token=ALICE, suffix=""):
        return self.app.json("GET", f"/v1/missions/{view['mission_id']}{suffix}", token=token)

    @staticmethod
    def code(response):
        return response[0], response[2].get("error", {}).get("code")


class DesignatedApprover(Base):
    def test_a_designated_approver_who_is_not_the_owner_can_approve_and_the_owner_sees_it(self):
        self.start(StaticApprovers({"user:bob"}))
        view = self.mission(ALICE)
        status, _, ch = self.challenge(view, BOB, "k-bob")
        self.assertEqual(status, 201, ch)
        status, _, done = self.submit(view, ch, BOB, "k-bob", SECRET_B)
        self.assertEqual((status, done["approval_status"]), (201, "granted"))
        self.assertEqual(self.get(view, ALICE)[2]["approval_status"], "granted")
        audit = self.get(view, OPS, "/audit")[2]["events"]
        self.assertEqual([e["actor"] for e in audit][-1], "user:bob")

    def test_the_owner_who_is_not_an_approver_is_forbidden_and_nothing_is_written(self):
        self.start(StaticApprovers({"user:bob"}))
        view = self.mission(ALICE)
        self.assertEqual(self.code(self.challenge(view, ALICE, "k-alice")), (403, "forbidden"))
        self.assertEqual(len(self.get(view, OPS, "/audit")[2]["events"]), 1)

    def test_nobody_may_approve_without_a_policy(self):
        self.start(NoApprovers())
        view = self.mission(ALICE)
        self.assertEqual(self.code(self.challenge(view, ALICE, "k-alice")), (403, "forbidden"))

    def test_a_stranger_is_not_told_the_mission_exists(self):
        self.start(StaticApprovers({"user:bob"}))
        view = self.mission(BOB)  # bob (the approver) owns it; alice is neither owner nor approver
        self.assertEqual(self.code(self.challenge(view, ALICE, "k-alice")), (404, "not_found"))
        unknown = dict(view, mission_id="mission-" + "0" * 16)
        self.assertEqual(self.code(self.challenge(unknown, BOB, "k-bob")), (404, "not_found"))

    def test_the_sole_approver_may_approve_their_own_mission(self):
        self.start(StaticApprovers({"user:alice"}))
        view = self.mission(ALICE)
        ch = self.challenge(view, ALICE, "k-alice")[2]
        self.assertEqual(self.submit(view, ch, ALICE, "k-alice", SECRET_A)[0], 201)

    def test_an_approver_can_read_the_mission_but_not_its_audit_or_result(self):
        self.start(StaticApprovers({"user:bob"}))
        view = self.mission(ALICE)
        self.assertEqual(self.get(view, BOB)[0], 200)
        self.assertEqual(self.code(self.get(view, BOB, "/audit")), (404, "not_found"))
        self.assertEqual(self.code(self.get(view, BOB, "/result")), (404, "not_found"))

    def test_a_non_approver_stranger_still_cannot_read_the_mission(self):
        self.start(StaticApprovers({"user:bob"}))
        view = self.mission(ALICE)
        self.assertEqual(self.get(view, OPS)[0], 404)

    def test_only_the_challenge_issuer_can_submit_it(self):
        self.start(StaticApprovers({"user:alice", "user:bob"}))
        view = self.mission(ALICE)
        ch = self.challenge(view, BOB, "k-bob")[2]
        self.assertEqual(self.code(self.submit(view, ch, ALICE, "k-bob", SECRET_B)), (404, "not_found"))


    def test_a_designated_approver_cannot_use_a_challenge_issued_for_another_mission(self):
        self.start(StaticApprovers({"user:alice", "user:bob"}))
        alices = self.mission(ALICE)
        ch = self.challenge(alices, ALICE, "k-alice")[2]
        bobs = self.mission(BOB)
        bobs_view = dict(bobs)
        self.assertEqual(self.code(self.submit(bobs_view, ch, BOB, "k-bob", SECRET_B)), (404, "not_found"))


class Revocation(Base):
    def test_revoking_the_role_voids_a_recorded_unused_approval(self):
        policy = Switchable("user:bob")
        self.start(policy)
        view = self.mission(ALICE)
        ch = self.challenge(view, BOB, "k-bob")[2]
        self.assertEqual(self.submit(view, ch, BOB, "k-bob", SECRET_B)[2]["approval_status"], "granted")
        self.assertEqual(self.get(view, ALICE)[2]["state"], "approved")
        policy.subjects.clear()
        voided = self.get(view, ALICE)[2]
        self.assertEqual((voided["approval_status"], voided["state"]), ("required", "planned"))
        policy.subjects.add("user:bob")
        restored = self.get(view, ALICE)[2]
        self.assertEqual((restored["approval_status"], restored["state"]), ("granted", "approved"))

    def test_revoked_between_challenge_and_submit_is_refused_and_leaves_nothing(self):
        policy = Switchable("user:bob")
        self.start(policy)
        view = self.mission(ALICE)
        ch = self.challenge(view, BOB, "k-bob")[2]
        policy.subjects.clear()
        # no longer an approver and not the owner => indistinguishable from a stranger
        self.assertEqual(self.code(self.submit(view, ch, BOB, "k-bob", SECRET_B)), (404, "not_found"))
        self.assertEqual(self.get(view, ALICE)[2]["approval_status"], "required")
        types = [e["event_type"] for e in self.get(view, OPS, "/audit")[2]["events"]]
        self.assertNotIn("mission.approval_granted", types)


class Queue(Base):
    def queue(self, token):
        return self.app.json("GET", "/v1/approvals", token=token)

    def create(self, key, token=ALICE, risk="high"):
        status, _, view = self.app.json("POST", "/v1/missions", {
            "idempotency_key": key, "objective": f"Task {key}", "success_criteria": ["ok"],
            "risk_tier": risk}, token=token)
        self.assertEqual(status, 201, view)
        return view

    def test_only_an_approver_sees_the_queue_newest_first_and_only_what_awaits_approval(self):
        self.start(StaticApprovers({"user:bob"}))
        first, second = self.create("key-first-0001"), self.create("key-second-001")
        self.create("key-low-000001", risk="low")  # needs no approval: not queued
        granted = self.create("key-granted-01")
        ch = self.challenge(granted, BOB, "k-bob")[2]
        self.assertEqual(self.submit(granted, ch, BOB, "k-bob", SECRET_B)[0], 201)  # no longer waiting
        status, _, body = self.queue(BOB)
        self.assertEqual(status, 200)
        self.assertEqual(set(body), {"api_version", "missions"})
        self.assertEqual([m["mission_id"] for m in body["missions"]], [second["mission_id"], first["mission_id"]])
        self.assertEqual(self.code(self.queue(ALICE)), (403, "forbidden"))
        self.assertEqual(self.code(self.queue(OPS)), (403, "forbidden"))
        self.assertEqual(self.app.json("GET", "/v1/approvals", token=None)[0], 401)

    def test_the_queue_is_capped_and_newest_first(self):
        from unittest import mock
        self.start(StaticApprovers({"user:bob"}))
        ids = [self.create(f"key-cap-{i:06d}")["mission_id"] for i in range(4)]
        with mock.patch("master_brain.mission_service.MAX_PENDING_APPROVALS", 2):
            body = self.queue(BOB)[2]
        self.assertEqual([m["mission_id"] for m in body["missions"]], ids[::-1][:2])

    def test_an_approval_by_a_withdrawn_approver_puts_the_mission_back_in_the_queue(self):
        policy = Switchable("user:bob")
        self.start(policy)
        view = self.create("key-revoke-001")
        ch = self.challenge(view, BOB, "k-bob")[2]
        self.submit(view, ch, BOB, "k-bob", SECRET_B)
        self.assertEqual(self.queue(BOB)[2]["missions"], [])
        policy.subjects.update({"user:alice"})
        policy.subjects.discard("user:bob")
        self.assertEqual([m["mission_id"] for m in self.queue(ALICE)[2]["missions"]], [view["mission_id"]])

    def test_a_failing_policy_fails_closed_with_unavailable(self):
        class Broken:
            def is_approver(self, subject):
                raise RuntimeError("policy backend down")
        self.start(Broken())
        status, code = self.code(self.queue(ALICE))
        self.assertEqual((status, code), (503, "unavailable"))

    def test_an_empty_queue_and_no_policy(self):
        self.start(NoApprovers())
        self.assertEqual(self.code(self.queue(ALICE)), (403, "forbidden"))
        self.start(StaticApprovers({"user:alice"}))
        self.assertEqual(self.queue(ALICE)[2]["missions"], [])


class Execution(ExecBase):
    """Approval is judged again at EXECUTION time, by the same policy."""

    def setUp(self):
        self.policy = Switchable("user:bob")
        super().setUp()
        self.verifier.add("k-bob", SECRET_B, "user:bob")

    def start(self, adapter):
        self.app = Running(self.path, self.verifier, self.clock, self.config(adapter), approvers=self.policy)
        self.addCleanup(self.app.close)

    def bob_approves(self, view, digest):
        base = f"/v1/missions/{view['mission_id']}"
        _, _, ch = self.app.json("POST", base + "/approval-challenges", {
            "contract_digest": view["contract_digest"], "signing_key_id": "k-bob",
            "signature_alg": TEST_ALGORITHM, "action_digest": digest}, token=BOB)
        sig = HmacSeamSigner("k-bob", SECRET_B).sign(bytes.fromhex(ch["signing_message_hex"])).hex()
        status, _, done = self.app.json("POST", base + "/approvals", {
            "idempotency_key": "approve-" + ch["approval_event_id"][-10:],
            "approval_event_id": ch["approval_event_id"], "signing_key_id": "k-bob",
            "signature_alg": TEST_ALGORITHM, "signature_hex": sig}, token=BOB)
        self.assertEqual((status, done["approval_status"]), (201, "granted"), done)

    def test_the_owner_runs_what_a_different_approver_approved(self):
        view = self.mission(risk="high")
        self.bob_approves(view, self.digest("echo"))
        status, _, res = self.execute(view)
        self.assertEqual((status, res["state"]), (201, "response_received"), res)
        self.assertEqual(self.adapter.calls, 1)

    def test_execution_is_refused_once_the_approver_duty_is_withdrawn_and_nothing_runs(self):
        view = self.mission(risk="high")
        self.bob_approves(view, self.digest("echo"))
        self.policy.subjects.clear()
        status, code = self.code(self.execute(view))
        self.assertEqual((status, code), (403, "approval_required"))
        self.assertEqual(self.adapter.calls, 0)

    def test_an_approver_cannot_run_a_mission_they_do_not_own(self):
        view = self.mission(risk="high")
        self.bob_approves(view, self.digest("echo"))
        self.assertEqual(self.code(self.execute(view, token=BOB)), (404, "not_found"))
        self.assertEqual(self.adapter.calls, 0)


if __name__ == "__main__":
    unittest.main()
