"""Persist falsification reviews and decision changes in the audit ledger.

The adapter is deliberately explicit: callers supply the event ID, timestamp,
actor, and any reason for changing a prior decision. It does not infer time or
silently claim that a review proves truth.
"""
from __future__ import annotations

from typing import Any

from master_brain.audit_store import AuditStore
from master_brain.falsification_engine import FalsificationReview


def falsification_review_payload(
    review: FalsificationReview,
    *,
    previous_decision: str | None = None,
    decision_change_reason: str | None = None,
) -> dict[str, Any]:
    """Convert a review into JSON-safe, traceable audit data."""
    current_decision = review.status.value
    changed = previous_decision is not None and previous_decision != current_decision
    if changed and not (decision_change_reason and decision_change_reason.strip()):
        raise ValueError(
            "decision_change_reason is required when the decision changes"
        )
    if decision_change_reason is not None and not decision_change_reason.strip():
        raise ValueError("decision_change_reason must not be blank")

    assessment = review.evidence_assessment
    return {
        "schema_version": 1,
        "claim_id": review.claim_id,
        "status": current_decision,
        "previous_decision": previous_decision,
        "decision_changed": changed,
        "decision_change_reason": decision_change_reason or "",
        "truth_established": False,
        "evidence_assessment": {
            "status": assessment.status.value,
            "supporting_evidence_ids": list(assessment.supporting_evidence_ids),
            "counterevidence_ids": list(assessment.counterevidence_ids),
            "support_weight": assessment.support_weight,
            "counter_weight": assessment.counter_weight,
            "independent_support_groups": list(assessment.independent_support_groups),
            "independent_counter_groups": list(assessment.independent_counter_groups),
            "reasons": list(assessment.reasons),
            "limitations": list(assessment.limitations),
        },
        "tests": {
            "planned_missing_ids": list(review.missing_test_ids),
            "unexpected_ids": list(review.unexpected_test_ids),
            "unexecuted_ids": list(review.unexecuted_test_ids),
            "executed": [
                {
                    "test_id": item.test_id,
                    "outcome": item.outcome,
                    "observed_result": item.observed_result,
                    "evidence_ids": list(item.evidence_ids),
                }
                for item in review.executed_observations
            ],
        },
        "rival_hypothesis_ids": list(review.rival_hypothesis_ids),
        "disconfirmation_criteria": list(review.disconfirmation_criteria),
        "counterexample_evidence_ids": list(review.counterexample_evidence_ids),
        "evidence_records": [
            {
                "evidence_id": item.evidence_id,
                "claim_id": item.claim_id,
                "source_uri_or_reference": item.source_uri_or_reference,
                "source_group": item.source_group,
                "source_kind": item.source_kind.value,
                "polarity": item.polarity.value,
                "relevance": item.relevance,
                "reliability": item.reliability,
                "observed_at": item.observed_at,
                "valid_until": item.valid_until,
                "method": item.method,
                "limitations": list(item.limitations),
                "is_directly_verified": item.is_directly_verified,
                "attached_to_executed_test": item.evidence_id in review.eligible_evidence_ids,
            }
            for item in review.evidence_records
        ],
        "reasons": list(review.reasons),
    }


def record_falsification_review(
    store: AuditStore,
    review: FalsificationReview,
    *,
    event_id: str,
    recorded_at: str,
    actor: str,
    previous_decision: str | None = None,
    decision_change_reason: str | None = None,
):
    """Append one falsification review to the verified audit chain."""
    payload = falsification_review_payload(
        review,
        previous_decision=previous_decision,
        decision_change_reason=decision_change_reason,
    )
    return store.append(
        event_id=event_id,
        event_type="falsification.reviewed",
        recorded_at=recorded_at,
        actor=actor,
        subject_ref=f"claim:{review.claim_id}",
        payload=payload,
    )
