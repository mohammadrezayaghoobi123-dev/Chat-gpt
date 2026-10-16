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


class PipelineFixture(unittest.TestCase):
    __test__ = False

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.store = AuditStore(Path(self.tmp.name) / "audit.jsonl")
        self.contract = MissionContract(
            mission_id="mission-42", objective="Execute controlled test",
            risk_tier=MissionRiskTier.MEDIUM, requires_approval=True,
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


class MissionExecutionPipelineTests(PipelineFixture):
    __test__ = True

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
                # distinct payload per subtest: identical intents under different keys are rejected (finding A3)
                record, _ = self.reserve(key=key, payload=f"payload-{corrupt_value}")
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
            risk_tier=MissionRiskTier.MEDIUM, requires_approval=True,
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
        # Different intents (payloads) so A3 same-intent uniqueness does not apply;
        # the test's purpose is audit-id collision safety with a shared prefix.
        first = self.execute(adapter, key="separate-key-one", prefix="reused-human-prefix",
                             payload={"mission_id": self.contract.mission_id, "prompt": "one"})
        second = self.execute(adapter, key="separate-key-two", prefix="reused-human-prefix",
                              payload={"mission_id": self.contract.mission_id, "prompt": "two"})
        self.assertEqual(first.status, "response_received")
        self.assertEqual(second.status, "response_received")
        self.assertEqual(adapter.calls, 2)

    def test_same_intent_under_other_keys_never_repeats_effect(self):
        from master_brain.execution_registry import State
        adapter = Adapter()
        results = [self.execute(adapter, key=f"dup-key-{i}", prefix=f"dup-{i}") for i in range(3)]
        self.assertEqual([r.status for r in results],
                         ["response_received", "duplicate_intent", "duplicate_intent"])
        self.assertEqual(adapter.calls, 1)
        self.assertEqual(self.registry.get("dup-key-1").state, State.FAILED)

    def test_different_payload_under_other_key_still_runs(self):
        adapter = Adapter()
        self.execute(adapter, key="intent-a", prefix="ia")
        other = self.execute(adapter, key="intent-b", prefix="ib",
                             payload={"mission_id": self.contract.mission_id, "prompt": "other"})
        self.assertEqual(other.status, "response_received")
        self.assertEqual(adapter.calls, 2)

    def test_concurrent_distinct_keys_same_intent_run_once(self):
        from concurrent.futures import ThreadPoolExecutor
        from threading import Lock

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
        with ThreadPoolExecutor(max_workers=6) as pool:
            results = list(pool.map(
                lambda i: self.execute(adapter, key=f"race-key-{i}", prefix=f"race-{i}"), range(6)))
        self.assertEqual(adapter.calls, 1)
        self.assertEqual(sum(r.status == "response_received" for r in results), 1)

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


class ActionBoundApprovalTests(PipelineFixture):
    __test__ = True
    """Finding APPR: a contract-only approval authorized any payload/integration."""

    def bound_receipt(self):
        from master_brain.mission_approval import action_digest
        return record_mission_approval(
            self.store, self.contract, event_id="approval-bound",
            recorded_at="2026-10-12T00:00:00Z",
            approver_subject="user:reviewer", authentication_method="upstream-session",
            action_digest=action_digest("test-model", self.payload),
        )

    def test_high_and_critical_missions_cannot_execute_on_a_contract_only_approval(self):
        """Mandatory action binding for HIGH/CRITICAL: no adapter call, nothing dispatched."""
        for tier in (MissionRiskTier.HIGH, MissionRiskTier.CRITICAL):
            with self.subTest(tier=tier):
                self.contract = MissionContract(
                    mission_id="mission-42", objective="Execute controlled test",
                    risk_tier=tier, requires_approval=True)
                unbound = record_mission_approval(
                    self.store, self.contract, event_id=f"unbound-{tier.value}",
                    recorded_at="2026-10-12T00:00:00Z", approver_subject="user:reviewer",
                    authentication_method="upstream-session")
                adapter = Adapter()
                result = self.execute(adapter, unbound, prefix=f"hi-{tier.value}")
                self.assertEqual(result.status, "rejected")
                self.assertEqual(adapter.calls, 0)
                self.assertFalse(any(e.event_type == "mission.dispatch_started"
                                     for e in self.store.read_all()))

    def test_high_risk_mission_executes_with_a_bound_approval(self):
        from master_brain.mission_approval import action_digest
        self.contract = MissionContract(
            mission_id="mission-42", objective="Execute controlled test",
            risk_tier=MissionRiskTier.HIGH, requires_approval=True)
        receipt = record_mission_approval(
            self.store, self.contract, event_id="approval-high-bound",
            recorded_at="2026-10-12T00:00:00Z", approver_subject="user:reviewer",
            authentication_method="upstream-session",
            action_digest=action_digest("test-model", self.payload))
        adapter = Adapter()
        self.assertEqual(self.execute(adapter, receipt).status, "response_received")
        self.assertEqual(adapter.calls, 1)

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
            risk_tier=MissionRiskTier.MEDIUM, requires_approval=True,
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


class ContractRiskCeilingTests(unittest.TestCase):
    """Effective risk comes from the contract; a caller requirement can only narrow it."""

    EXPECTED_CEILING = {"low": 1, "medium": 2, "high": 3, "critical": 4}

    def run_case(self, tier, requested, idempotent=False):
        from master_brain.execution_registry import SQLiteExecutionRegistry
        from master_brain.mission_approval import action_digest
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        root = Path(tmp.name)
        store = AuditStore(root / "audit.jsonl")
        contract = MissionContract(mission_id="m-risk", objective="Risk ceiling",
                                   risk_tier=tier, requires_approval=True)
        payload = {"a": 1}
        receipt = record_mission_approval(
            store, contract, event_id="approval-risk", recorded_at="2026-10-12T00:00:00Z",
            approver_subject="user:r", authentication_method="upstream-session",
            action_digest=action_digest("test-model", payload),
        )
        integration = IntegrationDescriptor(
            integration_id="test-model", version="1", kind=IntegrationKind.MODEL,
            capabilities=("text_reasoning",), maturity=IntegrationMaturity.ENABLED,
            health=IntegrationHealth.AVAILABLE, risk_level=0, estimated_cost_per_call=0.0,
        )
        requirement = IntegrationRequirement(("text_reasoning",), max_risk_level=requested)
        adapter = Adapter()
        kwargs = dict(event_id_prefix="p", recorded_at="2026-10-12T00:01:00Z", actor="system:test")
        registry = None
        if idempotent:
            registry = SQLiteExecutionRegistry(str(root / "e.sqlite3"), timeout=0.25)
            result = execute_mission_idempotently(
                contract, store, receipt, integration, requirement, adapter, payload,
                registry, idempotency_key="k-risk", **kwargs)
        else:
            result = execute_mission_once(
                contract, store, receipt, integration, requirement, adapter, payload, **kwargs)
        return result, adapter, store, registry

    def test_ceiling_table_is_pinned(self):
        from master_brain.mission_execution import MAX_INTEGRATION_RISK_BY_TIER
        self.assertEqual({t.value: v for t, v in MAX_INTEGRATION_RISK_BY_TIER.items()},
                         self.EXPECTED_CEILING)

    def test_requirement_at_or_below_the_ceiling_runs_and_above_is_rejected(self):
        for idempotent in (False, True):
            for tier in MissionRiskTier:
                ceiling = self.EXPECTED_CEILING[tier.value]
                for requested in range(0, 5):
                    with self.subTest(tier=tier.value, requested=requested, idempotent=idempotent):
                        result, adapter, store, registry = self.run_case(tier, requested, idempotent)
                        if requested <= ceiling:
                            self.assertEqual(result.status, "response_received")
                            self.assertEqual(adapter.calls, 1)
                        else:
                            self.assertEqual((result.status, result.reason),
                                             ("rejected", "requirement_exceeds_contract_risk_ceiling"))
                            self.assertEqual(adapter.calls, 0)
                            self.assertEqual([e.event_type for e in store.read_all()],
                                             ["mission.approval_granted"])
                            if registry is not None:
                                self.assertIsNone(registry.get("k-risk"))

    def test_unknown_contract_tier_and_bad_requirement_types_are_rejected(self):
        from master_brain.mission_execution import _requirement_exceeds_contract_risk
        contract = MissionContract(mission_id="m", objective="o", risk_tier=MissionRiskTier.MEDIUM)
        self.assertIsNone(_requirement_exceeds_contract_risk(contract, IntegrationRequirement(("x",))))

        for bogus in ("bogus", None, 3):
            class Fake:
                risk_tier = bogus
            with self.subTest(bogus=bogus):
                self.assertEqual(
                    _requirement_exceeds_contract_risk(Fake(), IntegrationRequirement(("x",))),
                    "unknown_contract_risk_tier")

        class BadReq:
            max_risk_level = True
        self.assertEqual(_requirement_exceeds_contract_risk(contract, BadReq()),
                         "requirement_exceeds_contract_risk_ceiling")
        self.assertEqual(_requirement_exceeds_contract_risk(contract, object()),
                         "requirement_exceeds_contract_risk_ceiling")


class SingleUseApprovalTests(PipelineFixture):
    __test__ = True
    """Finding APPR-replay: one approved action ran 3x sequentially, 6x concurrently."""

    def bound(self):
        from master_brain.mission_approval import action_digest
        return record_mission_approval(
            self.store, self.contract, event_id="approval-once",
            recorded_at="2026-10-12T00:00:00Z", approver_subject="user:reviewer",
            authentication_method="upstream-session",
            action_digest=action_digest("test-model", self.payload),
        )

    def test_bound_approval_is_consumed_by_first_dispatch(self):
        receipt, adapter = self.bound(), Adapter()
        self.assertEqual(self.execute(adapter, receipt, prefix="a").status, "response_received")
        again = self.execute(adapter, receipt, prefix="b")
        self.assertEqual((again.status, again.reason), ("rejected", "approval_already_consumed"))
        self.assertEqual(adapter.calls, 1)

    def test_audit_rollback_cannot_unconsume_approval(self):
        """Finding C2: truncating the audit tail used to re-arm a consumed approval."""
        receipt, adapter = self.bound(), Adapter()
        self.assertEqual(self.execute(adapter, receipt, prefix="a").status, "response_received")
        lines = self.store.path.read_text(encoding="utf-8").splitlines(True)
        self.store.path.write_text("".join(lines[:1]), encoding="utf-8")  # keep approval only
        again = self.execute(adapter, receipt, prefix="b")
        self.assertNotEqual(again.status, "response_received")
        self.assertEqual(adapter.calls, 1)

    def test_concurrent_replays_dispatch_exactly_once(self):
        import threading
        receipt, adapter = self.bound(), Adapter()
        barrier, statuses = threading.Barrier(6), []

        def run(i):
            barrier.wait()
            statuses.append(self.execute(adapter, receipt, prefix=f"c{i}").status)

        threads = [threading.Thread(target=run, args=(i,)) for i in range(6)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        self.assertEqual(adapter.calls, 1)
        self.assertEqual(sorted(statuses), ["rejected"] * 5 + ["response_received"])

    def test_contract_only_approval_stays_reusable(self):
        receipt, adapter = self.approve(), Adapter()
        self.execute(adapter, receipt, prefix="x")
        self.execute(adapter, receipt, prefix="y")
        self.assertEqual(adapter.calls, 2)


class AdapterErrorAfterEffectPipelineTests(PipelineFixture):
    __test__ = True

    def test_parsing_errors_after_effect_are_outcome_unknown_not_dispatch_failed(self):
        import json
        receipt = self.approve()  # contract-only approval is reusable across subtests
        for error in (ValueError("x"), TypeError("x"), json.JSONDecodeError("m", "d", 0),
                      UnicodeDecodeError("utf-8", b"", 0, 1, "r"), OverflowError("x")):
            with self.subTest(error=type(error).__name__):
                class Effect:
                    effects = 0

                    def invoke(self, payload):
                        Effect.effects += 1
                        raise error

                result = self.execute(Effect(), receipt, prefix=f"e-{type(error).__name__}")
                self.assertEqual(Effect.effects, 1)
                self.assertEqual(result.status, "outcome_unknown")


class FlipMapping(__import__("collections.abc", fromlist=["Mapping"]).Mapping):
    """Returns the approved value on first read and a different one on every later read."""

    def __init__(self):
        self.reads = 0

    def __getitem__(self, key):
        if key != "amount":
            raise KeyError(key)
        self.reads += 1
        return 10 if self.reads == 1 else 99999

    def __iter__(self):
        return iter(("amount",))

    def __len__(self):
        return 1


class PayloadSnapshotTests(PipelineFixture):
    """Finding TOCTOU: the gate approved one payload, dispatch re-read a mutated one
    (adapter received amount=99999 under an approval for amount=10)."""
    __test__ = True

    def _bound_receipt(self, payload):
        from master_brain.mission_approval import action_digest
        return record_mission_approval(
            self.store, self.contract, event_id="approval-snap",
            recorded_at="2026-10-12T00:00:00Z", approver_subject="user:reviewer",
            authentication_method="upstream-session",
            action_digest=action_digest("test-model", payload),
        )

    def test_mutation_between_gate_and_dispatch_cannot_change_approved_payload(self):
        self.payload = {"amount": 10}
        receipt = self._bound_receipt(self.payload)
        seen = []

        class Recorder:
            def invoke(self, payload):
                seen.append(dict(payload))
                return {"ok": True}

        result = execute_mission_once(
            self.contract, self.store, receipt, descriptor(), self.requirement,
            Recorder(), self.payload, event_id_prefix="snap",
            recorded_at="2026-10-12T00:01:00Z", actor="system:test",
            before_dispatch=lambda: self.payload.__setitem__("amount", 99999),
        )
        self.assertEqual(result.status, "response_received")
        self.assertEqual(seen, [{"amount": 10}])

    def test_mapping_that_changes_after_first_read_dispatches_the_approved_value(self):
        receipt = self._bound_receipt({"amount": 10})
        seen = []

        class Recorder:
            def invoke(self, payload):
                seen.append(dict(payload))
                return {"ok": True}

        flip = FlipMapping()
        result = execute_mission_once(
            self.contract, self.store, receipt, descriptor(), self.requirement,
            Recorder(), flip, event_id_prefix="flip",
            recorded_at="2026-10-12T00:01:00Z", actor="system:test",
        )
        self.assertEqual(result.status, "response_received")
        self.assertEqual(seen, [{"amount": 10}])
        self.assertEqual(flip.reads, 1)  # exactly one read pass: snapshot, then reuse

    def test_idempotent_path_also_dispatches_the_approved_value(self):
        import tempfile as _t
        from pathlib import Path as _P
        registry = SQLiteExecutionRegistry(str(_P(self.tmp.name) / "snap.sqlite3"))
        receipt = self._bound_receipt({"amount": 10})
        seen = []

        class Recorder:
            def invoke(self, payload):
                seen.append(dict(payload))
                return {"ok": True}

        result = execute_mission_idempotently(
            self.contract, self.store, receipt, descriptor(), self.requirement,
            Recorder(), FlipMapping(), registry, idempotency_key="snap-key",
            event_id_prefix="snapi", recorded_at="2026-10-12T00:01:00Z", actor="system:test",
        )
        self.assertIn(result.status, ("response_received", "outcome_unknown"))
        self.assertEqual(seen, [{"amount": 10}])


if __name__ == "__main__":
    unittest.main()


class _Boom(__import__("collections.abc", fromlist=["Mapping"]).Mapping):
    def __init__(self, exc):
        self.exc = exc

    def __iter__(self):
        raise self.exc

    def __getitem__(self, key):
        raise self.exc

    def __len__(self):
        return 1


class MissionExecutionHelperTests(unittest.TestCase):
    """Pins the module's small pure helpers (found unguarded by mutation testing)."""

    def test_timezone_aware_timestamp_validation(self):
        from master_brain.mission_execution import _is_timezone_aware_timestamp as check
        for ok in ("2026-10-12T00:00:00Z", "2026-10-12T00:00:00+03:30", " 2026-10-12T00:00:00Z "):
            with self.subTest(ok=ok):
                self.assertIs(check(ok), True)
        for bad in ("", "   ", None, 5, "garbage", "2026-10-12T00:00:00", "2026-10-12"):
            with self.subTest(bad=bad):
                self.assertIs(check(bad), False)

    def test_result_is_immutable(self):
        from dataclasses import FrozenInstanceError
        from master_brain.mission_execution import MissionExecutionResult
        result = MissionExecutionResult("m", "ok")
        with self.assertRaises(FrozenInstanceError):
            result.status = "other"

    def test_snapshot_detaches_json_and_returns_non_json_unchanged(self):
        from master_brain.mission_execution import _snapshot_payload
        original = {"a": {"b": [1]}}
        copy_ = _snapshot_payload(original)
        self.assertEqual(copy_, original)
        self.assertIsNot(copy_, original)
        self.assertIsNot(copy_["a"], original["a"])
        for bad in ({"x": float("nan")}, {"x": object()}, _Boom(TypeError()), _Boom(ValueError()),
                    _Boom(OverflowError()), [1, 2], None):
            with self.subTest(bad=type(bad).__name__):
                self.assertIs(_snapshot_payload(bad), bad)

    def test_safe_action_digest_is_none_when_not_canonicalizable(self):
        from master_brain.mission_approval import action_digest
        from master_brain.mission_execution import _safe_action_digest
        self.assertEqual(_safe_action_digest(descriptor(), {"a": 1}),
                         action_digest("test-model", {"a": 1}))
        self.assertIsNone(_safe_action_digest(descriptor(), {"x": object()}))   # TypeError
        self.assertIsNone(_safe_action_digest(object(), {"a": 1}))              # empty id -> ValueError
        self.assertIsNone(_safe_action_digest(descriptor(), {"x": float("nan")}))


class MissionExecutionOnceHardeningTests(PipelineFixture):
    __test__ = True

    def run_once(self, receipt, **metadata):
        args = dict(event_id_prefix="run-x", recorded_at="2026-10-12T00:01:00Z", actor="system:test")
        args.update(metadata)
        self._adapter = Adapter()
        return execute_mission_once(
            self.contract, self.store, receipt, descriptor(), self.requirement, self._adapter,
            self.payload, **args,
        )

    def test_invalid_metadata_is_rejected_before_any_audit_or_dispatch(self):
        receipt = self.approve()
        reasons = {"event_id_prefix": "invalid_event_id_prefix",
                   "recorded_at": "invalid_recorded_at", "actor": "invalid_actor"}
        for field, reason in reasons.items():
            for bad in ("", "   ", None, 5):
                with self.subTest(field=field, bad=bad):
                    before = len(self.store.read_all())
                    result = self.run_once(receipt, **{field: bad})
                    self.assertEqual((result.status, result.reason), ("rejected", reason))
                    self.assertEqual(self._adapter.calls, 0)
                    self.assertEqual(len(self.store.read_all()), before)

    def test_dispatch_failures_are_reported_as_failed_not_unknown(self):
        receipt = self.approve()
        result = execute_mission_once(
            self.contract, self.store, receipt, descriptor(), self.requirement, None, self.payload,
            event_id_prefix="no-adapter", recorded_at="2026-10-12T00:01:00Z", actor="system:test")
        self.assertEqual((result.status, result.reason),
                         ("dispatch_failed", "adapter_missing_or_invalid"))
        bad_input = execute_mission_once(
            self.contract, self.store, receipt, descriptor(), self.requirement, Adapter(),
            {"x": object()}, event_id_prefix="bad-input", recorded_at="2026-10-12T00:01:00Z",
            actor="system:test")
        self.assertEqual((bad_input.status, bad_input.reason),
                         ("dispatch_failed", "input_not_json_compatible_object"))

    def test_before_dispatch_failure_never_invokes_adapter(self):
        receipt, adapter = self.approve(), Adapter()

        def boom():
            raise RuntimeError("persist failed")

        result = execute_mission_once(
            self.contract, self.store, receipt, descriptor(), self.requirement, adapter, self.payload,
            event_id_prefix="bd", recorded_at="2026-10-12T00:01:00Z", actor="system:test",
            before_dispatch=boom)
        self.assertEqual((result.status, result.reason), (
            "registry_unavailable", "dispatch_boundary_persistence_failed_adapter_not_invoked"))
        self.assertEqual(adapter.calls, 0)

    def test_consumption_is_per_approval_not_global(self):
        """A consumed approval must not block a different, independently approved action."""
        from master_brain.mission_approval import action_digest
        adapter = Adapter()
        digests = [action_digest("test-model", {"mission_id": "mission-42", "n": n}) for n in (1, 2)]
        receipts = [record_mission_approval(
            self.store, self.contract, event_id=f"approval-n{n}",
            recorded_at="2026-10-12T00:00:00Z", approver_subject="user:reviewer",
            authentication_method="upstream-session", action_digest=digests[n - 1])
            for n in (1, 2)]
        for n, receipt in enumerate(receipts, start=1):
            result = execute_mission_once(
                self.contract, self.store, receipt, descriptor(), self.requirement, adapter,
                {"mission_id": "mission-42", "n": n}, event_id_prefix=f"run-n{n}",
                recorded_at="2026-10-12T00:01:00Z", actor="system:test")
            self.assertEqual(result.status, "response_received", result.reason)
        self.assertEqual(adapter.calls, 2)
        started = [e for e in self.store.read_all() if e.event_type == "mission.dispatch_started"]
        self.assertEqual([e.payload["approval_event_id"] for e in started],
                         ["approval-n1", "approval-n2"])


class _FaultRegistry:
    """Delegates to a real registry but raises on chosen calls (fault injection)."""

    def __init__(self, inner, faults):
        self.inner, self.faults = inner, faults  # faults: {"reserve": exc, "claim": exc, "attempt": exc}

    def reserve(self, **kwargs):
        if "reserve" in self.faults:
            raise self.faults["reserve"]
        return self.inner.reserve(**kwargs)

    def transition(self, **kwargs):
        from master_brain.execution_registry import State as _State
        if "claim" in self.faults and kwargs.get("target") is _State.RUNNING:
            raise self.faults["claim"]
        return self.inner.transition(**kwargs)

    def reserve_attempt(self, **kwargs):
        if "attempt" in self.faults:
            raise self.faults["attempt"]
        return self.inner.reserve_attempt(**kwargs)

    def __getattr__(self, name):
        return getattr(self.inner, name)


class IdempotentMutationHardeningTests(unittest.TestCase):
    """Pins the idempotent pipeline's validation, canonical digest and fault handling."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        root = Path(self.tmp.name)
        self.store = AuditStore(root / "audit.jsonl")
        self.registry = SQLiteExecutionRegistry(str(root / "executions.sqlite3"), timeout=0.25)
        self.contract = MissionContract(
            mission_id="mission-h", objective="Execute once",
            risk_tier=MissionRiskTier.MEDIUM, requires_approval=True,
        )
        self.requirement = IntegrationRequirement(("text_reasoning",), required_kind=IntegrationKind.MODEL)
        self.payload = {"mission_id": "mission-h", "prompt": "stable"}
        self.receipt = record_mission_approval(
            self.store, self.contract, event_id="approval-h", recorded_at="2026-10-12T00:00:00Z",
            approver_subject="user:reviewer", authentication_method="upstream-session")

    def run_idem(self, adapter=None, registry=None, receipt="default", payload=None, **meta):
        args = dict(idempotency_key="key-h", event_id_prefix="prefix-h",
                    recorded_at="2026-10-12T00:01:00Z", actor="system:test")
        args.update(meta)
        return execute_mission_idempotently(
            self.contract, self.store, self.receipt if receipt == "default" else receipt,
            descriptor(), self.requirement, adapter, self.payload if payload is None else payload,
            registry or self.registry, **args)

    def test_unapproved_execution_is_rejected_without_touching_registry(self):
        adapter = Adapter()
        result = self.run_idem(adapter, receipt=None)
        self.assertEqual(result.status, "rejected")
        self.assertEqual(adapter.calls, 0)
        self.assertIsNone(self.registry.get("key-h"))

    def test_every_metadata_field_is_validated_before_reservation(self):
        for field in ("idempotency_key", "event_id_prefix", "actor"):
            for bad in ("", "   ", None, 5):
                with self.subTest(field=field, bad=bad):
                    adapter = Adapter()
                    result = self.run_idem(adapter, **{field: bad})
                    self.assertEqual((result.status, result.reason), ("rejected", f"invalid_{field}"))
                    self.assertEqual(adapter.calls, 0)
        for bad in ("", "garbage", "2026-10-12T00:00:00", None, 5):
            with self.subTest(field="recorded_at", bad=bad):
                result = self.run_idem(Adapter(), recorded_at=bad)
                self.assertEqual((result.status, result.reason), ("rejected", "invalid_recorded_at"))
        self.assertIsNone(self.registry.get("key-h"))

    def test_registered_payload_digest_is_canonical(self):
        import hashlib, json
        payload = {"mission_id": "mission-h", "z": 1, "a": "café", "m": {"y": 2, "x": 1}}
        self.run_idem(Adapter(), payload=payload)
        expected = hashlib.sha256(json.dumps(
            payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False,
        ).encode("utf-8")).hexdigest()
        self.assertEqual(self.registry.get("key-h").payload_digest, expected)

    def test_payloads_that_cannot_be_digested_never_reserve_or_dispatch(self):
        for bad in ({"x": float("nan")}, {"x": object()}):
            with self.subTest(bad=repr(bad)[:20]):
                adapter = Adapter()
                result = self.run_idem(adapter, payload=bad)
                self.assertEqual((result.status, result.reason),
                                 ("registry_unavailable", "reservation_failed"))
                self.assertEqual(adapter.calls, 0)
                self.assertIsNone(self.registry.get("key-h"))

    def test_registry_faults_never_invoke_the_adapter(self):
        from master_brain.execution_registry import RegistryError
        cases = (
            ({"reserve": RegistryError("down")}, "reservation_failed"),
            ({"reserve": TypeError("t")}, "reservation_failed"),
            ({"reserve": ValueError("v")}, "reservation_failed"),
            ({"claim": RegistryError("down")}, "claim_failed_adapter_not_invoked"),
            ({"attempt": RegistryError("down")}, "attempt_reservation_or_boundary_failed_adapter_not_invoked"),
            ({"attempt": TypeError("t")}, "attempt_reservation_or_boundary_failed_adapter_not_invoked"),
            ({"attempt": ValueError("v")}, "attempt_reservation_or_boundary_failed_adapter_not_invoked"),
        )
        for index, (faults, reason) in enumerate(cases):
            with self.subTest(faults=sorted(faults), exc=type(next(iter(faults.values()))).__name__):
                adapter = Adapter()
                # distinct payload per case: a faulted run can leave a RUNNING row, and the
                # same intent under another key is (correctly) rejected as duplicate_intent
                result = self.run_idem(adapter, registry=_FaultRegistry(self.registry, faults),
                                       idempotency_key=f"fault-{index}",
                                       payload={"mission_id": self.contract.mission_id, "case": index})
                self.assertEqual((result.status, result.reason), ("registry_unavailable", reason))
                self.assertEqual(adapter.calls, 0)

    def test_audit_event_ids_use_a_sixteen_character_key_hash(self):
        import hashlib
        self.run_idem(Adapter())
        suffix = hashlib.sha256(b"key-h").hexdigest()[:16]
        ids = [e.event_id for e in self.store.read_all() if e.event_type.startswith("mission.dispatch")]
        self.assertEqual(ids, [f"prefix-h:{suffix}:dispatch-started", f"prefix-h:{suffix}:dispatch-finished"])
