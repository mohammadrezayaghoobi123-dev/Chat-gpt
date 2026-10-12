"""Attempt-bound completion evidence validation (no state mutation).

This module validates evidence bindings and delegates authenticity/semantic
verification to a trusted provider-specific verifier. It deliberately does not
transition executions to SUCCEEDED.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
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
class ProviderVerificationResult:
    """Trusted verifier output binding a verified receipt to its canonical scope."""

    verified: bool
    provider_id: str
    provider_scope: str
    receipt_namespace: str
    canonical_receipt_id: str


@dataclass(frozen=True)
class VerifiedEvidence:
    evidence_digest: str
    attempt_id: str
    execution_key: str
    verifier_id: str
    evidence_type: str
    verifier_version: str = ""
    provider_id: str = ""
    provider_scope: str = ""
    receipt_namespace: str = ""
    provider_receipt_id: str = ""


ProviderEvidenceVerifier = Callable[[CompletionEvidence], object]

# Allow bounded clock skew, but never accept receipts dated implausibly in the future.
_MAX_FUTURE_OBSERVATION_SKEW = timedelta(minutes=5)


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
    # A receipt cannot predate the durable attempt/dispatch boundary it claims
    # to prove. Compare parsed aware datetimes, not ISO strings (offsets vary).
    try:
        observed_at = datetime.fromisoformat(
            evidence.observed_at.strip().replace("Z", "+00:00")
        )
        attempt_created_at = datetime.fromisoformat(
            attempt.created_at.strip().replace("Z", "+00:00")
        )
        dispatch_boundary_at = datetime.fromisoformat(
            attempt.updated_at.strip().replace("Z", "+00:00")
        )
    except (AttributeError, ValueError) as exc:
        raise EvidenceValidationError(
            "attempt timestamps must be timezone-aware ISO-8601"
        ) from exc
    if any(
        timestamp.tzinfo is None or timestamp.utcoffset() is None
        for timestamp in (attempt_created_at, dispatch_boundary_at)
    ):
        raise EvidenceValidationError(
            "attempt timestamps must be timezone-aware ISO-8601"
        )
    if dispatch_boundary_at < attempt_created_at:
        raise EvidenceValidationError("dispatch boundary predates attempt creation")
    if observed_at < dispatch_boundary_at:
        raise EvidenceValidationError("observed_at predates dispatch boundary")
    if observed_at > datetime.now(timezone.utc) + _MAX_FUTURE_OBSERVATION_SKEW:
        raise EvidenceValidationError("observed_at is too far in the future")
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
    if type(trusted) is bool:
        # Boolean results remain supported for validation-only callers. They do
        # not carry the identity needed to authorize a durable completion.
        if trusted is not True:
            raise EvidenceValidationError("provider evidence was not verified")
        identity = ("", "", "", "")
    elif isinstance(trusted, ProviderVerificationResult):
        if type(trusted.verified) is not bool or trusted.verified is not True:
            raise EvidenceValidationError("provider evidence was not verified")
        identity_values = (
            trusted.provider_id, trusted.provider_scope,
            trusted.receipt_namespace, trusted.canonical_receipt_id,
        )
        if any(not isinstance(value, str) or not value.strip() for value in identity_values):
            raise EvidenceValidationError("verified provider receipt identity is malformed")
        if trusted.provider_id != evidence.provider_id:
            raise EvidenceValidationError("verified provider identity disagrees with evidence")
        if trusted.canonical_receipt_id != evidence.provider_receipt_id:
            raise EvidenceValidationError("receipt ID must match verifier-confirmed canonical identity")
        attempt_scope = getattr(attempt, "provider_scope", None)
        attempt_namespace = getattr(attempt, "receipt_namespace", None)
        if trusted.provider_scope != attempt_scope or trusted.receipt_namespace != attempt_namespace:
            raise EvidenceValidationError("verified provider scope disagrees with trusted attempt configuration")
        identity = identity_values
    else:
        raise EvidenceValidationError("provider evidence verifier returned an invalid result")
    return VerifiedEvidence(
        evidence_digest=evidence_digest(evidence),
        attempt_id=attempt.attempt_id,
        execution_key=execution.key,
        verifier_id=verifier_id,
        evidence_type=evidence.evidence_type,
        verifier_version=verifier_version,
        provider_id=identity[0], provider_scope=identity[1],
        receipt_namespace=identity[2], provider_receipt_id=identity[3],
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
    "CompletionEvidence", "EvidenceValidationError", "ProviderVerificationResult", "VerifiedEvidence",
    "evidence_digest", "validate_completion_evidence",
    "validate_registered_completion_evidence",
]
