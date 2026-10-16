import tempfile
import unittest
from dataclasses import replace
from datetime import datetime, timedelta, timezone
from pathlib import Path

from master_brain.audit_store import AuditStore, AuditStoreError
from tests.approval_expiry_helper import soon
from master_brain.core import RiskTier, Task
from master_brain.mission_approval import (
    MAX_APPROVAL_LIFETIME_SECONDS,
    action_digest,
    evaluate_approved_execution_gate,
    mission_contract_digest,
    record_mission_approval,
)
from master_brain.mission_contract import (
    MissionContract,
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
            authentication_method=kwargs.get("authentication_method", "upstream-session"), expires_at=soon())

    def test_missing_approval_fails_closed(self):
        result = evaluate_approved_execution_gate(self.contract, self.store, None)
        self.assertFalse(result.allowed)
        self.assertIn("required human approval receipt is missing", result.reasons)

    def approve_bound(self, contract, digest, event_id="approval-bound"):
        return record_mission_approval(
            self.store, contract, event_id=event_id, recorded_at="2026-10-11T12:00:00Z",
            approver_subject="user:reviewer-7", authentication_method="upstream-session",
            action_digest=digest, expires_at=soon())

    def test_valid_approval_is_bound_to_exact_contract(self):
        digest = action_digest("integ", {"x": 1})
        receipt = self.approve_bound(self.contract, digest)  # HIGH risk: binding is mandatory
        result = evaluate_approved_execution_gate(self.contract, self.store, receipt, digest)
        self.assertTrue(result.allowed)
        self.assertEqual(result.reasons, ())
        self.assertEqual(receipt.contract_digest, mission_contract_digest(self.contract))

    def test_high_and_critical_risk_require_an_action_bound_approval(self):
        """Contract-only approvals covered any payload and could be reused; no longer allowed."""
        message = "high/critical-risk missions require an approval bound to the exact action"
        for tier in (RiskTier.HIGH, RiskTier.CRITICAL):
            with self.subTest(tier=tier):
                contract = from_core_task(Task(objective=f"Ship {tier.value}", risk=tier))
                unbound = self.approve(contract, event_id=f"unbound-{tier.value}")
                result = evaluate_approved_execution_gate(contract, self.store, unbound)
                self.assertFalse(result.allowed)
                self.assertIn(message, result.reasons)
                digest = action_digest("integ", {"tier": tier.value})
                bound = self.approve_bound(contract, digest, event_id=f"bound-{tier.value}")
                ok = evaluate_approved_execution_gate(contract, self.store, bound, digest)
                self.assertTrue(ok.allowed, ok.reasons)
                self.assertNotIn(message, ok.reasons)

    def test_bound_approval_still_rejects_a_different_action_or_missing_digest(self):
        digest = action_digest("integ", {"x": 1})
        receipt = self.approve_bound(self.contract, digest)
        wrong = evaluate_approved_execution_gate(
            self.contract, self.store, receipt, action_digest("integ", {"x": 2}))
        self.assertFalse(wrong.allowed)
        self.assertIn("action (integration or payload) differs from the approved action", wrong.reasons)
        missing = evaluate_approved_execution_gate(self.contract, self.store, receipt)
        self.assertFalse(missing.allowed)

    def test_medium_risk_human_gated_contract_may_still_use_a_contract_only_approval(self):
        from master_brain.mission_contract import MissionContract
        contract = MissionContract(mission_id="mission-medium", objective="Publish a summary",
                                   risk_tier=MissionRiskTier.MEDIUM, requires_approval=True)
        receipt = self.approve(contract, event_id="medium-contract-only")
        result = evaluate_approved_execution_gate(contract, self.store, receipt)
        self.assertTrue(result.allowed, result.reasons)

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


T0 = datetime(2026, 10, 12, 12, 0, 0, tzinfo=timezone.utc)


def iso(moment):
    return moment.isoformat().replace("+00:00", "Z")


class ApprovalExpiryTests(unittest.TestCase):
    """SAFE-001: an approval is only valid for a bounded time, judged by the store clock."""

    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tempdir.cleanup)
        self.now = T0
        self.store = AuditStore(
            Path(self.tempdir.name) / "audit.jsonl", clock=lambda: self.now,
        )
        self.contract = from_core_task(Task(objective="Deploy production", risk=RiskTier.HIGH))
        self.digest = action_digest("integ", {"x": 1})

    def approve(self, expires_at, contract=None, event_id="ap-1", digest="default"):
        contract = contract or self.contract
        return record_mission_approval(
            self.store, contract, event_id=event_id,
            recorded_at="2026-10-12T11:59:00Z", approver_subject="user:r",
            authentication_method="upstream-session",
            action_digest=self.digest if digest == "default" else digest,
            expires_at=expires_at,
        )

    def gate(self, receipt, contract=None):
        return evaluate_approved_execution_gate(
            contract or self.contract, self.store, receipt, self.digest,
        )

    def test_maximum_lifetime_policy_is_pinned_to_seven_days(self):
        """Pinned independently of the module so the constant cannot drift silently."""
        self.assertEqual(MAX_APPROVAL_LIFETIME_SECONDS, 604800)

    def test_store_now_returns_the_injected_clock(self):
        self.assertEqual(self.store.now(), T0)
        self.now = T0 + timedelta(seconds=5)
        self.assertEqual(self.store.now(), T0 + timedelta(seconds=5))

    def test_approval_is_valid_strictly_before_expiry_and_invalid_from_expiry_on(self):
        expiry = T0 + timedelta(minutes=10)
        receipt = self.approve(iso(expiry))
        self.assertEqual(receipt.expires_at, iso(expiry))
        for offset, allowed in ((0, True), (599, True), (600, False), (601, False), (86400, False)):
            with self.subTest(offset=offset):
                self.now = T0 + timedelta(seconds=offset)
                result = self.gate(receipt)
                self.assertEqual(result.allowed, allowed, result.reasons)
                if not allowed:
                    self.assertIn("approval has expired", result.reasons)

    def test_expiry_is_recorded_in_the_audit_event(self):
        receipt = self.approve(iso(T0 + timedelta(hours=1)))
        event = self.store.read_all()[0]
        self.assertEqual(event.payload["expires_at"], receipt.expires_at)

    def test_high_and_critical_approvals_require_an_expiry(self):
        for tier in (RiskTier.HIGH, RiskTier.CRITICAL):
            with self.subTest(tier=tier):
                contract = from_core_task(Task(objective=f"Ship {tier.value}", risk=tier))
                with self.assertRaisesRegex(ValueError, "require an expires_at"):
                    self.approve(None, contract=contract, event_id=f"no-exp-{tier.value}")
        self.assertEqual(self.store.read_all(), ())

    def test_gate_rejects_a_high_risk_receipt_without_expiry(self):
        receipt = self.approve(iso(T0 + timedelta(hours=1)))
        stripped = replace(receipt, expires_at=None)
        result = self.gate(stripped)
        self.assertFalse(result.allowed)
        self.assertIn("high/critical-risk missions require an approval with an expiry", result.reasons)

    def test_lower_risk_approval_without_expiry_is_still_accepted(self):
        contract = MissionContract(
            mission_id="m-med", objective="Run a controlled test",
            risk_tier=MissionRiskTier.MEDIUM, requires_approval=True,
        )
        receipt = record_mission_approval(
            self.store, contract, event_id="ap-med", recorded_at="2026-10-12T11:59:00Z",
            approver_subject="user:r", authentication_method="upstream-session",
        )
        self.assertIsNone(receipt.expires_at)
        self.now = T0 + timedelta(days=3650)
        self.assertTrue(self.gate(receipt, contract).allowed)

    def test_invalid_expiry_values_are_rejected_without_writing(self):
        bad_values = (
            "", "   ", "not-a-date", "2026-10-12T13:00:00",  # naive
            5, b"2026-10-12T13:00:00Z", ["x"],
            iso(T0),                                    # now: not in the future
            iso(T0 - timedelta(seconds=1)),             # past
            iso(T0 + timedelta(seconds=MAX_APPROVAL_LIFETIME_SECONDS + 1)),
        )
        for bad in bad_values:
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                self.approve(bad, event_id=f"bad-{id(bad)}")
        self.assertEqual(self.store.read_all(), ())

    def test_maximum_lifetime_boundary_is_inclusive_and_offsets_are_honoured(self):
        edge = T0 + timedelta(seconds=MAX_APPROVAL_LIFETIME_SECONDS)
        self.approve(iso(edge), event_id="edge")
        plus_two = timezone(timedelta(hours=2))
        local = (T0 + timedelta(hours=1)).astimezone(plus_two).isoformat()
        receipt = self.approve(local, event_id="offset")
        self.now = T0 + timedelta(minutes=59)
        self.assertTrue(self.gate(receipt).allowed)
        self.now = T0 + timedelta(hours=1)
        self.assertFalse(self.gate(receipt).allowed)

    def test_tampering_with_the_receipt_expiry_is_detected(self):
        receipt = self.approve(iso(T0 + timedelta(hours=1)))
        extended = replace(receipt, expires_at=iso(T0 + timedelta(hours=5)))
        result = self.gate(extended)
        self.assertFalse(result.allowed)
        self.assertIn("approval event payload does not match this contract and receipt", result.reasons)

    def test_malformed_or_non_string_receipt_expiry_fails_closed(self):
        receipt = self.approve(iso(T0 + timedelta(hours=1)))
        malformed = self.gate(replace(receipt, expires_at="tomorrow"))
        self.assertIn("approval expiry is malformed", malformed.reasons)
        naive = self.gate(replace(receipt, expires_at="2026-10-12T13:00:00"))
        self.assertIn("approval expiry is malformed", naive.reasons)
        non_string = self.gate(replace(receipt, expires_at=12345))
        self.assertFalse(non_string.allowed)
        self.assertIn("approval receipt field expires_at must be a string", non_string.reasons)

    def test_a_store_without_a_usable_clock_fails_closed_instead_of_crashing(self):
        receipt = self.approve(iso(T0 + timedelta(hours=1)))
        outer = self

        class NoClock:
            def read_all(inner):
                return outer.store.read_all()

        class BrokenClock(NoClock):
            def now(inner):
                raise RuntimeError("clock offline")

        class NaiveClock(NoClock):
            def now(inner):
                return datetime(2026, 10, 12, 12, 0, 0)  # naive: not comparable

        for store in (NoClock(), BrokenClock(), NaiveClock()):
            with self.subTest(store=type(store).__name__):
                result = evaluate_approved_execution_gate(
                    self.contract, store, receipt, self.digest,
                )
                self.assertFalse(result.allowed)
                self.assertIn(
                    "approval expiry cannot be evaluated (no usable clock)", result.reasons,
                )


if __name__ == "__main__":
    unittest.main()
