"""Operational proof lane, deliberately separate from epistemic claim review.

A verified envelope is not an execution-state transition and is not itself a
trusted authority token. State mutation must re-check the evidence against
current durable state in a transactional API before it can mark success.
"""
from __future__ import annotations

from dataclasses import dataclass

from .completion_evidence import (
    CompletionEvidence,
    EvidenceValidationError,
    VerifiedEvidence,
    validate_registered_completion_evidence,
)
from .execution_registry import ExecutionAttempt, Record


@dataclass(frozen=True)
class OperationalProofReport:
    status: str
    verified_evidence: VerifiedEvidence | None = None
    unresolved_issue: str = ""


def review_operational_completion(
    *,
    execution: Record,
    attempt: ExecutionAttempt,
    evidence: CompletionEvidence,
    verifier_id: str,
    verifier_version: str,
    verifier_registry: object,
) -> OperationalProofReport:
    """Review completion evidence through the configured verifier allowlist.

    This function is read-only. It never transitions a registry record to
    SUCCEEDED and never treats a caller-constructed VerifiedEvidence instance
    as authority.
    """
    try:
        verified = validate_registered_completion_evidence(
            execution=execution,
            attempt=attempt,
            evidence=evidence,
            verifier_id=verifier_id,
            verifier_version=verifier_version,
            registry=verifier_registry,
        )
    except EvidenceValidationError as exc:
        return OperationalProofReport(
            status="unverified",
            unresolved_issue=str(exc),
        )
    return OperationalProofReport(
        status="verified_for_reconciliation",
        verified_evidence=verified,
        unresolved_issue=(
            "Evidence validated for review only; this function is read-only. "
            "To persist evidence and transition atomically, call "
            "complete_with_verified_evidence with the current execution version."
        ),
    )


__all__ = ["OperationalProofReport", "review_operational_completion"]
