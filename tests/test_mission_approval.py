import tempfile
import unittest
from pathlib import Path

from master_brain.audit_store import AuditStore, AuditStoreError
from master_brain.core import RiskTier, Task
from master_brain.mission_approval import (
    evaluate_approved_execution_gate,
    mission_contract_digest,
    record_mission_approval,
)
from master_brain.mission_contract import from_core_task


class MissionApprovalTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tempdir.cleanup)
        self.store = AuditStore(Path(self.tempdir.name) / "audit.jsonl")
        self.contract = from_core_task(Task(
            objective="Deploy production release",
            constraints=("preserve audit history",),
            risk=RiskTier.HIGH,
        ))

    def approve(self, contract=None, **kwargs):
        return record_mission_approval(
            self.store,
            contract or self.contract,
            event_id=kwargs.get("event_id", "approval-001"),
            recorded_at="2026-10-11T12:00:00Z",
            approver_subject=kwargs.get("approver_subject", "user:reviewer-7"),
            authentication_method=kwargs.get("authentication_method", "upstream-session"),
        )

    def test_missing_approval_fails_closed(self):
        result = evaluate_approved_execution_gate(self.contract, self.store, None)
        self.assertFalse(result.allowed)
        self.assertIn("required human approval receipt is missing", result.reasons)

    def test_valid_approval_is_bound_to_exact_contract(self):
        receipt = self.approve()
        result = evaluate_approved_execution_gate(self.contract, self.store, receipt)
        self.assertTrue(result.allowed)
        self.assertEqual(result.reasons, ())
        self.assertEqual(receipt.contract_digest, mission_contract_digest(self.contract))

    def test_changed_contract_invalidates_receipt(self):
        receipt = self.approve()
        changed = from_core_task(Task(
            objective="Deploy production release",
            constraints=("preserve audit history", "require canary"),
            risk=RiskTier.HIGH,
        ), mission_id=self.contract.mission_id)
        result = evaluate_approved_execution_gate(changed, self.store, receipt)
        self.assertFalse(result.allowed)
        self.assertIn("approval receipt belongs to a different mission", result.reasons)
        self.assertIn("mission contract changed after approval", result.reasons)

    def test_receipt_cannot_be_replayed_for_another_mission(self):
        receipt = self.approve()
        other = from_core_task(Task(
            objective="Delete production data",
            risk=RiskTier.CRITICAL,
        ))
        result = evaluate_approved_execution_gate(other, self.store, receipt)
        self.assertFalse(result.allowed)

    def test_blank_approver_or_authentication_method_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "approver_subject"):
            self.approve(approver_subject="  ")
        with self.assertRaisesRegex(ValueError, "authentication_method"):
            self.approve(authentication_method="")

    def test_duplicate_event_id_is_rejected(self):
        self.approve()
        with self.assertRaisesRegex(AuditStoreError, "duplicate event_id"):
            self.approve()

    def test_tampered_audit_history_fails_closed(self):
        receipt = self.approve()
        path = self.store.path
        path.write_text(path.read_text(encoding="utf-8").replace(
            '"decision":"approved"', '"decision":"denied"'
        ), encoding="utf-8")
        result = evaluate_approved_execution_gate(self.contract, self.store, receipt)
        self.assertFalse(result.allowed)
        self.assertIn("verified audit history is unavailable or invalid", result.reasons)

    def test_non_approval_contract_does_not_need_receipt(self):
        low_risk = from_core_task(Task(
            objective="Summarize a public report",
            risk=RiskTier.LOW,
        ))
        result = evaluate_approved_execution_gate(low_risk, self.store, None)
        self.assertTrue(result.allowed)

    def test_approval_write_fails_closed_on_tampered_history(self):
        self.approve()
        path = self.store.path
        path.write_text(path.read_text(encoding="utf-8").replace(
            '"decision":"approved"', '"decision":"denied"'
        ), encoding="utf-8")
        with self.assertRaises(AuditStoreError):
            self.approve(event_id="approval-002")

    def test_approval_requires_nonblank_metadata(self):
        with self.assertRaisesRegex(ValueError, "event_id"):
            self.approve(event_id="")


if __name__ == "__main__":
    unittest.main()
