import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from pathlib import Path

from master_brain.completion_evidence import CompletionEvidence, ProviderVerificationResult
from master_brain.execution_proof import review_operational_completion
from master_brain.execution_registry import SQLiteExecutionRegistry, State
from master_brain.verifier_registry import ConfiguredVerifierRegistry, VerifierDescriptor


def _verify_scoped_receipt(evidence):
    return ProviderVerificationResult(
        True, evidence.provider_id, "merchant-account-1/production",
        "operation-receipt", evidence.provider_receipt_id,
    )


class OperationalProofLaneTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.registry = SQLiteExecutionRegistry(str(Path(self.tmp.name) / "execution.sqlite3"))
        self.record, _ = self.registry.reserve(
            key="exec-1", mission_id="mission-1", contract_digest="contract-sha",
            payload_digest="payload-sha", recorded_at="2026-10-12T10:00:00Z",
        )
        self.record = self.registry.transition(
            key=self.record.key, expected_version=self.record.version,
            target=State.RUNNING, recorded_at="2026-10-12T10:00:01Z",
        )
        self.attempt = self.registry.reserve_attempt(
            key=self.record.key, expected_version=self.record.version,
            integration_id="payments", adapter_version="v1", provider_id="provider-x",
            provider_scope="merchant-account-1/production", receipt_namespace="operation-receipt",
            recorded_at="2026-10-12T10:00:02Z",
        )
        self.attempt = self.registry.mark_attempt_dispatch_boundary(
            attempt_id=self.attempt.attempt_id, recorded_at="2026-10-12T10:00:04Z",
        )
        self.record = self.registry.transition(
            key=self.record.key, expected_version=self.record.version,
            target=State.OUTCOME_UNKNOWN, recorded_at="2026-10-12T10:00:04Z",
        )
        self.evidence = CompletionEvidence(
            attempt_id=self.attempt.attempt_id, execution_key="exec-1",
            mission_id="mission-1", contract_digest="contract-sha",
            payload_digest="payload-sha", integration_id="payments",
            adapter_version="v1", provider_id="provider-x",
            evidence_type="operation-receipt", evidence_ref="receipt://abc",
            provider_receipt_id="receipt-abc", observed_at="2026-10-12T10:00:05Z",
        )

    def test_valid_evidence_is_reviewed_but_does_not_mutate_execution_state(self):
        registry = ConfiguredVerifierRegistry([VerifierDescriptor(
            verifier_id="receipt-check", version="1", provider_id="provider-x",
            evidence_type="operation-receipt", verify=_verify_scoped_receipt,
        )])
        before = self.registry.get("exec-1")
        report = review_operational_completion(
            execution=self.record, attempt=self.attempt, evidence=self.evidence,
            verifier_id="receipt-check", verifier_version="1",
            verifier_registry=registry,
        )
        self.assertEqual(report.status, "verified_for_reconciliation")
        self.assertIsNotNone(report.verified_evidence)
        self.assertIn("read-only", report.unresolved_issue)
        self.assertEqual(self.registry.get("exec-1"), before)
        self.assertEqual(self.registry.get("exec-1").state, State.OUTCOME_UNKNOWN)

    def test_unapproved_verifier_fails_closed(self):
        report = review_operational_completion(
            execution=self.record, attempt=self.attempt, evidence=self.evidence,
            verifier_id="unconfigured", verifier_version="1",
            verifier_registry=ConfiguredVerifierRegistry([]),
        )
        self.assertEqual(report.status, "unverified")
        self.assertIsNone(report.verified_evidence)
        self.assertIn("no enabled trusted verifier", report.unresolved_issue)
        self.assertEqual(self.registry.get("exec-1").state, State.OUTCOME_UNKNOWN)

    def test_verified_evidence_and_success_transition_commit_atomically(self):
        verifier_registry = ConfiguredVerifierRegistry([VerifierDescriptor(
            verifier_id="receipt-check", version="1", provider_id="provider-x",
            evidence_type="operation-receipt", verify=lambda _evidence: True,
        )])
        completed = self.registry.complete_with_verified_evidence(
            key="exec-1",
            expected_version=self.record.version,
            attempt_id=self.attempt.attempt_id,
            evidence=self.evidence,
            verifier_id="receipt-check",
            verifier_version="1",
            verifier_registry=verifier_registry,
            recorded_at="2026-10-12T10:00:06Z",
        )
        self.assertEqual(completed.state, State.SUCCEEDED)
        self.assertEqual(completed.version, self.record.version + 1)
        with __import__("sqlite3").connect(self.registry.path) as db:
            receipt = db.execute(
                "SELECT attempt_id, verifier_id, verifier_version FROM completion_receipts WHERE execution_key=?",
                ("exec-1",),
            ).fetchone()
        self.assertEqual(receipt, (self.attempt.attempt_id, "receipt-check", "1"))

    def test_exact_completion_retry_is_idempotent_but_different_evidence_is_rejected(self):
        verifier_registry = ConfiguredVerifierRegistry([VerifierDescriptor(
            verifier_id="receipt-check", version="1", provider_id="provider-x",
            evidence_type="operation-receipt", verify=lambda _evidence: True,
        )])
        kwargs = dict(
            key="exec-1", expected_version=self.record.version,
            attempt_id=self.attempt.attempt_id, evidence=self.evidence,
            verifier_id="receipt-check", verifier_version="1",
            verifier_registry=verifier_registry,
            recorded_at="2026-10-12T10:00:06Z",
        )
        first = self.registry.complete_with_verified_evidence(**kwargs)
        repeated = self.registry.complete_with_verified_evidence(**kwargs)
        self.assertEqual(first, repeated)
        altered = CompletionEvidence(**{
            **self.evidence.__dict__, "provider_receipt_id": "different-receipt"
        })
        with self.assertRaisesRegex(Exception, "different or missing completion evidence"):
            self.registry.complete_with_verified_evidence(**{**kwargs, "evidence": altered})


    def test_completion_rejects_attempt_without_dispatch_boundary(self):
        from master_brain.completion_evidence import EvidenceValidationError

        attempt = self.registry.get_attempt(self.attempt.attempt_id)
        self.assertTrue(attempt.dispatch_boundary_entered)
        # Create a separate uncertain execution whose attempt has not crossed
        # the dispatch boundary; completion must not accept any receipt for it.
        record, _ = self.registry.reserve(
            key="exec-no-dispatch", mission_id="mission-no-dispatch",
            contract_digest="contract-sha", payload_digest="payload-sha",
            recorded_at="2026-10-12T10:00:00Z",
        )
        record = self.registry.transition(
            key=record.key, expected_version=record.version, target=State.RUNNING,
            recorded_at="2026-10-12T10:00:01Z",
        )
        attempt = self.registry.reserve_attempt(
            key=record.key, expected_version=record.version,
            integration_id="payments", adapter_version="v1", provider_id="provider-x",
            recorded_at="2026-10-12T10:00:02Z",
        )
        record = self.registry.transition(
            key=record.key, expected_version=record.version,
            target=State.OUTCOME_UNKNOWN, recorded_at="2026-10-12T10:00:03Z",
        )
        evidence = CompletionEvidence(
            attempt_id=attempt.attempt_id, execution_key=record.key,
            mission_id=record.mission_id, contract_digest=record.contract_digest,
            payload_digest=record.payload_digest, integration_id=attempt.integration_id,
            adapter_version=attempt.adapter_version, provider_id=attempt.provider_id,
            evidence_type="operation-receipt", evidence_ref="receipt://no-dispatch",
            provider_receipt_id="receipt-no-dispatch", observed_at="2026-10-12T10:00:04Z",
        )
        verifier_registry = ConfiguredVerifierRegistry([VerifierDescriptor(
            verifier_id="receipt-check", version="1", provider_id="provider-x",
            evidence_type="operation-receipt", verify=lambda _evidence: True,
        )])
        with self.assertRaisesRegex(EvidenceValidationError, "dispatch boundary was not entered"):
            self.registry.complete_with_verified_evidence(
                key=record.key, expected_version=record.version,
                attempt_id=attempt.attempt_id, evidence=evidence,
                verifier_id="receipt-check", verifier_version="1",
                verifier_registry=verifier_registry, recorded_at="2026-10-12T10:00:05Z",
            )
        self.assertEqual(self.registry.get(record.key).state, State.OUTCOME_UNKNOWN)
        with __import__("sqlite3").connect(self.registry.path) as db:
            count = db.execute(
                "SELECT COUNT(*) FROM completion_receipts WHERE execution_key=?",
                (record.key,),
            ).fetchone()[0]
        self.assertEqual(count, 0)

    def test_recorded_at_before_current_execution_update_is_rejected(self):
        from master_brain.completion_evidence import EvidenceValidationError
        registry = ConfiguredVerifierRegistry([VerifierDescriptor(
            verifier_id="receipt-check", version="1", provider_id="provider-x",
            evidence_type="operation-receipt", verify=lambda _evidence: True,
        )])
        before = self.registry.get("exec-1")
        with self.assertRaisesRegex(EvidenceValidationError, "recorded_at predates evidence observation"):
            self.registry.complete_with_verified_evidence(
                key="exec-1", expected_version=before.version,
                attempt_id=self.attempt.attempt_id, evidence=self.evidence,
                verifier_id="receipt-check", verifier_version="1",
                verifier_registry=registry, recorded_at="2026-10-12T10:00:04Z",
            )
        self.assertEqual(self.registry.get("exec-1"), before)
        with __import__("sqlite3").connect(self.registry.path) as db:
            count = db.execute(
                "SELECT COUNT(*) FROM completion_receipts WHERE execution_key=?",
                ("exec-1",),
            ).fetchone()[0]
        self.assertEqual(count, 0)

    def test_concurrent_exact_completion_retries_commit_one_receipt(self):
        verification_barrier = Barrier(2)

        def verify(_evidence):
            verification_barrier.wait(timeout=5)
            return _verify_scoped_receipt(_evidence)

        verifier_registry = ConfiguredVerifierRegistry([VerifierDescriptor(
            verifier_id="receipt-check", version="1", provider_id="provider-x",
            evidence_type="operation-receipt", verify=verify,
        )])
        kwargs = dict(
            key="exec-1", expected_version=self.record.version,
            attempt_id=self.attempt.attempt_id, evidence=self.evidence,
            verifier_id="receipt-check", verifier_version="1",
            verifier_registry=verifier_registry,
            recorded_at="2026-10-12T10:00:06Z",
        )
        with ThreadPoolExecutor(max_workers=2) as pool:
            futures = [pool.submit(self.registry.complete_with_verified_evidence, **kwargs)
                       for _ in range(2)]
            results = [future.result(timeout=10) for future in futures]

        self.assertEqual(results[0], results[1])
        self.assertEqual(results[0].state, State.SUCCEEDED)
        with __import__("sqlite3").connect(self.registry.path) as db:
            count = db.execute(
                "SELECT COUNT(*) FROM completion_receipts WHERE execution_key=?",
                ("exec-1",),
            ).fetchone()[0]
        self.assertEqual(count, 1)

    def test_evidence_observed_before_dispatch_boundary_is_rejected(self):
        registry = ConfiguredVerifierRegistry([VerifierDescriptor(
            verifier_id="receipt-check", version="1", provider_id="provider-x",
            evidence_type="operation-receipt", verify=lambda _evidence: True,
        )])
        stale_evidence = CompletionEvidence(**{
            **self.evidence.__dict__, "observed_at": "2026-10-12T10:00:02Z"
        })
        report = review_operational_completion(
            execution=self.record, attempt=self.attempt, evidence=stale_evidence,
            verifier_id="receipt-check", verifier_version="1",
            verifier_registry=registry,
        )
        self.assertEqual(report.status, "unverified")
        self.assertIsNone(report.verified_evidence)
        self.assertIn("predates dispatch boundary", report.unresolved_issue)

    def test_false_verifier_result_is_not_accepted(self):
        registry = ConfiguredVerifierRegistry([VerifierDescriptor(
            verifier_id="receipt-check", version="1", provider_id="provider-x",
            evidence_type="operation-receipt", verify=lambda _evidence: False,
        )])
        report = review_operational_completion(
            execution=self.record, attempt=self.attempt, evidence=self.evidence,
            verifier_id="receipt-check", verifier_version="1",
            verifier_registry=registry,
        )
        self.assertEqual(report.status, "unverified")
        self.assertIsNone(report.verified_evidence)
        self.assertIn("not verified", report.unresolved_issue)


    def test_deployment_entry_point_fails_closed_without_provider_verifier_and_does_not_mutate(self):
        from unittest.mock import patch
        from master_brain.completion_evidence import EvidenceValidationError

        before = self.registry.get("exec-1")
        # The fixed deployment module is deliberately absent until a real
        # provider contract and authenticity verifier are implemented/reviewed.
        with patch.dict("sys.modules", {"master_brain.deployment_verifiers": None}):
            with self.assertRaisesRegex(
                EvidenceValidationError,
                "deployment verifier configuration is unavailable",
            ):
                self.registry.complete_with_deployment_verified_evidence(
                    key="exec-1",
                    expected_version=before.version,
                    attempt_id=self.attempt.attempt_id,
                    evidence=self.evidence,
                    verifier_id="receipt-check",
                    verifier_version="1",
                    recorded_at="2026-10-12T10:00:06Z",
                )

        self.assertEqual(self.registry.get("exec-1"), before)
        with __import__("sqlite3").connect(self.registry.path) as db:
            count = db.execute(
                "SELECT COUNT(*) FROM completion_receipts WHERE execution_key=?",
                ("exec-1",),
            ).fetchone()[0]
        self.assertEqual(count, 0)


if __name__ == "__main__":
    unittest.main()
