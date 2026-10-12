"""Public-seam tests for idempotent verified completion retries."""
import sqlite3
import unittest
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier, Lock
from datetime import datetime, timedelta, timezone

from master_brain.completion_evidence import CompletionEvidence, EvidenceValidationError
from master_brain.execution_registry import SQLiteExecutionRegistry, State, InvalidTransition
from master_brain.verifier_registry import ConfiguredVerifierRegistry, VerifierDescriptor


def _iso(offset_seconds):
    return (datetime.now(timezone.utc) + timedelta(seconds=offset_seconds)).isoformat()


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

    def test_rejected_provider_evidence_leaves_state_and_receipts_unchanged(self):
        rejecting_registry = ConfiguredVerifierRegistry([
            VerifierDescriptor(
                verifier_id="payments-receipt",
                version="1",
                provider_id="provider-x",
                evidence_type="operation-receipt",
                verify=lambda _evidence: False,
                enabled=True,
            )
        ])
        before = self.registry.get(self.key)

        with self.assertRaisesRegex(EvidenceValidationError, "not verified"):
            self.registry.complete_with_verified_evidence(
                key=self.key,
                expected_version=self.record.version,
                attempt_id=self.attempt.attempt_id,
                evidence=self.evidence,
                verifier_id="payments-receipt",
                verifier_version="1",
                verifier_registry=rejecting_registry,
                recorded_at=_iso(-2),
            )

        self.assertEqual(self.registry.get(self.key), before)
        with sqlite3.connect(self.registry.path) as db:
            count = db.execute(
                "SELECT COUNT(*) FROM completion_receipts WHERE execution_key=?",
                (self.key,),
            ).fetchone()[0]
        self.assertEqual(count, 0)

    def test_far_future_recorded_at_is_rejected_without_state_change(self):
        before = self.registry.get(self.key)
        with self.assertRaisesRegex(
            EvidenceValidationError, "recorded_at is too far in the future"
        ):
            self.complete(self.evidence, _iso(3600))

        self.assertEqual(self.registry.get(self.key), before)
        with sqlite3.connect(self.registry.path) as db:
            count = db.execute(
                "SELECT COUNT(*) FROM completion_receipts WHERE execution_key=?",
                (self.key,),
            ).fetchone()[0]
        self.assertEqual(count, 0)


    def test_future_observation_timestamp_is_rejected_without_state_change(self):
        before = self.registry.get(self.key)
        future_evidence = CompletionEvidence(**{
            **self.evidence.__dict__,
            "observed_at": _iso(3600),
        })
        with self.assertRaisesRegex(
            EvidenceValidationError, "observed_at is too far in the future"
        ):
            self.complete(future_evidence, _iso(3601))

        self.assertEqual(self.registry.get(self.key), before)
        with sqlite3.connect(self.registry.path) as db:
            count = db.execute(
                "SELECT COUNT(*) FROM completion_receipts WHERE execution_key=?",
                (self.key,),
            ).fetchone()[0]
        self.assertEqual(count, 0)

    def test_state_change_during_verification_rejects_stale_completion(self):
        def verifier_with_intervening_state_change(_evidence):
            self.registry.transition(
                key=self.key,
                expected_version=self.record.version,
                target=State.RECONCILIATION_REQUIRED,
                recorded_at=_iso(-3),
            )
            return True

        racing_registry = ConfiguredVerifierRegistry([
            VerifierDescriptor(
                verifier_id="payments-receipt",
                version="1",
                provider_id="provider-x",
                evidence_type="operation-receipt",
                verify=verifier_with_intervening_state_change,
                enabled=True,
            )
        ])

        with self.assertRaisesRegex(
            InvalidTransition, "execution changed during evidence verification"
        ):
            self.registry.complete_with_verified_evidence(
                key=self.key,
                expected_version=self.record.version,
                attempt_id=self.attempt.attempt_id,
                evidence=self.evidence,
                verifier_id="payments-receipt",
                verifier_version="1",
                verifier_registry=racing_registry,
                recorded_at=_iso(-1),
            )

        current = self.registry.get(self.key)
        self.assertEqual(current.state, State.RECONCILIATION_REQUIRED)
        self.assertEqual(current.version, self.record.version + 1)
        with sqlite3.connect(self.registry.path) as db:
            count = db.execute(
                "SELECT COUNT(*) FROM completion_receipts WHERE execution_key=?",
                (self.key,),
            ).fetchone()[0]
        self.assertEqual(count, 0)

    def test_concurrent_exact_completion_creates_one_receipt(self):
        barrier = Barrier(2)
        call_lock = Lock()
        calls = []

        def synchronized_verifier(evidence):
            with call_lock:
                calls.append(evidence.provider_receipt_id)
            barrier.wait(timeout=5)
            return True

        concurrent_registry = ConfiguredVerifierRegistry([
            VerifierDescriptor(
                verifier_id="payments-receipt",
                version="1",
                provider_id="provider-x",
                evidence_type="operation-receipt",
                verify=synchronized_verifier,
                enabled=True,
            )
        ])

        def complete(offset):
            return self.registry.complete_with_verified_evidence(
                key=self.key,
                expected_version=self.record.version,
                attempt_id=self.attempt.attempt_id,
                evidence=self.evidence,
                verifier_id="payments-receipt",
                verifier_version="1",
                verifier_registry=concurrent_registry,
                recorded_at=_iso(offset),
            )

        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(complete, (-2, -1)))

        self.assertEqual(results[0], results[1])
        self.assertEqual(results[0].state, State.SUCCEEDED)
        self.assertEqual(len(calls), 2)
        with sqlite3.connect(self.registry.path) as db:
            count = db.execute(
                "SELECT COUNT(*) FROM completion_receipts WHERE execution_key=?",
                (self.key,),
            ).fetchone()[0]
        self.assertEqual(count, 1)


if __name__ == "__main__":
    unittest.main()
