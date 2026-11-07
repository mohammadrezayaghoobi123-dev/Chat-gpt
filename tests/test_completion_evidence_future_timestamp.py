import unittest
from datetime import datetime, timedelta, timezone

from master_brain.completion_evidence import (
    CompletionEvidence,
    EvidenceValidationError,
    validate_completion_evidence,
)
from master_brain.execution_registry import ExecutionAttempt, Record, State


class FutureProviderTimestampTests(unittest.TestCase):
    def test_evidence_observed_far_in_future_is_rejected_before_verifier(self):
        now = datetime.now(timezone.utc)
        execution = Record(
            key="exec-future",
            mission_id="mission-future",
            contract_digest="contract-digest",
            payload_digest="payload-digest",
            state=State.OUTCOME_UNKNOWN,
            version=3,
            created_at=(now - timedelta(minutes=5)).isoformat(),
            updated_at=(now - timedelta(minutes=1)).isoformat(),
        )
        attempt = ExecutionAttempt(
            attempt_id="attempt-future",
            key=execution.key,
            attempt_number=1,
            integration_id="integration-a",
            adapter_version="v1",
            provider_id="provider-a",
            dispatch_boundary_entered=True,
            created_at=(now - timedelta(minutes=4)).isoformat(),
            updated_at=(now - timedelta(minutes=1)).isoformat(),
        )
        evidence = CompletionEvidence(
            attempt_id=attempt.attempt_id,
            execution_key=execution.key,
            mission_id=execution.mission_id,
            contract_digest=execution.contract_digest,
            payload_digest=execution.payload_digest,
            integration_id=attempt.integration_id,
            adapter_version=attempt.adapter_version,
            provider_id=attempt.provider_id,
            evidence_type="operation-receipt",
            evidence_ref="receipt://future",
            provider_receipt_id="receipt-future",
            observed_at="2099-01-01T00:00:00Z",
        )
        verifier_calls = []
        with self.assertRaisesRegex(EvidenceValidationError, "too far in the future"):
            validate_completion_evidence(
                execution=execution,
                attempt=attempt,
                evidence=evidence,
                verifier_id="verifier-a",
                verifier_version="1",
                provider_verifier=lambda item: verifier_calls.append(item) or True,
            )
        self.assertEqual(verifier_calls, [])


if __name__ == "__main__":
    unittest.main()
