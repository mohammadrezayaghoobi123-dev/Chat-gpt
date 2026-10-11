import tempfile
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
from master_brain.mission_execution import execute_mission_once


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


if __name__ == "__main__":
    unittest.main()
