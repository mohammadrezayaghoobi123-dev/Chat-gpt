"""Service-level tests, including forged/corrupt logs (fail-closed paths the HTTP tests can't isolate)."""
import dataclasses
import tempfile
import unittest
from pathlib import Path

from master_brain.api_contracts import CreateMissionRequest, ErrorCode
from master_brain.audit_store import AuditStore
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
