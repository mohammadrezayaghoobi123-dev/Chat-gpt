"""Public-seam tests for idempotent verified completion retries."""
import unittest
from datetime import datetime, timedelta, timezone

from master_brain.completion_evidence import CompletionEvidence
from master_brain.execution_registry import SQLiteExecutionRegistry, State, InvalidTransition
from master_brain.verifier_registry import ConfiguredVerifierRegistry, VerifierDescriptor


def _iso(offset_seconds):
    return (datetime.now(timezone.utc) + timedelta(seconds=offset_seconds)).isoformat()


def _trusted_verifier(_evidence):
    return True


class VerifiedCompletionRetryTests(unittest.TestCase):
    def setUp(self):
        import tempfile
        from pathlib import Path

        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.registry = SQLiteExecutionRegistry(str(Path(self.tmp.name) / "registry.sqlite3"))
        self.verifier_calls = []

        def verify(evidence):
            self.verifier_calls.append(evidence.provider_receipt_id)
            return True

        self.trusted_verifiers = ConfiguredVerifierRegistry([
            VerifierDescriptor(
                verifier_id="payments-receipt",
                version="1",
                provider_id="provider-x",
                evidence_type="operation-receipt",
                verify=verify,
                enabled=True,
            )
        ])

        record, _ = self.registry.reserve(
            key="retry-execution",
            mission_id="mission-retry",
            contract_digest="contract-digest",
            payload_digest="payload-digest",
            recorded_at=_iso(-30),
        )
        record = self.registry.transition(
            key=record.key, expected_version=record.version,
            target=State.RUNNING, recorded_at=_iso(-25),
        )
        attempt = self.registry.reserve_attempt(
            key=record.key, expected_version=record.version,
            integration_id="payments-v1", adapter_version="1.0",
            provider_id="provider-x", recorded_at=_iso(-20),
        )
        attempt = self.registry.mark_attempt_dispatch_boundary(
            attempt_id=attempt.attempt_id, recorded_at=_iso(-15),
        )
        record = self.registry.get(record.key)
        record = self.registry.transition(
            key=record.key, expected_version=record.version,
            target=State.OUTCOME_UNKNOWN, recorded_at=_iso(-10),
        )
        self.key = record.key
        self.attempt = attempt
        self.record = record
        self.evidence = CompletionEvidence(
            attempt_id=attempt.attempt_id,
            execution_key=record.key,
            mission_id=record.mission_id,
            contract_digest=record.contract_digest,
            payload_digest=record.payload_digest,
            integration_id=attempt.integration_id,
            adapter_version=attempt.adapter_version,
            provider_id=attempt.provider_id,
            evidence_type="operation-receipt",
            evidence_ref="receipt://provider-x/receipt-1",
            provider_receipt_id="receipt-1",
            observed_at=_iso(-5),
        )

    def complete(self, evidence, recorded_at):
        return self.registry.complete_with_verified_evidence(
            key=self.key,
            expected_version=self.record.version,
            attempt_id=self.attempt.attempt_id,
            evidence=evidence,
            verifier_id="payments-receipt",
            verifier_version="1",
            verifier_registry=self.trusted_verifiers,
            recorded_at=recorded_at,
        )

    def test_exact_retry_is_idempotent_and_does_not_reverify(self):
        first = self.complete(self.evidence, _iso(-2))
        calls_after_first = len(self.verifier_calls)
        retry = self.complete(self.evidence, _iso(-1))

        self.assertEqual(first.state, State.SUCCEEDED)
        self.assertEqual(retry, first)
        self.assertEqual(len(self.verifier_calls), calls_after_first)
        self.assertEqual(calls_after_first, 1)

    def test_conflicting_evidence_after_success_is_rejected_without_state_change(self):
        succeeded = self.complete(self.evidence, _iso(-2))
        conflicting = CompletionEvidence(**{
            **self.evidence.__dict__,
            "provider_receipt_id": "different-receipt",
            "evidence_ref": "receipt://provider-x/different",
        })

        with self.assertRaisesRegex(InvalidTransition, "different or missing completion evidence"):
            self.complete(conflicting, _iso(-1))

        self.assertEqual(self.registry.get(self.key), succeeded)


if __name__ == "__main__":
    unittest.main()
