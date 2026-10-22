"""Service-level tests, including forged/corrupt logs (fail-closed paths the HTTP tests can't isolate)."""
import dataclasses
import tempfile
import unittest
from pathlib import Path

from master_brain.api_contracts import CreateMissionRequest, ErrorCode
from master_brain.audit_store import AuditStore
from master_brain.approvers import StaticApprovers
from master_brain.identity import Identity
from master_brain.mission_service import MissionService, ServiceError, mission_id_for

ALICE, BOB = Identity("user:alice"), Identity("user:bob")
REQ = CreateMissionRequest(idempotency_key="key-0001-abcdef", objective="obj", success_criteria=("x",))


class ServiceTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.path = Path(tmp.name) / "a.jsonl"
        self.store = AuditStore(self.path)
        self.service = MissionService(self.store)

    def code(self, fn, *a):
        with self.assertRaises(ServiceError) as ctx:
            fn(*a)
        return ctx.exception.code

    def forge_registration(self, mission_id, actor, event_id="forged-1"):
        reg = self.store.read_all()
        payload = reg[0].payload if reg else None
        if payload is None:  # build a legitimate payload through the service first
            raise AssertionError("create a mission first")
        self.store.append(event_id=event_id, event_type="mission.contract_registered",
                          recorded_at=self.store.now().isoformat().replace("+00:00", "Z"), actor=actor,
                          subject_ref=f"mission:{mission_id}", payload=dict(payload))

    def test_result_is_immutable_and_ids_are_per_owner(self):
        result = self.service.create_mission(ALICE, REQ)
        with self.assertRaises(dataclasses.FrozenInstanceError):
            result.created = False
        self.assertNotEqual(mission_id_for(ALICE, REQ.idempotency_key), mission_id_for(BOB, REQ.idempotency_key))
        self.assertEqual(mission_id_for(ALICE, "k1"), mission_id_for(ALICE, "k1"))
        self.assertNotEqual(mission_id_for(ALICE, "k1"), mission_id_for(ALICE, "k2"))

    def test_registration_owned_by_someone_else_is_not_found(self):
        mid = self.service.create_mission(ALICE, REQ).view.mission_id
        # forged log: the same mission id registered under another actor (cannot happen via the API)
        other = MissionService(AuditStore(Path(self.path.parent / "b.jsonl")))
        mid_b = other.create_mission(BOB, REQ).view.mission_id
        self.assertNotEqual(mid, mid_b)
        raw = self.path.read_text(encoding="utf-8").replace('"actor":"user:alice"', '"actor":"user:mallory"')
        self.assertNotEqual(raw, self.path.read_text(encoding="utf-8"))
        # tampering breaks the hash chain => unavailable (never serves forged ownership)
        self.path.write_text(raw, encoding="utf-8")
        self.assertEqual(self.code(self.service.get_mission, ALICE, mid), ErrorCode.UNAVAILABLE)
        self.assertEqual(self.code(self.service.create_mission, ALICE, REQ), ErrorCode.UNAVAILABLE)

    def test_valid_chain_with_foreign_registration_for_my_id_is_not_found(self):
        self.service.create_mission(BOB, dataclasses.replace(REQ, idempotency_key="key-0002-abcdef"))
        mid = mission_id_for(ALICE, REQ.idempotency_key)
        self.forge_registration(mid, "user:mallory")  # properly chained event, wrong owner
        self.assertEqual(self.code(self.service.create_mission, ALICE, REQ), ErrorCode.NOT_FOUND)
        self.assertEqual(self.code(self.service.get_mission, ALICE, mid), ErrorCode.NOT_FOUND)
        self.assertEqual(self.code(self.service.list_audit, ALICE, mid), ErrorCode.NOT_FOUND)

    def test_duplicate_registrations_fail_closed(self):
        mid = self.service.create_mission(ALICE, REQ).view.mission_id
        self.forge_registration(mid, "user:alice", event_id="forged-dup")
        for fn in (self.service.get_mission, self.service.list_audit):
            self.assertEqual(self.code(fn, ALICE, mid), ErrorCode.UNAVAILABLE)
        self.assertEqual(self.code(self.service.create_mission, ALICE, REQ), ErrorCode.UNAVAILABLE)

    def test_list_audit_returns_payload_free_events_for_the_owner(self):
        mid = self.service.create_mission(ALICE, REQ).view.mission_id
        events = self.service.list_audit(ALICE, mid)
        self.assertEqual([e.event_type for e in events], ["mission.contract_registered"])
        self.assertEqual(events[0].actor, "user:alice")
        self.assertFalse(hasattr(events[0], "payload"))

    def test_conflict_and_invalid_mappings(self):
        import master_brain.mission_service as ms
        from master_brain.mission_lifecycle import MissionContractConflict
        real = ms.register_mission_contract

        def raising(*a, **k):
            raise MissionContractConflict("race")
        ms.register_mission_contract = raising
        self.addCleanup(setattr, ms, "register_mission_contract", real)
        self.assertEqual(self.code(self.service.create_mission, ALICE, REQ), ErrorCode.CONFLICT)
        ms.register_mission_contract = real
        bad = dataclasses.replace(REQ, risk_tier="bogus")  # bypasses request parsing on purpose
        self.assertEqual(self.code(self.service.create_mission, ALICE, bad), ErrorCode.INVALID_REQUEST)
        self.assertEqual(self.store.read_all(), ())

    def test_unreadable_store_is_unavailable_everywhere(self):
        mid = self.service.create_mission(ALICE, REQ).view.mission_id
        self.path.write_text("garbage\n", encoding="utf-8")
        self.assertEqual(self.code(self.service.get_mission, ALICE, mid), ErrorCode.UNAVAILABLE)
        self.assertEqual(self.code(self.service.list_audit, ALICE, mid), ErrorCode.UNAVAILABLE)
        self.assertEqual(self.code(self.service.create_mission, ALICE, REQ), ErrorCode.UNAVAILABLE)

    def test_get_succeeds_but_a_corrupt_log_after_ownership_check_fails_closed(self):
        mid = self.service.create_mission(ALICE, REQ).view.mission_id
        calls = {"n": 0}
        real = self.store.read_all

        def flaky():
            calls["n"] += 1
            if calls["n"] > 1:
                raise RuntimeError("disk")
            return real()
        self.store.read_all = flaky
        self.assertEqual(self.code(self.service.get_mission, ALICE, mid), ErrorCode.UNAVAILABLE)
        calls["n"] = 0
        self.assertEqual(self.code(self.service.list_audit, ALICE, mid), ErrorCode.UNAVAILABLE)


if __name__ == "__main__":
    unittest.main()


class RegistrationCreatedFlag(unittest.TestCase):
    def test_register_reports_created_only_for_the_first_registration(self):
        from master_brain.mission_contract import MissionContract
        from master_brain.mission_lifecycle import register_mission_contract
        with tempfile.TemporaryDirectory() as tmp:
            store = AuditStore(Path(tmp) / "a.jsonl")
            contract = MissionContract(mission_id="m-flag", objective="o")
            kw = dict(recorded_at=store.now().isoformat().replace("+00:00", "Z"), actor="user:alice")
            first = register_mission_contract(store, contract, event_id="e1", **kw)
            again = register_mission_contract(store, contract, event_id="e2", **kw)
            self.assertEqual((first.created, again.created), (True, False))
            self.assertEqual(first.event_id, again.event_id)


class ApprovalServiceEdgeTests(unittest.TestCase):
    """Fail-closed edges of the approval service that HTTP tests cannot reach deterministically."""

    def setUp(self):
        from tests.approval_signing_helper import TEST_ALGORITHM, HmacSeamSigner, HmacSeamVerifier
        from tests.test_http_approvals import FakeClock
        self.alg = TEST_ALGORITHM
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.path = Path(tmp.name) / "a.jsonl"
        self.clock = FakeClock()
        self.store = AuditStore(self.path, clock=self.clock)
        self.verifier = HmacSeamVerifier()
        self.verifier.add("k1", b"secret-1", "user:alice")
        self.signer = HmacSeamSigner("k1", b"secret-1")
        self.service = MissionService(self.store, self.verifier, approvers=StaticApprovers({"user:alice"}))
        self.view = self.service.create_mission(ALICE, dataclasses.replace(REQ, risk_tier="high")).view

    def challenge(self, **kw):
        from master_brain.api_contracts import ApprovalChallengeRequest
        args = dict(contract_digest=self.view.contract_digest, signing_key_id="k1",
                    signature_alg=self.alg, action_digest="a" * 64)
        args.update(kw)
        return self.service.request_approval_challenge(ALICE, self.view.mission_id, ApprovalChallengeRequest(**args))

    def submit(self, ch, **kw):
        from master_brain.api_contracts import SubmitApprovalRequest
        sig = self.signer.sign(bytes.fromhex(ch.signing_message_hex)).hex()
        args = dict(idempotency_key="idem-0001-abc", approval_event_id=ch.approval_event_id,
                    signing_key_id="k1", signature_alg=self.alg, signature_hex=sig)
        args.update(kw)
        return self.service.submit_approval(ALICE, self.view.mission_id, SubmitApprovalRequest(**args))

    def code(self, fn, *a, **k):
        with self.assertRaises(ServiceError) as ctx:
            fn(*a, **k)
        return ctx.exception.code

    def approvals(self):
        return [e for e in self.store.read_all() if e.event_type == "mission.approval_granted"]

    def test_the_right_challenge_is_selected_among_several(self):
        first, second = self.challenge(), self.challenge()
        self.assertNotEqual(first.approval_event_id, second.approval_event_id)
        self.assertTrue(self.submit(second).created)
        self.assertEqual([e.event_id for e in self.approvals()], [second.approval_event_id])
        self.assertTrue(self.submit(first).created)  # still usable; selection by id, not by type
        self.assertEqual({e.event_id for e in self.approvals()}, {first.approval_event_id, second.approval_event_id})
        again = self.submit(second)  # replay picks ITS approval, not the first one
        self.assertFalse(again.created)

    def test_inconsistent_mission_cannot_be_challenged(self):
        self.store.append(
            event_id="bad-dispatch", event_type="mission.dispatch_started",
            recorded_at=self.clock.now.isoformat().replace("+00:00", "Z"), actor="x",
            subject_ref=f"mission:{self.view.mission_id}",
            payload={"mission_id": self.view.mission_id, "contract_digest": "e" * 64,
                     "integration_id": "i", "attempt_id": "a1"})
        self.assertEqual(self.code(self.challenge), ErrorCode.CONFLICT)

    def test_forged_challenge_for_another_contract_digest_is_stale(self):
        ch = self.challenge()
        forged_id = "approval-" + "f" * 32
        self.store.append(
            event_id=f"challenge:{forged_id}", event_type="mission.approval_challenged",
            recorded_at=self.clock.now.isoformat().replace("+00:00", "Z"), actor="user:alice",
            subject_ref=f"mission:{self.view.mission_id}",
            payload={"mission_id": self.view.mission_id, "contract_digest": "0" * 64,
                     "approval_event_id": forged_id, "signing_key_id": "k1", "signature_alg": self.alg,
                     "expires_at": ch.expires_at})
        sub = dict(approval_event_id=forged_id)
        self.assertEqual(self.code(self.submit, ch, **sub), ErrorCode.STALE_CONTRACT)
        self.assertEqual(self.approvals(), [])

    def test_clock_passing_expiry_between_check_and_write_is_refused(self):
        import master_brain.mission_service as ms
        ch = self.challenge()
        real = ms.record_mission_approval

        def late(*a, **k):
            self.clock.advance(hours=3)  # the approval window closes before the append
            return real(*a, **k)
        ms.record_mission_approval = late
        self.addCleanup(setattr, ms, "record_mission_approval", real)
        self.assertEqual(self.code(self.submit, ch), ErrorCode.APPROVAL_INVALID)
        self.assertEqual(self.approvals(), [])

    def test_lost_race_recovers_only_when_the_winner_signed_the_same_thing(self):
        import master_brain.mission_service as ms
        from master_brain.audit_store import AuditStoreError
        real = ms.record_mission_approval
        self.submit(self.challenge())  # an unrelated earlier approval must not be mistaken for the winner
        ch = self.challenge()

        def winner_then_error(*a, **k):
            real(*a, **k)
            raise AuditStoreError("duplicate event_id")
        ms.record_mission_approval = winner_then_error
        self.addCleanup(setattr, ms, "record_mission_approval", real)
        result = self.submit(ch)
        self.assertEqual((result.created, result.view.approval_status), (False, "granted"))

        ch2 = self.challenge()

        def error_without_winner(*a, **k):
            raise AuditStoreError("disk full")
        ms.record_mission_approval = error_without_winner
        self.assertEqual(self.code(self.submit, ch2), ErrorCode.UNAVAILABLE)

        ch3 = self.challenge()

        def other_winner(*a, **k):
            real(*a, **{**k, "signature": b"\x01" * 32})  # a different signature won
            raise AuditStoreError("duplicate event_id")
        ms.record_mission_approval = other_winner
        self.assertEqual(self.code(self.submit, ch3), ErrorCode.UNAVAILABLE)

    def test_unreadable_store_is_unavailable_for_approval_calls(self):
        ch = self.challenge()
        self.path.write_text("garbage\n", encoding="utf-8")
        self.assertEqual(self.code(self.challenge), ErrorCode.UNAVAILABLE)
        self.assertEqual(self.code(self.submit, ch), ErrorCode.UNAVAILABLE)

    def test_secret_like_key_id_is_rejected_by_audit_policy_not_stored(self):
        self.assertEqual(self.code(self.challenge, signing_key_id="sk-" + "a" * 40), ErrorCode.INVALID_REQUEST)
        self.assertEqual([e for e in self.store.read_all() if e.event_type == "mission.approval_challenged"], [])
