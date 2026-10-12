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
            integration_id="payments-v1",
            adapter_version="1.2.0",
            provider_id="provider-x",
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

    def test_malformed_top_level_inputs_raise_validation_error(self):
        for kwargs in (
            {"execution": None},
            {"attempt": None},
            {"evidence": None},
        ):
            args = {
                "execution": self.execution,
                "attempt": self.attempt,
                "evidence": self.evidence,
                "verifier_id": "provider-x-receipt-verifier-v1",
                "provider_verifier": lambda item: True,
            }
            args.update(kwargs)
            with self.subTest(kwargs=kwargs), self.assertRaises(EvidenceValidationError):
                validate_completion_evidence(**args)

    def test_non_string_verifier_version_is_rejected(self):
        with self.assertRaisesRegex(EvidenceValidationError, "verifier_version must be non-empty"):
            validate_completion_evidence(
                execution=self.execution,
                attempt=self.attempt,
                evidence=self.evidence,
                verifier_id="provider-x-receipt-verifier-v1",
                provider_verifier=lambda item: True,
                verifier_version=0,
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

    def test_rejects_non_boolean_dispatch_boundary_flag(self):
        self.attempt = ExecutionAttempt(**{
            **self.attempt.__dict__, "dispatch_boundary_entered": 1
        })
        with self.assertRaisesRegex(EvidenceValidationError, "dispatch boundary flag must be boolean"):
            self.validate()

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


    def test_rejects_mission_mismatch(self):
        altered = CompletionEvidence(**{
            **self.evidence.__dict__, "mission_id": "different-mission"
        })
        with self.assertRaisesRegex(EvidenceValidationError, "mission ID mismatch"):
            self.validate(altered)

    def test_rejects_contract_digest_mismatch(self):
        altered = CompletionEvidence(**{
            **self.evidence.__dict__, "contract_digest": "different-contract"
        })
        with self.assertRaisesRegex(EvidenceValidationError, "contract digest mismatch"):
            self.validate(altered)

    def test_rejects_dispatch_boundary_timestamp_before_attempt_creation(self):
        self.attempt = ExecutionAttempt(**{
            **self.attempt.__dict__, "updated_at": "2026-10-12T00:00:00Z"
        })
        with self.assertRaisesRegex(EvidenceValidationError, "dispatch boundary predates attempt creation"):
            self.validate()

    def test_rejects_receipt_timestamp_before_dispatch_boundary(self):
        altered = CompletionEvidence(**{
            **self.evidence.__dict__, "observed_at": "2026-10-12T00:00:01Z"
        })
        with self.assertRaisesRegex(EvidenceValidationError, "predates dispatch boundary"):
            self.validate(altered)

    def test_rejects_timezone_naive_observed_at(self):
        altered = CompletionEvidence(**{
            **self.evidence.__dict__, "observed_at": "2026-10-12T00:00:03"
        })
        with self.assertRaisesRegex(EvidenceValidationError, "timezone-aware"):
            self.validate(altered)

    def test_rejects_integration_mismatch_before_verifier(self):
        altered = CompletionEvidence(**{
            **self.evidence.__dict__, "integration_id": "other-integration"
        })
        called = []
        with self.assertRaisesRegex(EvidenceValidationError, "integration ID mismatch"):
            self.validate(altered, verifier=lambda item: called.append(item) or True)
        self.assertEqual(called, [])

    def test_rejects_adapter_version_mismatch_before_verifier(self):
        altered = CompletionEvidence(**{
            **self.evidence.__dict__, "adapter_version": "9.9.9"
        })
        called = []
        with self.assertRaisesRegex(EvidenceValidationError, "adapter version mismatch"):
            self.validate(altered, verifier=lambda item: called.append(item) or True)
        self.assertEqual(called, [])

    def test_rejects_provider_mismatch_before_verifier(self):
        altered = CompletionEvidence(**{
            **self.evidence.__dict__, "provider_id": "other-provider"
        })
        called = []
        with self.assertRaisesRegex(EvidenceValidationError, "provider ID mismatch"):
            self.validate(altered, verifier=lambda item: called.append(item) or True)
        self.assertEqual(called, [])

    def test_rejects_truthy_non_boolean_verifier_result(self):
        # A truthy object is not an authenticated verification decision.
        with self.assertRaisesRegex(EvidenceValidationError, "not verified"):
            self.validate(verifier=lambda item: {"verified": True})




class RegisteredCompletionEvidenceTests(CompletionEvidenceTests):
    """Adversarial tests for the trusted-registry entry point."""

    def _registry(self, *, enabled=True, provider_id="provider-x", evidence_type="provider_operation_receipt", version="1"):
        from master_brain.verifier_registry import ConfiguredVerifierRegistry, VerifierDescriptor

        return ConfiguredVerifierRegistry([VerifierDescriptor(
            verifier_id="provider-x-receipt-verifier",
            version=version,
            provider_id=provider_id,
            evidence_type=evidence_type,
            verify=lambda item: True,
            enabled=enabled,
        )])

    def _validate_registered(self, registry, evidence=None, version="1"):
        from master_brain.completion_evidence import validate_registered_completion_evidence

        return validate_registered_completion_evidence(
            execution=self.execution,
            attempt=self.attempt,
            evidence=evidence or self.evidence,
            verifier_id="provider-x-receipt-verifier",
            verifier_version=version,
            registry=registry,
        )

    def test_registered_entry_point_resolves_and_verifies(self):
        verified = self._validate_registered(self._registry())
        self.assertEqual(verified.attempt_id, self.attempt.attempt_id)
        self.assertEqual(verified.verifier_id, "provider-x-receipt-verifier")
        self.assertEqual(verified.verifier_version, "1")

    def test_unknown_verifier_version_fails_closed(self):
        from master_brain.completion_evidence import EvidenceValidationError

        with self.assertRaisesRegex(EvidenceValidationError, "no enabled trusted verifier"):
            self._validate_registered(self._registry(), version="2")

    def test_disabled_verifier_fails_closed(self):
        from master_brain.completion_evidence import EvidenceValidationError

        with self.assertRaisesRegex(EvidenceValidationError, "no enabled trusted verifier"):
            self._validate_registered(self._registry(enabled=False))

    def test_binding_mismatch_is_rejected_before_registered_verifier_runs(self):
        from master_brain.completion_evidence import EvidenceValidationError
        from master_brain.verifier_registry import ConfiguredVerifierRegistry, VerifierDescriptor

        called = []
        registry = ConfiguredVerifierRegistry([VerifierDescriptor(
            verifier_id="provider-x-receipt-verifier",
            version="1",
            provider_id="provider-x",
            evidence_type="provider_operation_receipt",
            verify=lambda item: called.append(item) or True,
        )])
        altered = CompletionEvidence(**{
            **self.evidence.__dict__, "integration_id": "different-integration"
        })
        with self.assertRaisesRegex(EvidenceValidationError, "integration ID mismatch"):
            self._validate_registered(registry, evidence=altered)
        self.assertEqual(called, [])

    def test_registry_is_required_not_arbitrary_callable(self):
        from master_brain.completion_evidence import EvidenceValidationError

        with self.assertRaisesRegex(EvidenceValidationError, "trusted verifier registry is required"):
            self._validate_registered(object())



    def test_provider_mismatch_cannot_select_another_provider_verifier(self):
        from master_brain.completion_evidence import EvidenceValidationError

        altered = CompletionEvidence(**{
            **self.evidence.__dict__, "provider_id": "provider-y"
        })
        with self.assertRaisesRegex(EvidenceValidationError, "no enabled trusted verifier"):
            self._validate_registered(self._registry(), evidence=altered)

    def test_evidence_type_mismatch_cannot_select_another_verifier(self):
        from master_brain.completion_evidence import EvidenceValidationError

        altered = CompletionEvidence(**{
            **self.evidence.__dict__, "evidence_type": "generic_success_message"
        })
        with self.assertRaisesRegex(EvidenceValidationError, "no enabled trusted verifier"):
            self._validate_registered(self._registry(), evidence=altered)

    def test_verified_record_binds_exact_verifier_version(self):
        verified = self._validate_registered(self._registry(version="2026.10.1"), version="2026.10.1")
        self.assertEqual(verified.verifier_version, "2026.10.1")

if __name__ == "__main__":
    unittest.main()
