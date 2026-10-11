import sqlite3
import tempfile
import time
import unittest
from pathlib import Path

from master_brain.audit_store import AuditStore, AuditStoreError
from master_brain.dispatch import DispatchStatus
from master_brain.integrations import (
    IntegrationDescriptor, IntegrationHealth, IntegrationKind,
    IntegrationMaturity, IntegrationRequirement,
)
from master_brain.mission_approval import record_mission_approval
from master_brain.mission_contract import MissionContract, MissionRiskTier
from master_brain.mission_execution import execute_mission_once, execute_mission_idempotently


class Adapter:
    def __init__(self):
        self.calls = 0

    def invoke(self, payload):
        self.calls += 1
        return {"accepted": True}


def descriptor():
    return IntegrationDescriptor(
        integration_id="test-model", version="1", kind=IntegrationKind.MODEL,
        capabilities=("text_reasoning",), maturity=IntegrationMaturity.ENABLED,
        health=IntegrationHealth.AVAILABLE, risk_level=0,
        estimated_cost_per_call=0.0,
    )


class MissionExecutionPipelineTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.store = AuditStore(Path(self.tmp.name) / "audit.jsonl")
        self.contract = MissionContract(
            mission_id="mission-42", objective="Execute controlled test",
            risk_tier=MissionRiskTier.HIGH, requires_approval=True,
        )
        self.requirement = IntegrationRequirement(
            ("text_reasoning",), required_kind=IntegrationKind.MODEL,
        )
        self.payload = {"mission_id": "mission-42", "prompt": "test"}

    def approve(self):
        return record_mission_approval(
            self.store, self.contract, event_id="approval-42",
            recorded_at="2026-10-12T00:00:00Z",
            approver_subject="user:reviewer",
            authentication_method="upstream-session",
        )

    def execute(self, adapter, receipt=None, prefix="run-42"):
        return execute_mission_once(
            self.contract, self.store, receipt, descriptor(), self.requirement,
            adapter, self.payload, event_id_prefix=prefix,
            recorded_at="2026-10-12T00:01:00Z", actor="system:test",
        )

    def test_missing_approval_never_invokes_adapter_or_audits_dispatch(self):
        adapter = Adapter()
        result = self.execute(adapter)
        self.assertEqual(result.status, "rejected")
        self.assertEqual(adapter.calls, 0)
        self.assertEqual(len(self.store.read_all()), 0)

    def test_approved_dispatch_audits_response_without_claiming_external_effect(self):
        receipt = self.approve()
        adapter = Adapter()
        result = self.execute(adapter, receipt)
        self.assertEqual(result.status, "response_received")
        self.assertEqual(result.dispatch_result.status, DispatchStatus.SUCCEEDED)
        self.assertEqual(adapter.calls, 1)
        events = self.store.read_all()
        self.assertEqual(events[-2].event_type, "mission.dispatch_started")
        self.assertEqual(events[-1].event_type, "mission.dispatch_finished")
        self.assertFalse(events[-1].payload["external_effect_confirmed"])

    def test_pre_dispatch_audit_failure_never_invokes_adapter(self):
        receipt = self.approve()
        adapter = Adapter()

        class FailingAppendStore:
            def read_all(inner_self):
                return self.store.read_all()

            def append(inner_self, **kwargs):
                raise AuditStoreError("simulated persistence outage")

        result = execute_mission_once(
            self.contract, FailingAppendStore(), receipt, descriptor(),
            self.requirement, adapter, self.payload,
            event_id_prefix="run-failing-audit",
            recorded_at="2026-10-12T00:01:00Z", actor="system:test",
        )
        self.assertEqual(result.status, "audit_unavailable")
        self.assertEqual(adapter.calls, 0)

    def test_unexpected_pre_dispatch_audit_error_never_invokes_adapter(self):
        receipt = self.approve()
        adapter = Adapter()

        class UnexpectedFailureStore:
            def read_all(inner_self):
                return self.store.read_all()

            def append(inner_self, **kwargs):
                raise RuntimeError("simulated unexpected backend error")

        result = execute_mission_once(
            self.contract, UnexpectedFailureStore(), receipt, descriptor(),
            self.requirement, adapter, self.payload,
            event_id_prefix="run-unexpected-pre-audit",
            recorded_at="2026-10-12T00:01:00Z", actor="system:test",
        )
        self.assertEqual(result.status, "audit_unavailable")
        self.assertEqual(adapter.calls, 0)

    def test_reused_event_prefix_blocks_second_dispatch(self):
        receipt = self.approve()
        adapter = Adapter()
        first = self.execute(adapter, receipt, prefix="stable-run-key")
        second = self.execute(adapter, receipt, prefix="stable-run-key")
        self.assertEqual(first.status, "response_received")
        self.assertEqual(second.status, "audit_unavailable")
        self.assertEqual(adapter.calls, 1)

    def test_unexpected_post_dispatch_audit_error_marks_outcome_incomplete(self):
        receipt = self.approve()
        adapter = Adapter()

        class FailFinishedEventStore:
            def read_all(inner_self):
                return self.store.read_all()

            def append(inner_self, **kwargs):
                if kwargs.get("event_type") == "mission.dispatch_finished":
                    raise RuntimeError("simulated unexpected backend error")
                return self.store.append(**kwargs)

        result = execute_mission_once(
            self.contract, FailFinishedEventStore(), receipt, descriptor(),
            self.requirement, adapter, self.payload,
            event_id_prefix="run-unexpected-post-audit",
            recorded_at="2026-10-12T00:01:00Z", actor="system:test",
        )
        self.assertEqual(result.status, "executed_audit_incomplete")
        self.assertEqual(result.reason, "post_dispatch_audit_failed_do_not_retry_blindly")
        self.assertEqual(adapter.calls, 1)


class ExecutionRegistryTests(unittest.TestCase):
    def setUp(self):
        from master_brain.execution_registry import SQLiteExecutionRegistry
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.db_path = str(Path(self.tmp.name) / "executions.sqlite3")
        self.registry = SQLiteExecutionRegistry(self.db_path, timeout=0.25)

    def reserve(self, key="key-1", mission_id="mission-1", contract="contract-a", payload="payload-a"):
        return self.registry.reserve(
            key=key, mission_id=mission_id, contract_digest=contract,
            payload_digest=payload, recorded_at="2026-10-12T00:00:00Z",
        )

    def test_duplicate_reservation_returns_existing_record_without_reclaiming(self):
        from master_brain.execution_registry import State
        first, created_first = self.reserve()
        self.registry.transition(
            key=first.key, expected_version=0, target=State.RUNNING,
            recorded_at="2026-10-12T00:00:01Z",
        )
        duplicate, created_second = self.reserve()
        self.assertTrue(created_first)
        self.assertFalse(created_second)
        self.assertEqual(duplicate.state, State.RUNNING)
        self.assertEqual(duplicate.version, 1)

    def test_same_key_with_changed_payload_is_rejected(self):
        from master_brain.execution_registry import IdempotencyConflict
        self.reserve()
        with self.assertRaises(IdempotencyConflict):
            self.reserve(payload="different-payload")

    def test_stale_version_and_illegal_transition_are_rejected(self):
        from master_brain.execution_registry import InvalidTransition, State
        record, _ = self.reserve()
        running = self.registry.transition(
            key=record.key, expected_version=0, target=State.RUNNING,
            recorded_at="2026-10-12T00:00:01Z",
        )
        with self.assertRaises(InvalidTransition):
            self.registry.transition(
                key=record.key, expected_version=0, target=State.SUCCEEDED,
                recorded_at="2026-10-12T00:00:02Z",
            )
        with self.assertRaises(InvalidTransition):
            self.registry.transition(
                key=record.key, expected_version=running.version, target=State.PENDING,
                recorded_at="2026-10-12T00:00:03Z",
            )

    def test_concurrent_reservations_create_exactly_one_record(self):
        from concurrent.futures import ThreadPoolExecutor

        def attempt(_):
            return self.reserve(key="shared-key")[1]

        with ThreadPoolExecutor(max_workers=8) as pool:
            outcomes = list(pool.map(attempt, range(24)))
        self.assertEqual(sum(outcomes), 1)
        self.assertEqual(self.registry.get("shared-key").state.value, "PENDING")

    def test_invalid_timeout_is_rejected(self):
        from master_brain.execution_registry import SQLiteExecutionRegistry
        for value in (-1, float("inf"), float("nan"), True):
            with self.subTest(timeout=value):
                with self.assertRaises(ValueError):
                    SQLiteExecutionRegistry(str(Path(self.tmp.name) / f"bad-{value}.sqlite3"), timeout=value)


    def test_corrupt_persisted_state_fails_closed(self):
        from master_brain.execution_registry import RegistryError
        self.reserve(key="corrupt-key")
        with sqlite3.connect(self.db_path) as db:
            db.execute("UPDATE executions SET state='MAGIC_SUCCESS' WHERE key='corrupt-key'")
        with self.assertRaises(RegistryError):
            self.registry.get("corrupt-key")

    def test_lock_contention_respects_configured_timeout(self):
        from master_brain.execution_registry import RegistryError
        blocker = sqlite3.connect(self.db_path, timeout=0.1, isolation_level=None)
        self.addCleanup(blocker.close)
        blocker.execute("BEGIN IMMEDIATE")
        started = time.monotonic()
        try:
            with self.assertRaises(RegistryError):
                self.reserve(key="blocked-key")
            elapsed = time.monotonic() - started
            self.assertGreaterEqual(elapsed, 0.15)
            self.assertLess(elapsed, 1.5)
        finally:
            blocker.rollback()

    def test_terminal_duplicate_reservation_does_not_create_new_execution(self):
        from master_brain.execution_registry import State
        record, created = self.reserve(key="terminal-key")
        self.assertTrue(created)
        self.registry.transition(
            key=record.key, expected_version=0, target=State.RUNNING,
            recorded_at="2026-10-12T00:00:01Z",
        )
        self.registry.transition(
            key=record.key, expected_version=1, target=State.FAILED,
            recorded_at="2026-10-12T00:00:02Z",
        )
        duplicate, created_again = self.reserve(key="terminal-key")
        self.assertFalse(created_again)
        self.assertEqual(duplicate.state, State.FAILED)
        self.assertEqual(duplicate.version, 2)


    def test_success_state_is_blocked_without_evidence_aware_api(self):
        from master_brain.execution_registry import InvalidTransition, State
        record, _ = self.reserve(key="no-proof-success")
        running = self.registry.transition(
            key=record.key, expected_version=0, target=State.RUNNING,
            recorded_at="2026-10-12T00:00:01Z",
        )
        with self.assertRaisesRegex(InvalidTransition, "verified completion evidence"):
            self.registry.transition(
                key=record.key, expected_version=running.version, target=State.SUCCEEDED,
                recorded_at="2026-10-12T00:00:02Z",
            )
        persisted = self.registry.get(record.key)
        self.assertEqual(persisted.state, State.RUNNING)
        self.assertEqual(persisted.version, running.version)



class IdempotentMissionExecutionTests(unittest.TestCase):
    def setUp(self):
        from master_brain.execution_registry import SQLiteExecutionRegistry
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        root = Path(self.tmp.name)
        self.store = AuditStore(root / "audit.jsonl")
        self.registry = SQLiteExecutionRegistry(str(root / "executions.sqlite3"), timeout=0.25)
        self.contract = MissionContract(
            mission_id="mission-idempotent", objective="Execute once",
            risk_tier=MissionRiskTier.HIGH, requires_approval=True,
        )
        self.requirement = IntegrationRequirement(
            ("text_reasoning",), required_kind=IntegrationKind.MODEL,
        )
        self.payload = {"mission_id": self.contract.mission_id, "prompt": "stable"}
        self.receipt = record_mission_approval(
            self.store, self.contract, event_id="approval-idempotent",
            recorded_at="2026-10-12T00:00:00Z",
            approver_subject="user:reviewer",
            authentication_method="upstream-session",
        )

    def execute(self, adapter, *, key="stable-key", payload=None, prefix="idempotent-run"):
        return execute_mission_idempotently(
            self.contract, self.store, self.receipt, descriptor(), self.requirement,
            adapter, self.payload if payload is None else payload, self.registry,
            idempotency_key=key, event_id_prefix=prefix,
            recorded_at="2026-10-12T00:01:00Z", actor="system:test",
        )

    def test_duplicate_request_never_invokes_adapter_twice(self):
        from master_brain.execution_registry import State
        adapter = Adapter()
        first = self.execute(adapter)
        second = self.execute(adapter)
        self.assertEqual(first.status, "response_received")
        self.assertIn("registry_state:OUTCOME_UNKNOWN", first.reason)
        self.assertEqual(second.status, "duplicate_existing_execution")
        self.assertEqual(adapter.calls, 1)
        self.assertEqual(self.registry.get("stable-key").state, State.OUTCOME_UNKNOWN)

    def test_changed_payload_for_same_key_is_rejected_before_dispatch(self):
        adapter = Adapter()
        first = self.execute(adapter)
        conflict = self.execute(adapter, payload={"mission_id": self.contract.mission_id, "prompt": "changed"})
        self.assertEqual(first.status, "response_received")
        self.assertEqual(conflict.status, "idempotency_conflict")
        self.assertEqual(adapter.calls, 1)

    def test_pre_dispatch_audit_failure_marks_failed_without_adapter_call(self):
        from master_brain.execution_registry import State
        adapter = Adapter()

        class FailingAppendStore:
            def read_all(inner_self):
                return self.store.read_all()

            def append(inner_self, **kwargs):
                if kwargs.get("event_type") == "mission.dispatch_started":
                    raise RuntimeError("simulated audit failure")
                return self.store.append(**kwargs)

        result = execute_mission_idempotently(
            self.contract, FailingAppendStore(), self.receipt, descriptor(),
            self.requirement, adapter, self.payload, self.registry,
            idempotency_key="audit-fail-key", event_id_prefix="audit-fail-run",
            recorded_at="2026-10-12T00:01:00Z", actor="system:test",
        )
        self.assertEqual(result.status, "audit_unavailable")
        self.assertEqual(adapter.calls, 0)
        self.assertEqual(self.registry.get("audit-fail-key").state, State.FAILED)



if __name__ == "__main__":
    unittest.main()
