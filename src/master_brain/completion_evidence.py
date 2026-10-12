"""Attempt-bound completion evidence validation (no state mutation).

This module validates evidence bindings and delegates authenticity/semantic
verification to a trusted provider-specific verifier. It deliberately does not
transition executions to SUCCEEDED.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
import hashlib
import json
from typing import Callable

from master_brain.execution_registry import ExecutionAttempt, Record, State


class EvidenceValidationError(ValueError):
    """Evidence is malformed, mismatched, stale, or not independently verified."""


@dataclass(frozen=True)
class CompletionEvidence:
    attempt_id: str
    execution_key: str
    mission_id: str
    contract_digest: str
    payload_digest: str
    integration_id: str
    adapter_version: str
    provider_id: str
    evidence_type: str
    evidence_ref: str
    provider_receipt_id: str
    observed_at: str


@dataclass(frozen=True)
class VerifiedEvidence:
    evidence_digest: str
    attempt_id: str
    execution_key: str
    verifier_id: str
    evidence_type: str
    verifier_version: str = ""


ProviderEvidenceVerifier = Callable[[CompletionEvidence], bool]


def _valid_timestamp(value: str) -> bool:
    if not isinstance(value, str) or not value.strip():
        return False
    try:
        parsed = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
    except ValueError:
        return False
    return parsed.tzinfo is not None and parsed.utcoffset() is not None


def evidence_digest(evidence: CompletionEvidence) -> str:
    """Stable SHA-256 digest of the canonical evidence envelope."""
    payload = {
        "attempt_id": evidence.attempt_id,
        "execution_key": evidence.execution_key,
        "mission_id": evidence.mission_id,
        "contract_digest": evidence.contract_digest,
        "payload_digest": evidence.payload_digest,
        "integration_id": evidence.integration_id,
        "adapter_version": evidence.adapter_version,
        "provider_id": evidence.provider_id,
        "evidence_type": evidence.evidence_type,
        "evidence_ref": evidence.evidence_ref,
        "provider_receipt_id": evidence.provider_receipt_id,
        "observed_at": evidence.observed_at,
    }
    canonical = json.dumps(
        payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False
    ).encode("utf-8")
    return hashlib.sha256(canonical).hexdigest()


def validate_completion_evidence(
    *,
    execution: Record,
    attempt: ExecutionAttempt,
    evidence: CompletionEvidence,
    verifier_id: str,
    provider_verifier: ProviderEvidenceVerifier,
    verifier_version: str = "",
) -> VerifiedEvidence:
    """Validate exact bindings and invoke a trusted provider-specific verifier.

    A True return from provider_verifier is meaningful only when that callable
    is trusted, provider-specific, and verifies authenticity plus operation
    semantics (not merely the presence of a receipt-shaped object).
    """
    if not isinstance(execution, Record):
        raise EvidenceValidationError("execution must be a Record")
    if not isinstance(attempt, ExecutionAttempt):
        raise EvidenceValidationError("attempt must be an ExecutionAttempt")
    if not isinstance(evidence, CompletionEvidence):
        raise EvidenceValidationError("evidence must be a CompletionEvidence record")
    if not callable(provider_verifier):
        raise EvidenceValidationError("provider evidence verifier must be callable")
    if execution.state not in {State.OUTCOME_UNKNOWN, State.RECONCILIATION_REQUIRED}:
        raise EvidenceValidationError("execution is not awaiting evidence reconciliation")
    for name, value in (
        ("verifier_id", verifier_id),
        *((("verifier_version", verifier_version),) if verifier_version else ()),
        ("attempt_id", evidence.attempt_id),
        ("execution_key", evidence.execution_key),
        ("mission_id", evidence.mission_id),
        ("contract_digest", evidence.contract_digest),
        ("payload_digest", evidence.payload_digest),
        ("integration_id", evidence.integration_id),
        ("adapter_version", evidence.adapter_version),
        ("provider_id", evidence.provider_id),
        ("evidence_type", evidence.evidence_type),
        ("evidence_ref", evidence.evidence_ref),
        ("provider_receipt_id", evidence.provider_receipt_id),
        ("attempt_id", attempt.attempt_id),
        ("attempt_key", attempt.key),
        ("integration_id", attempt.integration_id),
    ):
        if not isinstance(value, str) or not value.strip():
            raise EvidenceValidationError(f"{name} must be non-empty")
    if not _valid_timestamp(evidence.observed_at):
        raise EvidenceValidationError("observed_at must be timezone-aware ISO-8601")
    if evidence.attempt_id != attempt.attempt_id:
        raise EvidenceValidationError("attempt ID mismatch")
    if evidence.execution_key != execution.key or evidence.execution_key != attempt.key:
        raise EvidenceValidationError("execution key mismatch")
    if evidence.mission_id != execution.mission_id:
        raise EvidenceValidationError("mission ID mismatch")
    if evidence.contract_digest != execution.contract_digest:
        raise EvidenceValidationError("contract digest mismatch")
    if evidence.payload_digest != execution.payload_digest:
        raise EvidenceValidationError("payload digest mismatch")
    if evidence.integration_id != attempt.integration_id:
        raise EvidenceValidationError("integration ID mismatch")
    if evidence.adapter_version != attempt.adapter_version:
        raise EvidenceValidationError("adapter version mismatch")
    if evidence.provider_id != attempt.provider_id:
        raise EvidenceValidationError("provider ID mismatch")
    if not attempt.dispatch_boundary_entered:
        raise EvidenceValidationError("dispatch boundary was not entered")
    try:
        trusted = provider_verifier(evidence)
    except Exception as exc:
        raise EvidenceValidationError("provider evidence verifier failed") from exc
    if trusted is not True:
        raise EvidenceValidationError("provider evidence was not verified")
    return VerifiedEvidence(
        evidence_digest=evidence_digest(evidence),
        attempt_id=attempt.attempt_id,
        execution_key=execution.key,
        verifier_id=verifier_id,
        evidence_type=evidence.evidence_type,
        verifier_version=verifier_version,
    )


def validate_registered_completion_evidence(
    *,
    execution: Record,
    attempt: ExecutionAttempt,
    evidence: CompletionEvidence,
    verifier_id: str,
    verifier_version: str,
    registry: object,
) -> VerifiedEvidence:
    """Validate evidence using an exact, deployment-configured verifier entry.

    The registry must be constructed from reviewed deployment configuration,
    never from mission/user input. This is a trusted configuration boundary,
    not a sandbox. This function validates only; it does not persist evidence
    or transition execution state.
    """
    # Local import avoids a module-import cycle: verifier_registry's descriptor
    # type references CompletionEvidence.
    from master_brain.verifier_registry import (
        ConfiguredVerifierRegistry,
        VerifierRegistryError,
    )

    if not isinstance(execution, Record):
        raise EvidenceValidationError("execution must be a Record")
    if not isinstance(attempt, ExecutionAttempt):
        raise EvidenceValidationError("attempt must be an ExecutionAttempt")
    if not isinstance(evidence, CompletionEvidence):
        raise EvidenceValidationError("evidence must be a CompletionEvidence record")
    if not isinstance(registry, ConfiguredVerifierRegistry):
        raise EvidenceValidationError("trusted verifier registry is required")
    try:
        verifier = registry.resolve(
            verifier_id=verifier_id,
            version=verifier_version,
            provider_id=evidence.provider_id,
            evidence_type=evidence.evidence_type,
        )
    except VerifierRegistryError as exc:
        raise EvidenceValidationError("no enabled trusted verifier matches evidence") from exc
    return validate_completion_evidence(
        execution=execution,
        attempt=attempt,
        evidence=evidence,
        verifier_id=verifier_id,
        provider_verifier=verifier,
        verifier_version=verifier_version,
    )


__all__ = [
    "CompletionEvidence", "EvidenceValidationError", "VerifiedEvidence",
    "evidence_digest", "validate_completion_evidence",
    "validate_registered_completion_evidence",
]
