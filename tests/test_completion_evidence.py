"""Fail-closed tests for attempt-bound completion evidence validation."""
import unittest

from master_brain.completion_evidence import (
    CompletionEvidence,
    EvidenceValidationError,
    validate_completion_evidence,
)
from master_brain.execution_registry import ExecutionAttempt, Record, State


class CompletionEvidenceTests(unittest.TestCase):
    def setUp(self):
        self.execution = Record(
            key="exec-key",
            mission_id="mission-1",
            contract_digest="contract-sha256",
            payload_digest="payload-sha256",
            state=State.OUTCOME_UNKNOWN,
            version=3,
            created_at="2026-10-12T00:00:00Z",
            updated_at="2026-10-12T00:00:02Z",
        )
        self.attempt = ExecutionAttempt(
            attempt_id="attempt-123",
            key="exec-key",
            attempt_number=1,
            integration_id="payments-v1",
            adapter_version="1.2.0",
            provider_id="provider-x",
            dispatch_boundary_entered=True,
            created_at="2026-10-12T00:00:01Z",
            updated_at="2026-10-12T00:00:02Z",
        )
        self.evidence = CompletionEvidence(
            attempt_id="attempt-123",
            execution_key="exec-key",
            mission_id="mission-1",
            contract_digest="contract-sha256",
            payload_digest="payload-sha256",
            evidence_type="provider_operation_receipt",
            evidence_ref="receipt://provider-x/abc",
            provider_receipt_id="receipt-abc",
            observed_at="2026-10-12T00:00:03Z",
        )

    def validate(self, evidence=None, verifier=lambda item: True):
        return validate_completion_evidence(
            execution=self.execution,
            attempt=self.attempt,
            evidence=evidence or self.evidence,
            verifier_id="provider-x-receipt-verifier-v1",
            provider_verifier=verifier,
        )

    def test_valid_attempt_bound_evidence_returns_verification_record(self):
        verified = self.validate()
        self.assertEqual(verified.attempt_id, self.attempt.attempt_id)
        self.assertEqual(verified.execution_key, self.execution.key)
        self.assertEqual(len(verified.evidence_digest), 64)

    def test_rejects_attempt_mismatch(self):
        altered = CompletionEvidence(**{
            **self.evidence.__dict__, "attempt_id": "different-attempt"
        })
        with self.assertRaisesRegex(EvidenceValidationError, "attempt ID mismatch"):
            self.validate(altered)

    def test_rejects_payload_mismatch(self):
        altered = CompletionEvidence(**{
            **self.evidence.__dict__, "payload_digest": "different-payload"
        })
        with self.assertRaisesRegex(EvidenceValidationError, "payload digest mismatch"):
            self.validate(altered)

    def test_rejects_unverified_receipt(self):
        with self.assertRaisesRegex(EvidenceValidationError, "not verified"):
            self.validate(verifier=lambda item: False)

    def test_verifier_exception_fails_closed(self):
        def broken_verifier(item):
            raise RuntimeError("network down")
        with self.assertRaisesRegex(EvidenceValidationError, "verifier failed"):
            self.validate(verifier=broken_verifier)

    def test_rejects_evidence_when_dispatch_boundary_not_entered(self):
        self.attempt = ExecutionAttempt(**{
            **self.attempt.__dict__, "dispatch_boundary_entered": False
        })
        with self.assertRaisesRegex(EvidenceValidationError, "boundary was not entered"):
            self.validate()

    def test_rejects_evidence_for_terminal_success_state(self):
        self.execution = Record(**{
            **self.execution.__dict__, "state": State.SUCCEEDED
        })
        with self.assertRaisesRegex(EvidenceValidationError, "not awaiting evidence"):
            self.validate()


if __name__ == "__main__":
    unittest.main()
