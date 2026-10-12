"""Deterministic, provider-independent core for the Master Brain MVP.

No network calls or external side effects occur in this module.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Iterable, Sequence


class RiskTier(str, Enum):
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"
    CRITICAL = "critical"


class ClaimImportance(str, Enum):
    ROUTINE = "routine"
    HIGH = "high"
    CRITICAL = "critical"


class Maturity(str, Enum):
    PROPOSED = "proposed"
    SPECIFIED = "specified"
    IMPLEMENTED = "implemented"
    TESTED = "tested"
    INDEPENDENTLY_VALIDATED = "independently_validated"
    PRODUCTION_VERIFIED = "production_verified"


@dataclass(frozen=True)
class Task:
    objective: str
    constraints: tuple[str, ...] = ()
    risk: RiskTier = RiskTier.LOW
    requires_external_action: bool = False


@dataclass(frozen=True)
class Route:
    specialist: str
    needs_evidence: bool
    requires_approval: bool
    rationale: str


@dataclass(frozen=True)
class Evidence:
    evidence_id: str
    source: str
    claim_id: str
    supports: bool
    observed_at: str = ""
    independent_group: str = ""
    limitations: tuple[str, ...] = ()


@dataclass(frozen=True)
class Claim:
    claim_id: str
    subject: str
    predicate: str
    value: str
    context: str = ""
    time_scope: str = ""
    definition: str = ""
    importance: ClaimImportance = ClaimImportance.ROUTINE


@dataclass(frozen=True)
class Contradiction:
    claim_a: str
    claim_b: str
    status: str
    reason: str


@dataclass(frozen=True)
class Opportunity:
    title: str
    expected_value: float
    feasibility: float
    time_to_value: float
    downside_risk: float
    uncertainty: float
    evidence_quality: float = 0.0


@dataclass(frozen=True)
class Decision:
    status: str
    summary: str
    supporting_evidence: tuple[str, ...] = ()
    counterevidence: tuple[str, ...] = ()
    unresolved_questions: tuple[str, ...] = ()
    maturity: Maturity = Maturity.PROPOSED
    # These count caller-declared groups; they are not authenticated independence proof.
    independent_supporting_group_count: int = 0
    independent_support_demonstrated: bool = False


def route_task(task: Task) -> Route:
    """Conservative deterministic routing; specialist selection is a rule, not AI."""
    text = task.objective.lower()
    evidence_terms = ("research", "prove", "evidence", "compare", "verify", "contradiction", "scientific")
    opportunity_terms = ("opportunity", "business", "prioritize", "investment", "market", "strategy")
    if any(term in text for term in opportunity_terms):
        specialist, rationale = "opportunity_engine", "Objective signals option generation or prioritization."
    elif any(term in text for term in evidence_terms):
        specialist, rationale = "research_and_proof", "Objective requires evidence, comparison or verification."
    else:
        specialist, rationale = "general_planner", "Default route when no specialized rule matches."
    approval = task.requires_external_action or task.risk in (RiskTier.HIGH, RiskTier.CRITICAL)
    return Route(specialist, any(term in text for term in evidence_terms), approval, rationale)


def assess_contradictions(claims: Sequence[Claim]) -> list[Contradiction]:
    """Flag only opposite values with matching context keys; never infer truth."""
    results: list[Contradiction] = []
    for i, left in enumerate(claims):
        for right in claims[i + 1:]:
            same_scope = (
                left.subject == right.subject
                and left.predicate == right.predicate
                and left.context == right.context
                and left.time_scope == right.time_scope
                and left.definition == right.definition
            )
            if not same_scope or left.value == right.value:
                continue
            results.append(Contradiction(
                left.claim_id, right.claim_id, "potential_conflict",
                "Same subject, predicate, context, time scope and definition but different values; verify units, provenance and counterevidence before adjudication."
            ))
    return results


def score_opportunity(item: Opportunity) -> float:
    """Transparent illustrative score, not a calibrated business forecast.

    Inputs should be normalized to [0, 1] except expected_value, which is
    clamped to [0, 1] for this MVP. A later version must calibrate weights.
    """
    def unit(value: float) -> float:
        return max(0.0, min(1.0, value))
    return (
        0.30 * unit(item.expected_value)
        + 0.20 * unit(item.feasibility)
        + 0.10 * (1.0 - unit(item.time_to_value))
        + 0.15 * (1.0 - unit(item.downside_risk))
        + 0.10 * (1.0 - unit(item.uncertainty))
        + 0.15 * unit(item.evidence_quality)
    )


def evaluate_claim(claim: Claim, evidence: Iterable[Evidence]) -> Decision:
    """Return a conservative evidence summary; does not establish objective truth."""
    evidence_items = tuple(evidence)
    seen_ids: set[str] = set()
    duplicate_ids: set[str] = set()
    invalid_id_count = 0
    for item in evidence_items:
        evidence_id = item.evidence_id
        if not isinstance(evidence_id, str) or not evidence_id.strip():
            invalid_id_count += 1
        elif evidence_id in seen_ids:
            duplicate_ids.add(evidence_id)
        else:
            seen_ids.add(evidence_id)
    # Duplicate IDs are ambiguous globally, so exclude all occurrences instead
    # of allowing the first record to win based on input ordering.
    usable_evidence = [
        item for item in evidence_items
        if isinstance(item.evidence_id, str)
        and item.evidence_id.strip()
        and item.evidence_id not in duplicate_ids
    ]
    matching = [item for item in usable_evidence if item.claim_id == claim.claim_id]
    supporting = tuple(item.evidence_id for item in matching if item.supports)
    opposing = tuple(item.evidence_id for item in matching if not item.supports)
    supporting_groups = {
        item.independent_group
        for item in matching
        if item.supports and isinstance(item.independent_group, str) and item.independent_group.strip()
    }
    independent_supporting_group_count = len(supporting_groups)
    independent_support_demonstrated = independent_supporting_group_count >= 2
    unresolved: list[str] = []
    if duplicate_ids:
        unresolved.append("Duplicate evidence IDs were excluded from claim review: " + ", ".join(sorted(duplicate_ids)))
    if invalid_id_count:
        unresolved.append(f"{invalid_id_count} evidence record(s) with invalid IDs were excluded.")
    if not matching:
        unresolved.append("No usable evidence attached to claim.")
    if supporting and opposing:
        status = "contested"
        unresolved.append("Supporting and counterevidence both exist; inspect provenance and independence.")
    elif supporting:
        status = "supported_by_recorded_evidence"
        unresolved.append("Recorded support is not equivalent to verified truth; assess source quality and independent replication.")
    elif opposing:
        status = "challenged_by_recorded_evidence"
    else:
        status = "unverified"
    if not independent_support_demonstrated:
        unresolved.append(
            "Independent corroboration has not been demonstrated by at least two distinct supporting provenance groups."
        )
    return Decision(
        status=status,
        summary=f"Evidence review for claim {claim.claim_id}.",
        supporting_evidence=supporting,
        counterevidence=opposing,
        unresolved_questions=tuple(unresolved),
        maturity=Maturity.TESTED,
        independent_supporting_group_count=independent_supporting_group_count,
        independent_support_demonstrated=independent_support_demonstrated,
    )
