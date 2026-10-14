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
from master_brain.execution_registry import SQLiteExecutionRegistry
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


    def test_corrupt_dispatch_boundary_flag_fails_closed(self):
        from master_brain.execution_registry import RegistryError, State

        for corrupt_value in (2, -1):
            with self.subTest(corrupt_value=corrupt_value):
                key = f"corrupt-boundary-{corrupt_value}"
                record, _ = self.reserve(key=key)
                running = self.registry.transition(
                    key=key, expected_version=record.version, target=State.RUNNING,
                    recorded_at="2026-10-12T00:00:01Z",
                )
                attempt = self.registry.reserve_attempt(
                    key=key, expected_version=running.version,
                    integration_id="integration-test", adapter_version="1",
                    provider_id="provider-test", recorded_at="2026-10-12T00:00:02Z",
                )
                with sqlite3.connect(self.db_path) as db:
                    db.execute(
                        "UPDATE execution_attempts SET dispatch_boundary_entered=? WHERE attempt_id=?",
                        (corrupt_value, attempt.attempt_id),
                    )
                with self.assertRaises(RegistryError):
                    self.registry.get_attempt(attempt.attempt_id)

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
            key=record.key, expected_version=0, target=State.FAILED,
            recorded_at="2026-10-12T00:00:01Z",
        )
        duplicate, created_again = self.reserve(key="terminal-key")
        self.assertFalse(created_again)
        self.assertEqual(duplicate.state, State.FAILED)
        self.assertEqual(duplicate.version, 1)


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

    def test_invalid_actor_is_rejected_before_reserving_execution(self):
        adapter = Adapter()
        result = execute_mission_idempotently(
            self.contract, self.store, self.receipt, descriptor(), self.requirement,
            adapter, self.payload, self.registry,
            idempotency_key="invalid-actor-key", event_id_prefix="valid-prefix",
            recorded_at="2026-10-12T00:01:00Z", actor="   ",
        )
        self.assertEqual(result.status, "rejected")
        self.assertEqual(adapter.calls, 0)
        self.assertIsNone(self.registry.get("invalid-actor-key"))

    def test_invalid_event_prefix_is_rejected_before_reserving_execution(self):
        adapter = Adapter()
        result = execute_mission_idempotently(
            self.contract, self.store, self.receipt, descriptor(), self.requirement,
            adapter, self.payload, self.registry,
            idempotency_key="invalid-prefix-key", event_id_prefix="   ",
            recorded_at="2026-10-12T00:01:00Z", actor="system:test",
        )
        self.assertEqual(result.status, "rejected")
        self.assertEqual(adapter.calls, 0)
        self.assertIsNone(self.registry.get("invalid-prefix-key"))

    def test_invalid_timestamp_is_rejected_before_reserving_execution(self):
        adapter = Adapter()
        result = execute_mission_idempotently(
            self.contract, self.store, self.receipt, descriptor(), self.requirement,
            adapter, self.payload, self.registry,
            idempotency_key="invalid-timestamp-key", event_id_prefix="valid-prefix",
            recorded_at="   ", actor="system:test",
        )
        self.assertEqual(result.status, "rejected")
        self.assertEqual(adapter.calls, 0)
        self.assertIsNone(self.registry.get("invalid-timestamp-key"))

    def test_malformed_timestamp_is_rejected_before_reserving_execution(self):
        adapter = Adapter()
        result = execute_mission_idempotently(
            self.contract, self.store, self.receipt, descriptor(), self.requirement,
            adapter, self.payload, self.registry,
            idempotency_key="malformed-timestamp-key", event_id_prefix="valid-prefix",
            recorded_at="yesterday-ish", actor="system:test",
        )
        self.assertEqual(result.status, "rejected")
        self.assertEqual(result.reason, "invalid_recorded_at")
        self.assertEqual(adapter.calls, 0)
        self.assertIsNone(self.registry.get("malformed-timestamp-key"))

    def test_timezone_naive_timestamp_is_rejected_before_reserving_execution(self):
        adapter = Adapter()
        result = execute_mission_idempotently(
            self.contract, self.store, self.receipt, descriptor(), self.requirement,
            adapter, self.payload, self.registry,
            idempotency_key="naive-timestamp-key", event_id_prefix="valid-prefix",
            recorded_at="2026-10-12T00:01:00", actor="system:test",
        )
        self.assertEqual(result.status, "rejected")
        self.assertEqual(result.reason, "invalid_recorded_at")
        self.assertEqual(adapter.calls, 0)
        self.assertIsNone(self.registry.get("naive-timestamp-key"))

    def test_blank_idempotency_key_is_rejected_as_input_error(self):
        adapter = Adapter()
        result = execute_mission_idempotently(
            self.contract, self.store, self.receipt, descriptor(), self.requirement,
            adapter, self.payload, self.registry,
            idempotency_key="   ", event_id_prefix="valid-prefix",
            recorded_at="2026-10-12T00:01:00Z", actor="system:test",
        )
        self.assertEqual(result.status, "rejected")
        self.assertEqual(adapter.calls, 0)

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

    def test_distinct_idempotency_keys_can_share_event_prefix_without_audit_collision(self):
        adapter = Adapter()
        first = self.execute(adapter, key="separate-key-one", prefix="reused-human-prefix")
        second = self.execute(adapter, key="separate-key-two", prefix="reused-human-prefix")
        self.assertEqual(first.status, "response_received")
        self.assertEqual(second.status, "response_received")
        self.assertEqual(adapter.calls, 2)

    def test_concurrent_same_key_dispatches_adapter_exactly_once(self):
        from concurrent.futures import ThreadPoolExecutor
        from threading import Lock
        from master_brain.execution_registry import State

        class CountingAdapter:
            def __init__(self):
                self.calls = 0
                self.lock = Lock()

            def invoke(self, payload):
                with self.lock:
                    self.calls += 1
                time.sleep(0.03)
                return {"accepted": True}

        adapter = CountingAdapter()

        def invoke(index):
            return self.execute(
                adapter, key="concurrent-pipeline-key",
                prefix=f"concurrent-pipeline-{index}",
            )

        with ThreadPoolExecutor(max_workers=8) as pool:
            results = list(pool.map(invoke, range(16)))

        self.assertEqual(adapter.calls, 1)
        self.assertEqual(sum(r.status == "response_received" for r in results), 1)
        self.assertEqual(
            sum(r.status == "duplicate_existing_execution" for r in results), 15
        )
        self.assertEqual(
            self.registry.get("concurrent-pipeline-key").state, State.OUTCOME_UNKNOWN
        )

    def test_changed_payload_for_same_key_is_rejected_before_dispatch(self):
        adapter = Adapter()
        first = self.execute(adapter)
        conflict = self.execute(adapter, payload={"mission_id": self.contract.mission_id, "prompt": "changed"})
        self.assertEqual(first.status, "response_received")
        self.assertEqual(conflict.status, "idempotency_conflict")
        self.assertEqual(adapter.calls, 1)

    def test_pre_dispatch_audit_failure_stays_conservative_without_adapter_call(self):
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
        # The adapter was not called, but the registry has no trusted, dedicated
        # pre-dispatch abort transition yet. Keep the post-claim state conservative.
        self.assertEqual(self.registry.get("audit-fail-key").state, State.OUTCOME_UNKNOWN)



    def test_registry_update_failure_after_dispatch_blocks_blind_retry(self):
        from master_brain.execution_registry import RegistryError, State

        class FailAfterDispatchRegistry:
            def __init__(self, inner):
                self.inner = inner
                self.calls = 0

            def reserve(self, **kwargs):
                return self.inner.reserve(**kwargs)

            def get(self, key):
                return self.inner.get(key)

            def reserve_attempt(self, **kwargs):
                return self.inner.reserve_attempt(**kwargs)

            def mark_attempt_dispatch_boundary(self, **kwargs):
                return self.inner.mark_attempt_dispatch_boundary(**kwargs)

            def transition(self, **kwargs):
                self.calls += 1
                if kwargs.get("target") is State.OUTCOME_UNKNOWN:
                    raise RegistryError("simulated persistence failure after dispatch")
                return self.inner.transition(**kwargs)

        adapter = Adapter()
        guarded = FailAfterDispatchRegistry(self.registry)
        first = execute_mission_idempotently(
            self.contract, self.store, self.receipt, descriptor(), self.requirement,
            adapter, self.payload, guarded,
            idempotency_key="registry-write-fail-key", event_id_prefix="registry-write-fail-run",
            recorded_at="2026-10-12T00:01:00Z", actor="system:test",
        )
        second = execute_mission_idempotently(
            self.contract, self.store, self.receipt, descriptor(), self.requirement,
            adapter, self.payload, guarded,
            idempotency_key="registry-write-fail-key", event_id_prefix="registry-write-fail-run-2",
            recorded_at="2026-10-12T00:02:00Z", actor="system:test",
        )
        self.assertEqual(first.status, "execution_registry_incomplete")
        self.assertEqual(second.status, "duplicate_existing_execution")
        self.assertEqual(adapter.calls, 1)
        self.assertEqual(self.registry.get("registry-write-fail-key").state, State.RUNNING)

    def test_post_dispatch_audit_failure_keeps_unknown_and_blocks_duplicate(self):
        from master_brain.execution_registry import State

        class FailFinishedEventStore:
            def read_all(inner_self):
                return self.store.read_all()

            def append(inner_self, **kwargs):
                if kwargs.get("event_type") == "mission.dispatch_finished":
                    raise RuntimeError("simulated lost post-dispatch audit write")
                return self.store.append(**kwargs)

        adapter = Adapter()
        first = execute_mission_idempotently(
            self.contract, FailFinishedEventStore(), self.receipt, descriptor(),
            self.requirement, adapter, self.payload, self.registry,
            idempotency_key="post-audit-fail-key", event_id_prefix="post-audit-fail-run",
            recorded_at="2026-10-12T00:01:00Z", actor="system:test",
        )
        second = self.execute(
            adapter, key="post-audit-fail-key", prefix="post-audit-fail-run-retry"
        )

        self.assertEqual(first.status, "executed_audit_incomplete")
        self.assertEqual(second.status, "duplicate_existing_execution")
        self.assertEqual(adapter.calls, 1)
        self.assertEqual(
            self.registry.get("post-audit-fail-key").state, State.OUTCOME_UNKNOWN
        )

    def test_invalid_adapter_output_after_possible_side_effect_is_unknown_and_not_retried(self):
        from master_brain.execution_registry import State

        class SideEffectThenInvalidOutput:
            def __init__(self):
                self.calls = 0
                self.side_effects = 0

            def invoke(self, payload):
                self.calls += 1
                self.side_effects += 1
                # The external action may have completed, but the adapter's
                # response cannot be safely serialized/validated.
                return {"accepted": object()}

        adapter = SideEffectThenInvalidOutput()
        first = self.execute(adapter, key="invalid-output-key", prefix="invalid-output-run")
        second = self.execute(adapter, key="invalid-output-key", prefix="invalid-output-run-retry")

        self.assertEqual(first.status, "outcome_unknown")
        self.assertIn("registry_state:OUTCOME_UNKNOWN", first.reason)
        self.assertEqual(second.status, "duplicate_existing_execution")
        self.assertEqual(adapter.calls, 1)
        self.assertEqual(adapter.side_effects, 1)
        self.assertEqual(
            self.registry.get("invalid-output-key").state, State.OUTCOME_UNKNOWN
        )

    def test_adapter_exception_is_unknown_and_duplicate_is_not_retried(self):
        from master_brain.execution_registry import State

        class RaisingAdapter:
            def __init__(self):
                self.calls = 0

            def invoke(self, payload):
                self.calls += 1
                raise RuntimeError("simulated connection drop after provider may have accepted")

        adapter = RaisingAdapter()
        first = self.execute(adapter, key="exception-key", prefix="exception-run")
        second = self.execute(adapter, key="exception-key", prefix="exception-run-2")
        self.assertEqual(first.status, "outcome_unknown")
        self.assertIn("registry_state:OUTCOME_UNKNOWN", first.reason)
        self.assertEqual(second.status, "duplicate_existing_execution")
        self.assertEqual(adapter.calls, 1)
        self.assertEqual(self.registry.get("exception-key").state, State.OUTCOME_UNKNOWN)



    def test_dispatch_audit_events_share_durable_attempt_id(self):
        adapter = Adapter()
        result = self.execute(
            adapter, key="attempt-audit-correlation-key",
            prefix="attempt-audit-correlation",
        )
        self.assertEqual(result.status, "response_received")
        events = [
            event for event in self.store.read_all()
            if event.event_type in ("mission.dispatch_started", "mission.dispatch_finished")
        ]
        self.assertEqual(len(events), 2)
        attempt_ids = [event.payload.get("attempt_id") for event in events]
        self.assertTrue(all(isinstance(value, str) and value for value in attempt_ids))
        self.assertEqual(attempt_ids[0], attempt_ids[1])
        attempt = self.registry.get_attempt(attempt_ids[0])
        self.assertEqual(attempt.key, "attempt-audit-correlation-key")


class ActionBoundApprovalTests(MissionExecutionPipelineTests):
    """Finding APPR: a contract-only approval authorized any payload/integration."""

    def bound_receipt(self):
        from master_brain.mission_approval import action_digest
        return record_mission_approval(
            self.store, self.contract, event_id="approval-bound",
            recorded_at="2026-10-12T00:00:00Z",
            approver_subject="user:reviewer", authentication_method="upstream-session",
            action_digest=action_digest("test-model", self.payload),
        )

    def test_bound_approval_allows_exactly_the_approved_action(self):
        adapter = Adapter()
        result = self.execute(adapter, self.bound_receipt())
        self.assertEqual(result.status, "response_received")
        self.assertEqual(adapter.calls, 1)

    def test_bound_approval_rejects_changed_payload(self):
        receipt = self.bound_receipt()
        self.payload = {"mission_id": "mission-42", "prompt": "SOMETHING ELSE"}
        adapter = Adapter()
        result = self.execute(adapter, receipt)
        self.assertEqual(result.status, "rejected")
        self.assertIn("differs from the approved action", result.reason)
        self.assertEqual(adapter.calls, 0)

    def test_bound_approval_rejects_unserializable_payload(self):
        receipt = self.bound_receipt()
        self.payload = {"bad": object()}
        adapter = Adapter()
        self.assertEqual(self.execute(adapter, receipt).status, "rejected")
        self.assertEqual(adapter.calls, 0)

    def test_tampered_receipt_binding_is_rejected_by_audit_history(self):
        from dataclasses import replace
        from master_brain.mission_approval import action_digest
        legacy = self.approve()
        forged = replace(legacy, action_digest=action_digest("test-model", self.payload))
        adapter = Adapter()
        self.assertEqual(self.execute(adapter, forged).status, "rejected")
        self.assertEqual(adapter.calls, 0)

    def test_contract_only_approval_remains_unbound_legacy_behavior(self):
        # Documents the residual weakness: an unbound approval covers any payload.
        receipt = self.approve()
        self.payload = {"anything": "else"}
        adapter = Adapter()
        self.assertEqual(self.execute(adapter, receipt).status, "response_received")


class DispatchTimeoutPipelineTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.store = AuditStore(Path(self.tmp.name) / "audit.jsonl")
        self.registry = SQLiteExecutionRegistry(str(Path(self.tmp.name) / "registry.sqlite3"))
        self.contract = MissionContract(
            mission_id="mission-timeout", objective="Timeout test",
            risk_tier=MissionRiskTier.HIGH, requires_approval=True,
        )
        self.requirement = IntegrationRequirement(("text_reasoning",), required_kind=IntegrationKind.MODEL)
        self.payload = {"mission_id": "mission-timeout"}
        self.receipt = record_mission_approval(
            self.store, self.contract, event_id="approval-timeout",
            recorded_at="2026-10-12T00:00:00Z",
            approver_subject="user:reviewer", authentication_method="upstream-session",
        )

    def test_timeout_is_outcome_unknown_and_registry_blocks_blind_retry(self):
        import threading
        release = threading.Event()

        class Hung:
            calls = 0

            def invoke(self, payload):
                Hung.calls += 1
                release.wait(5)
                return {"ok": True}

        self.addCleanup(release.set)
        first = execute_mission_idempotently(
            self.contract, self.store, self.receipt, descriptor(), self.requirement,
            Hung(), self.payload, self.registry, idempotency_key="timeout-key",
            event_id_prefix="timeout-run", recorded_at="2026-10-12T00:01:00Z",
            actor="system:test", dispatch_timeout_seconds=0.1,
        )
        self.assertEqual(first.status, "outcome_unknown")
        self.assertEqual(first.dispatch_result.status, DispatchStatus.TIMEOUT)
        self.assertEqual(self.registry.get("timeout-key").state.value, "OUTCOME_UNKNOWN")
        second = execute_mission_idempotently(
            self.contract, self.store, self.receipt, descriptor(), self.requirement,
            Hung(), self.payload, self.registry, idempotency_key="timeout-key",
            event_id_prefix="timeout-run-2", recorded_at="2026-10-12T00:02:00Z",
            actor="system:test", dispatch_timeout_seconds=0.1,
        )
        self.assertEqual(second.status, "duplicate_existing_execution")
        self.assertEqual(Hung.calls, 1)


if __name__ == "__main__":
    unittest.main()
