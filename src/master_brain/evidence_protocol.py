"""Evidence protocol for auditable claim review.

This module never declares objective truth. It preserves provenance, limits the
influence of correlated sources, and returns a review state plus explicit reasons.
No network access, model calls, or external side effects occur here.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from enum import Enum
from math import isfinite
from typing import Iterable


class EvidencePolarity(str, Enum):
    SUPPORTS = "supports"
    COUNTERS = "counters"


class SourceKind(str, Enum):
    PRIMARY = "primary"
    PEER_REVIEWED = "peer_reviewed"
    OFFICIAL = "official"
    SECONDARY = "secondary"
    MODEL_OUTPUT = "model_output"
    USER_ASSERTION = "user_assertion"
    UNKNOWN = "unknown"


class ReviewStatus(str, Enum):
    UNVERIFIED = "unverified"
    INSUFFICIENT_INDEPENDENCE = "insufficient_independence"
    CONTESTED = "contested"
    PROVISIONALLY_SUPPORTED = "provisionally_supported"
    PROVISIONALLY_REFUTED = "provisionally_refuted"
    INSUFFICIENT_EVIDENCE = "insufficient_evidence"


@dataclass(frozen=True)
class ClaimRecord:
    claim_id: str
    statement: str
    scope: str = ""
    time_scope: str = ""
    operational_definition: str = ""

    def __post_init__(self) -> None:
        if not self.claim_id.strip():
            raise ValueError("claim_id must not be empty")
        if not self.statement.strip():
            raise ValueError("statement must not be empty")


@dataclass(frozen=True)
class EvidenceRecord:
    evidence_id: str
    claim_id: str
    source_uri_or_reference: str
    source_group: str
    source_kind: SourceKind
    polarity: EvidencePolarity
    relevance: float = 1.0
    reliability: float = 0.5
    observed_at: str = ""
    valid_until: str = ""
    method: str = ""
    limitations: tuple[str, ...] = ()
    is_directly_verified: bool = False

    def __post_init__(self) -> None:
        for name in ("evidence_id", "claim_id", "source_uri_or_reference", "source_group"):
            if not getattr(self, name).strip():
                raise ValueError(f"{name} must not be empty")
        for name in ("relevance", "reliability"):
            value = getattr(self, name)
            if not isfinite(value) or not 0.0 <= value <= 1.0:
                raise ValueError(f"{name} must be finite and within [0, 1]")
        for name in ("observed_at", "valid_until"):
            value = getattr(self, name)
            if value:
                _parse_time(value, name)


@dataclass(frozen=True)
class ProtocolPolicy:
    minimum_effective_weight: float = 0.6
    minimum_independent_groups: int = 2
    stale_after_days: int | None = None
    current_time: str = ""

    def __post_init__(self) -> None:
        if not isfinite(self.minimum_effective_weight) or not 0.0 <= self.minimum_effective_weight <= 1.0:
            raise ValueError("minimum_effective_weight must be within [0, 1]")
        if self.minimum_independent_groups < 1:
            raise ValueError("minimum_independent_groups must be at least 1")
        if self.stale_after_days is not None and self.stale_after_days < 0:
            raise ValueError("stale_after_days must not be negative")
        if self.current_time:
            _parse_time(self.current_time, "current_time")


@dataclass(frozen=True)
class EvidenceContribution:
    evidence_id: str
    polarity: EvidencePolarity
    source_group: str
    effective_weight: float
    excluded_reason: str = ""


@dataclass(frozen=True)
class ClaimAssessment:
    claim_id: str
    status: ReviewStatus
    supporting_evidence_ids: tuple[str, ...]
    counterevidence_ids: tuple[str, ...]
    support_weight: float
    counter_weight: float
    independent_support_groups: tuple[str, ...]
    independent_counter_groups: tuple[str, ...]
    contributions: tuple[EvidenceContribution, ...]
    reasons: tuple[str, ...]
    limitations: tuple[str, ...]
    truth_established: bool = False


_SOURCE_BASE_WEIGHT = {
    SourceKind.PRIMARY: 1.0,
    SourceKind.PEER_REVIEWED: 0.9,
    SourceKind.OFFICIAL: 0.9,
    SourceKind.SECONDARY: 0.65,
    SourceKind.MODEL_OUTPUT: 0.25,
    SourceKind.USER_ASSERTION: 0.2,
    SourceKind.UNKNOWN: 0.1,
}


def _parse_time(value: str, field_name: str) -> datetime:
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise ValueError(f"{field_name} must be ISO-8601") from exc
    if parsed.tzinfo is None:
        raise ValueError(f"{field_name} must include a timezone")
    return parsed.astimezone(timezone.utc)


def _is_stale(item: EvidenceRecord, policy: ProtocolPolicy, now: datetime) -> bool:
    if item.valid_until and _parse_time(item.valid_until, "valid_until") < now:
        return True
    if policy.stale_after_days is not None and item.observed_at:
        age = now - _parse_time(item.observed_at, "observed_at")
        return age.total_seconds() > policy.stale_after_days * 86400
    return False


def assess_claim(
    claim: ClaimRecord,
    evidence: Iterable[EvidenceRecord],
    policy: ProtocolPolicy = ProtocolPolicy(),
) -> ClaimAssessment:
    """Review evidence conservatively; scores prioritize review, not truth.

    At most the strongest item from a source_group contributes to each polarity,
    so repeated model outputs or syndicated copies do not count as independent
    corroboration. A provisionally supported/refuted result still does not prove
    the claim; it means the current evidence crossed the configured review gate.
    """
    items = tuple(evidence)
    if any(item.claim_id != claim.claim_id for item in items):
        raise ValueError("all evidence records must reference the assessed claim")
    ids = [item.evidence_id for item in items]
    if len(ids) != len(set(ids)):
        raise ValueError("evidence_id values must be unique within an assessment")

    now = _parse_time(policy.current_time, "current_time") if policy.current_time else datetime.now(timezone.utc)
    contributions: list[EvidenceContribution] = []
    group_best: dict[tuple[EvidencePolarity, str], EvidenceRecord] = {}
    limitations: list[str] = []

    for item in items:
        limitations.extend(item.limitations)
        if _is_stale(item, policy, now):
            contributions.append(EvidenceContribution(
                item.evidence_id, item.polarity, item.source_group, 0.0,
                "stale_or_expired",
            ))
            continue
        base = _SOURCE_BASE_WEIGHT[item.source_kind]
        verified_factor = 1.0 if item.is_directly_verified else 0.8
        weight = base * item.reliability * item.relevance * verified_factor
        key = (item.polarity, item.source_group)
        previous = group_best.get(key)
        if previous is None:
            group_best[key] = item
        else:
            previous_weight = (
                _SOURCE_BASE_WEIGHT[previous.source_kind]
                * previous.reliability * previous.relevance
                * (1.0 if previous.is_directly_verified else 0.8)
            )
            if weight > previous_weight:
                group_best[key] = item

    effective_ids = {item.evidence_id for item in group_best.values()}
    for item in items:
        if any(c.evidence_id == item.evidence_id for c in contributions):
            continue
        if item.evidence_id not in effective_ids:
            contributions.append(EvidenceContribution(
                item.evidence_id, item.polarity, item.source_group, 0.0,
                "correlated_source_group_cap",
            ))
            continue
        weight = (
            _SOURCE_BASE_WEIGHT[item.source_kind]
            * item.reliability * item.relevance
            * (1.0 if item.is_directly_verified else 0.8)
        )
        contributions.append(EvidenceContribution(
            item.evidence_id, item.polarity, item.source_group, weight
        ))

    support_items = [item for item in group_best.values() if item.polarity is EvidencePolarity.SUPPORTS]
    counter_items = [item for item in group_best.values() if item.polarity is EvidencePolarity.COUNTERS]
    support_weight = min(1.0, sum(
        _SOURCE_BASE_WEIGHT[i.source_kind] * i.reliability * i.relevance
        * (1.0 if i.is_directly_verified else 0.8) for i in support_items
    ))
    counter_weight = min(1.0, sum(
        _SOURCE_BASE_WEIGHT[i.source_kind] * i.reliability * i.relevance
        * (1.0 if i.is_directly_verified else 0.8) for i in counter_items
    ))
    support_groups = tuple(sorted({i.source_group for i in support_items}))
    counter_groups = tuple(sorted({i.source_group for i in counter_items}))
    reasons: list[str] = [
        "This assessment is a review-gate result, not a declaration of objective truth.",
        "Evidence from the same source group is capped at one strongest contribution per polarity.",
    ]

    if not items:
        status = ReviewStatus.UNVERIFIED
        reasons.append("No evidence records were supplied.")
    elif not group_best:
        status = ReviewStatus.INSUFFICIENT_EVIDENCE
        reasons.append("No non-stale evidence contributed to the assessment.")
    elif support_items and counter_items:
        status = ReviewStatus.CONTESTED
        reasons.append("Both supporting evidence and counterevidence are present; resolve the conflict before relying on the claim.")
    elif support_items:
        if len(support_groups) < policy.minimum_independent_groups:
            status = ReviewStatus.INSUFFICIENT_INDEPENDENCE
            reasons.append("Supporting evidence does not meet the minimum independent-source-group requirement.")
        elif support_weight >= policy.minimum_effective_weight:
            status = ReviewStatus.PROVISIONALLY_SUPPORTED
            reasons.append("Supporting evidence crossed the configured review gate; independent validation may still be required.")
        else:
            status = ReviewStatus.INSUFFICIENT_EVIDENCE
            reasons.append("Supporting evidence did not cross the configured review gate.")
    elif counter_items:
        if len(counter_groups) < policy.minimum_independent_groups:
            status = ReviewStatus.INSUFFICIENT_INDEPENDENCE
            reasons.append("Counterevidence does not meet the minimum independent-source-group requirement.")
        elif counter_weight >= policy.minimum_effective_weight:
            status = ReviewStatus.PROVISIONALLY_REFUTED
            reasons.append("Counterevidence crossed the configured review gate; this is not proof of falsity.")
        else:
            status = ReviewStatus.INSUFFICIENT_EVIDENCE
            reasons.append("Counterevidence did not cross the configured review gate.")
    else:
        status = ReviewStatus.INSUFFICIENT_EVIDENCE
        reasons.append("Evidence records did not yield a usable contribution.")

    if any(c.excluded_reason == "stale_or_expired" for c in contributions):
        reasons.append("One or more evidence records were stale or expired and were excluded from scoring.")
    if any(c.excluded_reason == "correlated_source_group_cap" for c in contributions):
        reasons.append("One or more records were discounted because their source group already contributed.")
    if limitations:
        reasons.append("Known evidence limitations are retained and must be considered by the reviewer.")

    return ClaimAssessment(
        claim_id=claim.claim_id,
        status=status,
        supporting_evidence_ids=tuple(i.evidence_id for i in support_items),
        counterevidence_ids=tuple(i.evidence_id for i in counter_items),
        support_weight=round(support_weight, 6),
        counter_weight=round(counter_weight, 6),
        independent_support_groups=support_groups,
        independent_counter_groups=counter_groups,
        contributions=tuple(sorted(contributions, key=lambda c: c.evidence_id)),
        reasons=tuple(reasons),
        limitations=tuple(dict.fromkeys(limitations)),
        truth_established=False,
    )
