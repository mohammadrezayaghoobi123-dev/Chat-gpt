"""MISSION-001/002/003: persisted contract + replay-derived lifecycle (red-first tests)."""
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path

from master_brain.audit_store import AuditStore
from master_brain.core import RiskTier, Task
from master_brain.mission_approval import (
    action_digest, mission_contract_digest, record_mission_approval,
)
from master_brain.mission_contract import MissionContract, from_core_task
from master_brain.mission_lifecycle import (
    CONTRACT_REGISTERED_EVENT_TYPE,
    MissionContractConflict,
    MissionLifecycleError,
    MissionState,
    RECONCILED_EVENT_TYPE,
    ReconciliationRejected,
    derive_mission_state,
    record_dispatch_reconciliation,
    unresolved_attempt_ids,
    load_mission_contract,
    register_mission_contract,
)
from tests.approval_expiry_helper import soon

T = "2026-10-17T00:00:00Z"


class LifecycleBase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name) / "audit.jsonl"
        self.store = AuditStore(self.path)
        self.contract = from_core_task(Task(
            objective="Deploy production release",
            constraints=("keep audit history", "no secrets"),
            risk=RiskTier.HIGH,
        ))

    def register(self, contract=None, event_id="reg-1"):
        return register_mission_contract(
            self.store, contract or self.contract,
            event_id=event_id, recorded_at=T, actor="planner")

    def raw(self, event_id, event_type, payload, mission_id=None):
        self.store.append(
            event_id=event_id, event_type=event_type, recorded_at=T, actor="x",
            subject_ref=f"mission:{mission_id or self.contract.mission_id}",
            payload=payload)

    def started(self, attempt="a1", digest=None, mission_id=None):
        self.raw(f"s-{attempt}", "mission.dispatch_started", {
            "mission_id": mission_id or self.contract.mission_id,
            "contract_digest": digest or mission_contract_digest(self.contract),
            "integration_id": "i", "attempt_id": attempt}, mission_id)

    def finished(self, attempt="a1", status="succeeded", mission_id=None):
        self.raw(f"f-{attempt}", "mission.dispatch_finished", {
            "mission_id": mission_id or self.contract.mission_id, "integration_id": "i",
            "attempt_id": attempt, "dispatch_status": status, "reason": "",
            "external_effect_confirmed": False}, mission_id)

    def approve(self):
        return record_mission_approval(
            self.store, self.contract, event_id="ap-1", recorded_at=T,
            approver_subject="alice", authentication_method="sso",
            action_digest=action_digest("i", {"a": 1}), expires_at=soon(1))


class RegistrationTests(LifecycleBase):
    def test_roundtrip_survives_new_store_instance(self):
        self.register()
        reloaded = load_mission_contract(AuditStore(self.path), self.contract.mission_id)
        self.assertEqual(reloaded, self.contract)
        self.assertEqual(mission_contract_digest(reloaded), mission_contract_digest(self.contract))

    def test_registration_is_idempotent_for_same_digest(self):
        first = self.register()
        second = self.register(event_id="reg-2")
        self.assertEqual(first.event_id, second.event_id)
        regs = [e for e in self.store.read_all() if e.event_type == CONTRACT_REGISTERED_EVENT_TYPE]
        self.assertEqual(len(regs), 1)

    def test_changed_contract_under_same_mission_id_is_a_conflict(self):
        self.register()
        changed = replace(self.contract, objective="Deploy something else")
        with self.assertRaises(MissionContractConflict):
            self.register(changed, event_id="reg-2")
        self.assertEqual(load_mission_contract(self.store, self.contract.mission_id), self.contract)

    def test_invalid_contract_is_not_registered(self):
        bad = replace(self.contract)
        object.__setattr__(bad, "risk_tier", "high")  # bypass validation
        with self.assertRaises(ValueError):
            self.register(bad)
        self.assertEqual(self.store.read_all(), ())

    def test_secret_in_contract_is_refused_by_audit_policy(self):
        secret = replace(self.contract, mission_id="m-secret",
                         objective="use sk-abcdefghijklmnopqrstuvwxyz123456")
        with self.assertRaises(Exception):
            self.register(secret)
        self.assertEqual(self.store.read_all(), ())

    def test_load_unknown_mission_raises(self):
        with self.assertRaises(MissionLifecycleError):
            load_mission_contract(self.store, "nope")

    def test_load_detects_tampered_snapshot(self):
        self.register()
        text = self.path.read_text(encoding="utf-8")
        self.path.write_text(text.replace("Deploy production release", "Deploy production releasX"),
                             encoding="utf-8")
        with self.assertRaises(Exception):  # chain break or digest mismatch: never a silent load
            load_mission_contract(AuditStore(self.path), self.contract.mission_id)

    def test_load_rejects_snapshot_whose_digest_field_lies(self):
        # A correctly chained event whose recorded digest does not match its snapshot.
        other = replace(self.contract, mission_id="m-lie", objective="other")
        lie = {
            "mission_id": "m-lie", "contract_schema_version": other.schema_version,
            "contract_digest": mission_contract_digest(self.contract),
            "contract": __import__("master_brain.mission_approval", fromlist=["_json_value"])._json_value(
                __import__("dataclasses").asdict(other)),
        }
        self.raw("reg-lie", CONTRACT_REGISTERED_EVENT_TYPE, lie, mission_id="m-lie")
        with self.assertRaises(MissionLifecycleError):
            load_mission_contract(self.store, "m-lie")


class StateTests(LifecycleBase):
    def state(self):
        return derive_mission_state(self.store, self.contract.mission_id)

    def test_unregistered(self):
        self.assertIs(self.state().state, MissionState.UNREGISTERED)

    def test_planned_then_approved(self):
        self.register()
        self.assertIs(self.state().state, MissionState.PLANNED)
        self.approve()
        self.assertIs(self.state().state, MissionState.APPROVED)

    def test_approval_for_another_contract_digest_does_not_count(self):
        self.register()
        other = replace(self.contract, objective="Deploy production release v2")
        record_mission_approval(
            self.store, other, event_id="ap-o", recorded_at=T, approver_subject="a",
            authentication_method="sso", action_digest=action_digest("i", {}), expires_at=soon(1))
        # different mission_id? from replace keeps mission_id; digest differs -> not APPROVED
        self.assertIs(self.state().state, MissionState.PLANNED)

    def test_dispatch_started_without_finish_is_unresolved(self):
        self.register(); self.approve(); self.started()
        self.assertIs(self.state().state, MissionState.DISPATCH_UNRESOLVED)

    def test_success_is_response_received_never_completed(self):
        self.register(); self.approve(); self.started(); self.finished(status="succeeded")
        self.assertIs(self.state().state, MissionState.RESPONSE_RECEIVED)
        names = {s.name for s in MissionState}
        self.assertFalse(names & {"COMPLETED", "VERIFIED", "DONE", "SUCCEEDED"})

    def test_effect_uncertain_statuses_are_unresolved(self):
        for status in ("timeout", "adapter_error", "invalid_output"):
            with self.subTest(status=status):
                self.setUp()
                self.register(); self.approve(); self.started(); self.finished(status=status)
                self.assertIs(self.state().state, MissionState.DISPATCH_UNRESOLVED)

    def test_pre_effect_failures_are_not_dispatched(self):
        for status in ("rejected", "adapter_missing"):
            with self.subTest(status=status):
                self.setUp()
                self.register(); self.approve(); self.started(); self.finished(status=status)
                self.assertIs(self.state().state, MissionState.DISPATCH_FAILED_NO_EFFECT)

    def test_unresolved_attempt_dominates_later_success(self):
        self.register(); self.approve()
        self.started("a1"); self.finished("a1", "timeout")
        self.started("a2"); self.finished("a2", "succeeded")
        self.assertIs(self.state().state, MissionState.DISPATCH_UNRESOLVED)

    def test_dispatch_without_registration_is_inconsistent(self):
        self.started()
        view = self.state()
        self.assertIs(view.state, MissionState.INCONSISTENT)
        self.assertTrue(view.anomalies)

    def test_dispatch_for_different_digest_is_inconsistent(self):
        self.register(); self.started(digest="0" * 64)
        self.assertIs(self.state().state, MissionState.INCONSISTENT)

    def test_finish_without_start_is_inconsistent(self):
        self.register(); self.finished()
        self.assertIs(self.state().state, MissionState.INCONSISTENT)

    def test_other_missions_events_are_ignored(self):
        self.register()
        other = replace(self.contract, mission_id="m-other")
        self.raw("s-o", "mission.dispatch_started", {
            "mission_id": "m-other", "contract_digest": mission_contract_digest(other),
            "integration_id": "i", "attempt_id": "x"}, mission_id="m-other")
        self.assertIs(self.state().state, MissionState.PLANNED)

    def test_state_survives_reload(self):
        self.register(); self.approve(); self.started()
        again = derive_mission_state(AuditStore(self.path), self.contract.mission_id)
        self.assertIs(again.state, MissionState.DISPATCH_UNRESOLVED)
        self.assertEqual(again.contract_digest, mission_contract_digest(self.contract))


class SnapshotValidationTests(LifecycleBase):
    def snap(self, contract=None):
        from dataclasses import asdict
        from master_brain.mission_approval import _json_value
        c = contract or self.contract
        return {"mission_id": c.mission_id, "contract_schema_version": c.schema_version,
                "contract_digest": mission_contract_digest(c), "contract": _json_value(asdict(c))}

    def put(self, payload, event_id="reg-x", mission_id=None):
        self.raw(event_id, CONTRACT_REGISTERED_EVENT_TYPE, payload, mission_id)

    def assert_load_fails(self, fragment, mission_id=None):
        with self.assertRaises(MissionLifecycleError) as ctx:
            load_mission_contract(self.store, mission_id or self.contract.mission_id)
        self.assertIn(fragment, str(ctx.exception))

    def test_unknown_mission_message(self):
        self.assert_load_fails("no contract registered", "nope")

    def test_non_object_snapshot_is_lifecycle_error(self):
        payload = self.snap(); payload["contract"] = "not-an-object"
        self.put(payload)
        self.assert_load_fails("not an object")

    def test_missing_field_is_lifecycle_error_not_keyerror(self):
        payload = self.snap(); del payload["contract"]["objective"]
        self.put(payload)
        self.assert_load_fails("invalid")

    def test_missing_sequence_field_is_lifecycle_error_not_keyerror(self):
        payload = self.snap(); del payload["contract"]["constraints"]
        self.put(payload)
        self.assert_load_fails("invalid")

    def test_bad_enum_is_lifecycle_error_not_valueerror(self):
        payload = self.snap(); payload["contract"]["risk_tier"] = "apocalyptic"
        self.put(payload)
        self.assert_load_fails("invalid")

    def test_wrong_type_is_lifecycle_error_not_typeerror(self):
        payload = self.snap(); payload["contract"]["budget_units"] = "ten"
        self.put(payload)
        self.assert_load_fails("invalid")

    def test_multiple_registrations_rejected(self):
        self.put(self.snap(), "reg-a"); self.put(self.snap(), "reg-b")
        self.assert_load_fails("multiple")

    def test_snapshot_for_another_mission_rejected_via_contract_id(self):
        other = replace(self.contract, mission_id="m-other")
        self.put(self.snap(other))  # filed under this mission's subject
        self.assert_load_fails("different mission")

    def test_payload_mission_id_mismatch_rejected(self):
        payload = self.snap(); payload["mission_id"] = "m-other"
        self.put(payload)
        self.assert_load_fails("different mission")

    def test_views_are_immutable(self):
        reg = self.register()
        view = derive_mission_state(self.store, self.contract.mission_id)
        for obj, attr in ((reg, "event_id"), (view, "state")):
            with self.assertRaises(Exception):
                setattr(obj, attr, "x")


class ReconciliationTests(LifecycleBase):
    def state(self):
        return derive_mission_state(self.store, self.contract.mission_id)

    def reconcile(self, attempt="a1", resolution="effect_did_not_occur", evidence="receipt-123",
                  event_id=None):
        return record_dispatch_reconciliation(
            self.store, self.contract.mission_id, attempt, resolution, evidence,
            event_id=event_id or f"rec-{attempt}-{resolution}", recorded_at=T, actor="ops")

    def unresolved(self, attempt="a1"):
        self.started(attempt); self.finished(attempt, "timeout")

    def test_attempt_without_id_is_inconsistent_not_collapsed(self):
        self.register()
        self.raw("s-none", "mission.dispatch_started", {
            "mission_id": self.contract.mission_id,
            "contract_digest": mission_contract_digest(self.contract),
            "integration_id": "i", "attempt_id": None})
        view = self.state()
        self.assertIs(view.state, MissionState.INCONSISTENT)
        self.assertTrue(any("attempt id" in a for a in view.anomalies))

    def test_no_effect_resolution_reopens_the_mission(self):
        self.register(); self.approve(); self.unresolved()
        self.assertIs(self.state().state, MissionState.DISPATCH_UNRESOLVED)
        self.reconcile(resolution="effect_did_not_occur")
        self.assertIs(self.state().state, MissionState.DISPATCH_FAILED_NO_EFFECT)

    def test_effect_occurred_resolution_is_its_own_state(self):
        self.register(); self.approve(); self.unresolved()
        self.reconcile(resolution="effect_occurred")
        self.assertIs(self.state().state, MissionState.EFFECT_RECONCILED)

    def test_started_without_finish_can_be_reconciled(self):
        self.register(); self.approve(); self.started()
        self.reconcile()
        self.assertEqual(unresolved_attempt_ids(self.store.read_all(), self.contract.mission_id), ())

    def test_other_unresolved_attempt_still_dominates(self):
        self.register(); self.approve(); self.unresolved("a1"); self.unresolved("a2")
        self.reconcile("a1")
        self.assertIs(self.state().state, MissionState.DISPATCH_UNRESOLVED)
        self.assertEqual(unresolved_attempt_ids(self.store.read_all(), self.contract.mission_id), ("a2",))

    def test_response_outranks_reconciled_effect(self):
        self.register(); self.approve(); self.unresolved("a1")
        self.reconcile("a1", "effect_occurred")
        self.started("a2"); self.finished("a2", "succeeded")
        self.assertIs(self.state().state, MissionState.RESPONSE_RECEIVED)

    def test_inadmissible_claims_are_rejected_and_write_nothing(self):
        self.register(); self.approve(); self.unresolved("a1")
        self.started("a2"); self.finished("a2", "succeeded")
        self.reconcile("a1")
        before = len(self.store.read_all())
        cases = (
            ("nope", "effect_occurred", "ev", "unknown_attempt"),
            ("a2", "effect_occurred", "ev", "attempt_not_unresolved"),   # already succeeded
            ("a1", "effect_occurred", "ev", "attempt_not_unresolved"),   # already reconciled
            ("a1", "maybe", "ev", "resolution"),
            ("a1", "effect_occurred", "  ", "evidence_ref"),
            ("", "effect_occurred", "ev", "attempt_id"),
        )
        for attempt, resolution, evidence, fragment in cases:
            with self.subTest(attempt=attempt, resolution=resolution, evidence=evidence):
                with self.assertRaises(ReconciliationRejected) as ctx:
                    self.reconcile(attempt, resolution, evidence, event_id=f"x-{attempt}-{resolution}-{evidence}")
                self.assertIn(fragment, str(ctx.exception))
        self.assertEqual(len(self.store.read_all()), before)

    def test_unregistered_or_inconsistent_mission_cannot_be_reconciled(self):
        with self.assertRaises(ReconciliationRejected) as ctx:
            self.reconcile()
        self.assertIn("mission_not_registered", str(ctx.exception))
        self.register(); self.finished("zz")  # finish with no start => inconsistent
        with self.assertRaises(ReconciliationRejected) as ctx:
            self.reconcile("zz")
        self.assertIn("mission_lifecycle_inconsistent", str(ctx.exception))

    def test_secret_in_evidence_ref_is_refused(self):
        self.register(); self.approve(); self.unresolved()
        with self.assertRaises(Exception):
            self.reconcile(evidence="sk-abcdefghijklmnopqrstuvwxyz123456")
        self.assertIs(self.state().state, MissionState.DISPATCH_UNRESOLVED)

    def test_replayed_log_with_contradicting_reconciliations_is_inconsistent(self):
        self.register(); self.approve(); self.started("a1"); self.finished("a1", "succeeded")
        # bypass the admissibility check by writing raw events
        def rec(eid, attempt, resolution="effect_occurred"):
            self.raw(eid, RECONCILED_EVENT_TYPE, {
                "mission_id": self.contract.mission_id, "attempt_id": attempt,
                "resolution": resolution, "evidence_ref": "e"})
        rec("r1", "a1")                       # targets a resolved attempt
        self.assertIs(self.state().state, MissionState.INCONSISTENT)
        self.setUp(); self.register(); self.started("a1")
        rec("r2", "ghost")                    # no matching attempt
        self.assertIs(self.state().state, MissionState.INCONSISTENT)
        self.setUp(); self.register(); self.started("a1")
        rec("r3", "a1"); rec("r4", "a1")      # twice
        self.assertIs(self.state().state, MissionState.INCONSISTENT)
        self.setUp(); self.register(); self.started("a1")
        rec("r5", "a1", "bogus")              # invalid resolution
        self.assertIs(self.state().state, MissionState.INCONSISTENT)

    def test_duplicate_start_or_finish_is_inconsistent(self):
        self.register(); self.started("a1")
        self.raw("s-dup", "mission.dispatch_started", {
            "mission_id": self.contract.mission_id,
            "contract_digest": mission_contract_digest(self.contract),
            "integration_id": "i", "attempt_id": "a1"})
        self.assertIs(self.state().state, MissionState.INCONSISTENT)
        self.setUp(); self.register(); self.started("a1"); self.finished("a1", "timeout")
        self.raw("f-dup", "mission.dispatch_finished", {
            "mission_id": self.contract.mission_id, "integration_id": "i", "attempt_id": "a1",
            "dispatch_status": "succeeded", "reason": "", "external_effect_confirmed": False})
        self.assertIs(self.state().state, MissionState.INCONSISTENT)


if __name__ == "__main__":
    unittest.main()
