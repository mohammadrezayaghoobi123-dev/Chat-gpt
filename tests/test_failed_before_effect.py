"""Gate 3e: an adapter that EXPLICITLY claims "I failed before any external effect" is a definite failure — but only
for risk-0 read-only integrations. Everything else stays outcome_unknown (the conservative default)."""
import unittest

from master_brain.dispatch import DispatchStatus, FailedBeforeEffect, dispatch_once
from master_brain.integrations import (IntegrationDescriptor, IntegrationHealth, IntegrationKind,
                                       IntegrationMaturity, IntegrationRequirement)
from master_brain.mission_execution import execute_mission_once
from master_brain.mission_lifecycle import MissionState, derive_mission_state
from tests.test_mission_execution import PipelineFixture


def desc(kind=IntegrationKind.DATA_SOURCE, risk=0, scopes=()):
    return IntegrationDescriptor(
        integration_id="t-int", version="1", kind=kind, capabilities=("text_reasoning",),
        maturity=IntegrationMaturity.ENABLED, health=IntegrationHealth.AVAILABLE, risk_level=risk,
        estimated_cost_per_call=0.0, permission_scopes=scopes)


class Raises:
    def __init__(self, error):
        self.error, self.calls = error, 0

    def invoke(self, payload):
        self.calls += 1
        raise self.error


REQ = IntegrationRequirement(("text_reasoning",), max_risk_level=4)
PAYLOAD = {"q": 1}


class DispatchRules(unittest.TestCase):
    def run_it(self, descriptor, error, **kw):
        adapter = Raises(error)
        return dispatch_once(descriptor, REQ, adapter, PAYLOAD, **kw), adapter

    def test_explicit_claim_on_a_risk_zero_data_source_is_a_definite_failure(self):
        result, adapter = self.run_it(desc(), FailedBeforeEffect("SECRET-DETAIL"))
        self.assertIs(result.status, DispatchStatus.FAILED_BEFORE_EFFECT)
        self.assertEqual(result.reason, "adapter_failed_before_effect")
        self.assertEqual(adapter.calls, 1)  # invoked exactly once, never retried here
        self.assertNotIn("SECRET-DETAIL", repr(result))
        self.assertFalse(result.successful)

    def test_subclasses_of_the_claim_count(self):
        class Mine(FailedBeforeEffect):
            pass
        self.assertIs(self.run_it(desc(), Mine("x"))[0].status, DispatchStatus.FAILED_BEFORE_EFFECT)

    def test_retrieval_tools_qualify_too(self):
        self.assertIs(self.run_it(desc(IntegrationKind.RETRIEVAL_TOOL), FailedBeforeEffect())[0].status,
                      DispatchStatus.FAILED_BEFORE_EFFECT)

    def test_the_claim_is_ignored_unless_risk_is_zero(self):
        for risk in (1, 2, 4):
            self.assertIs(self.run_it(desc(risk=risk), FailedBeforeEffect())[0].status, DispatchStatus.ADAPTER_ERROR, risk)

    def test_the_claim_is_ignored_for_every_kind_that_is_not_read_only(self):
        for kind in (IntegrationKind.MODEL, IntegrationKind.ACTION_TOOL, IntegrationKind.EVALUATOR, IntegrationKind.AGENT):
            self.assertIs(self.run_it(desc(kind), FailedBeforeEffect())[0].status, DispatchStatus.ADAPTER_ERROR, kind)

    def test_ordinary_exceptions_remain_outcome_unknown_even_for_data_sources(self):
        for error in (RuntimeError("x"), ValueError("x"), OSError("x"), Exception("x")):
            self.assertIs(self.run_it(desc(), error)[0].status, DispatchStatus.ADAPTER_ERROR, error)

    def test_the_claim_works_through_the_timeout_thread_too(self):
        result, _ = self.run_it(desc(), FailedBeforeEffect(), timeout_seconds=5)
        self.assertIs(result.status, DispatchStatus.FAILED_BEFORE_EFFECT)
        result, _ = self.run_it(desc(risk=1), FailedBeforeEffect(), timeout_seconds=5)
        self.assertIs(result.status, DispatchStatus.ADAPTER_ERROR)

    def test_a_timeout_is_still_unknown(self):
        import time

        class Slow:
            def invoke(self, payload):
                time.sleep(0.3)
                raise FailedBeforeEffect()
        result = dispatch_once(desc(), REQ, Slow(), PAYLOAD, timeout_seconds=0.05)
        self.assertIs(result.status, DispatchStatus.TIMEOUT)


class Pipeline(PipelineFixture):
    __test__ = True

    def setUp(self):
        super().setUp()
        self.requirement = IntegrationRequirement(("text_reasoning",), required_kind=IntegrationKind.DATA_SOURCE,
                                                  max_risk_level=2)

    def go(self, descriptor, error, prefix):
        receipt = self.approve()
        return execute_mission_once(self.contract, self.store, receipt, descriptor, self.requirement,
                                    Raises(error), self.payload, event_id_prefix=prefix,
                                    recorded_at="2026-10-12T00:01:00Z", actor="system:test")

    def test_a_definite_failure_is_dispatch_failed_and_the_mission_is_not_blocked(self):
        result = self.go(desc(), FailedBeforeEffect(), "ok1")
        self.assertEqual((result.status, result.reason), ("dispatch_failed", "adapter_failed_before_effect"))
        view = derive_mission_state(self.store, self.contract.mission_id)
        self.assertIs(view.state, MissionState.DISPATCH_FAILED_NO_EFFECT)
        self.assertEqual(view.anomalies, ())
        # a fresh attempt is allowed (no reconciliation needed) and can succeed
        class Works:
            def invoke(self, payload):
                return {"fine": True}
        again = execute_mission_once(self.contract, self.store, self.approve_again(), desc(), self.requirement,
                                     Works(), self.payload, event_id_prefix="ok2",
                                     recorded_at="2026-10-12T00:02:00Z", actor="system:test")
        self.assertEqual(again.status, "response_received")

    def approve_again(self):
        from master_brain.mission_approval import record_mission_approval
        from tests.approval_expiry_helper import soon
        return record_mission_approval(
            self.store, self.contract, event_id="approval-43", recorded_at="2026-10-12T00:01:30Z",
            approver_subject="user:reviewer", authentication_method="upstream-session", expires_at=soon())

    def test_the_same_claim_on_a_riskier_integration_still_blocks_the_mission(self):
        result = self.go(desc(risk=1), FailedBeforeEffect(), "bad1")
        self.assertEqual(result.status, "outcome_unknown")
        view = derive_mission_state(self.store, self.contract.mission_id)
        self.assertIs(view.state, MissionState.DISPATCH_UNRESOLVED)



class RegistryEdge(unittest.TestCase):
    """RUNNING -> FAILED exists only through the dedicated no-effect-claim method."""

    def setUp(self):
        import tempfile
        from pathlib import Path
        from master_brain.execution_registry import SQLiteExecutionRegistry
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.reg = SQLiteExecutionRegistry(str(Path(self.tmp.name) / "reg.sqlite3"))
        self.t = "2026-10-12T00:00:00Z"

    def running(self, key="key-aaaaaaaa"):
        from master_brain.execution_registry import State
        rec, _ = self.reg.reserve(key=key, mission_id="m-1", contract_digest="c" * 64,
                                  payload_digest="p" * 64, recorded_at=self.t)
        return self.reg.transition(key=key, expected_version=rec.version, target=State.RUNNING,
                                   recorded_at="2026-10-12T00:00:01Z")

    def test_generic_transition_still_refuses_running_to_failed(self):
        from master_brain.execution_registry import InvalidTransition, State
        run = self.running()
        with self.assertRaises(InvalidTransition):
            self.reg.transition(key=run.key, expected_version=run.version, target=State.FAILED,
                                recorded_at="2026-10-12T00:00:02Z")

    def test_the_dedicated_method_fails_a_running_record_and_frees_the_intent(self):
        from master_brain.execution_registry import State
        run = self.running()
        done = self.reg.fail_with_no_effect_claim(key=run.key, expected_version=run.version,
                                                  recorded_at="2026-10-12T00:00:02Z")
        self.assertIs(done.state, State.FAILED)
        again, _ = self.reg.reserve(key="key-bbbbbbbb", mission_id="m-1", contract_digest="c" * 64,
                                    payload_digest="p" * 64, recorded_at="2026-10-12T00:00:03Z")
        self.reg.transition(key=again.key, expected_version=again.version, target=State.RUNNING,
                            recorded_at="2026-10-12T00:00:04Z")  # no DuplicateIntent

    def test_the_dedicated_method_refuses_every_other_source_state(self):
        from master_brain.execution_registry import InvalidTransition, State
        rec, _ = self.reg.reserve(key="key-cccccccc", mission_id="m-2", contract_digest="c" * 64,
                                  payload_digest="q" * 64, recorded_at=self.t)
        with self.assertRaises(InvalidTransition):  # PENDING
            self.reg.fail_with_no_effect_claim(key=rec.key, expected_version=rec.version,
                                               recorded_at="2026-10-12T00:00:01Z")
        run = self.reg.transition(key=rec.key, expected_version=rec.version, target=State.RUNNING,
                                  recorded_at="2026-10-12T00:00:02Z")
        unk = self.reg.transition(key=rec.key, expected_version=run.version, target=State.OUTCOME_UNKNOWN,
                                  recorded_at="2026-10-12T00:00:03Z")
        with self.assertRaises(InvalidTransition):  # OUTCOME_UNKNOWN stays unresolved
            self.reg.fail_with_no_effect_claim(key=rec.key, expected_version=unk.version,
                                               recorded_at="2026-10-12T00:00:04Z")

    def test_a_stale_version_is_refused(self):
        from master_brain.execution_registry import InvalidTransition
        run = self.running()
        with self.assertRaises(InvalidTransition):
            self.reg.fail_with_no_effect_claim(key=run.key, expected_version=run.version - 1,
                                               recorded_at="2026-10-12T00:00:02Z")


if __name__ == "__main__":
    unittest.main()
