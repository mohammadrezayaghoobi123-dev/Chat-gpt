import tempfile
import unittest
from dataclasses import replace
from pathlib import Path

from master_brain.audit_store import AuditStore, AuditStoreError
from master_brain.core import RiskTier, Task
from master_brain.mission_approval import (
    action_digest,
    evaluate_approved_execution_gate,
    mission_contract_digest,
    record_mission_approval,
)
from master_brain.mission_contract import (
    MissionReviewLevel,
    MissionRiskTier,
    from_core_task,
)


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
        self.assertNotIn("approval receipt belongs to a different mission", result.reasons)
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

    def test_malformed_receipt_type_fails_closed(self):
        result = evaluate_approved_execution_gate(self.contract, self.store, "not-a-receipt")
        self.assertFalse(result.allowed)
        self.assertIn("approval receipt has an invalid type", result.reasons)

    def test_non_string_receipt_metadata_fails_closed(self):
        receipt = self.approve()
        malformed = replace(receipt, approver_subject=None)
        result = evaluate_approved_execution_gate(self.contract, self.store, malformed)
        self.assertFalse(result.allowed)
        self.assertIn(
            "approval receipt field approver_subject must be a string",
            result.reasons,
        )

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

    def test_direct_blank_contract_fails_closed_even_without_receipt(self):
        from master_brain.mission_contract import MissionContract
        blank = MissionContract(mission_id="mission-empty-direct", objective="")
        result = evaluate_approved_execution_gate(blank, self.store, None)
        self.assertFalse(result.allowed)
        self.assertIn("mission objective is empty and requires clarification", result.reasons)

    def test_non_approval_contract_does_not_need_receipt(self):
        low_risk = from_core_task(Task(
            objective="Summarize a public report",
            risk=RiskTier.LOW,
        ))
        result = evaluate_approved_execution_gate(low_risk, self.store, None)
        self.assertTrue(result.allowed)

    def test_high_risk_flag_mismatch_fails_closed(self):
        contract = from_core_task(Task(
            objective="Summarize a public report",
            risk=RiskTier.LOW,
        ))
        # Simulate an invalid/deserialized object that bypassed dataclass validation.
        object.__setattr__(contract, "risk_tier", MissionRiskTier.HIGH)
        object.__setattr__(contract, "requires_approval", False)
        result = evaluate_approved_execution_gate(contract, self.store, None)
        self.assertFalse(result.allowed)
        self.assertIn("mission contract failed integrity validation", result.reasons[0])

    def test_human_gated_flag_mismatch_fails_closed(self):
        contract = from_core_task(Task(
            objective="Summarize a public report",
            risk=RiskTier.LOW,
        ))
        # Defense in depth for malformed objects created outside normal constructors.
        object.__setattr__(contract, "review_level", MissionReviewLevel.HUMAN_GATED)
        object.__setattr__(contract, "requires_approval", False)
        result = evaluate_approved_execution_gate(contract, self.store, None)
        self.assertFalse(result.allowed)
        self.assertIn("mission contract failed integrity validation", result.reasons[0])

    def test_approval_recording_rejects_inconsistent_contract(self):
        contract = from_core_task(Task(
            objective="Summarize a public report",
            risk=RiskTier.LOW,
        ))
        object.__setattr__(contract, "risk_tier", MissionRiskTier.CRITICAL)
        object.__setattr__(contract, "requires_approval", False)
        with self.assertRaisesRegex(ValueError, "mission contract failed integrity validation"):
            self.approve(contract=contract)

    def test_non_string_objective_fails_closed_at_gate(self):
        contract = from_core_task(Task(
            objective="Summarize a public report",
            risk=RiskTier.LOW,
        ))
        object.__setattr__(contract, "objective", None)
        result = evaluate_approved_execution_gate(contract, self.store, None)
        self.assertFalse(result.allowed)
        self.assertIn("mission contract failed integrity validation", result.reasons[0])

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

    def test_blank_or_non_string_action_digest_is_rejected_with_value_error(self):
        for bad in ("", "   ", 5, b"abc", ["x"]):
            with self.subTest(bad=bad), self.assertRaisesRegex(ValueError, "action_digest"):
                record_mission_approval(
                    self.store, self.contract, event_id=f"bad-{id(bad)}",
                    recorded_at="2026-10-11T12:00:00Z", approver_subject="user:r",
                    authentication_method="upstream-session", action_digest=bad,
                )
        self.assertEqual(self.store.read_all(), ())


class ActionDigestPinningTests(unittest.TestCase):
    """The canonical form of action_digest is a persisted contract; pin it independently."""

    def test_digest_is_sha256_of_the_documented_canonical_json(self):
        import hashlib
        canonical = '{"integration_id":"integ","payload":{"a":1,"b":"\u00e9\u4e2d"}}'
        expected = hashlib.sha256(canonical.encode("utf-8")).hexdigest()
        self.assertEqual(action_digest("integ", {"b": "é中", "a": 1}), expected)

    def test_key_order_does_not_change_the_digest_but_content_does(self):
        self.assertEqual(action_digest("i", {"a": 1, "b": 2}), action_digest("i", {"b": 2, "a": 1}))
        self.assertNotEqual(action_digest("i", {"a": 1}), action_digest("i", {"a": 2}))
        self.assertNotEqual(action_digest("i", {"a": 1}), action_digest("j", {"a": 1}))

    def test_invalid_integration_and_non_finite_payload_are_rejected(self):
        for bad in ("", "   ", None, 5):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                action_digest(bad, {})
        for payload in ({"x": float("nan")}, {"x": float("inf")}):
            with self.subTest(payload=payload), self.assertRaises((TypeError, ValueError)):
                action_digest("i", payload)


if __name__ == "__main__":
    unittest.main()
