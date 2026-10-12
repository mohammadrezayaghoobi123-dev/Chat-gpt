"""Shared proof review and falsification planning for mission results."""
from dataclasses import dataclass

from .core import Claim, ClaimImportance, Contradiction, Decision, Evidence, assess_contradictions, evaluate_claim
from .ctp import CTPCase, plan_contradiction_case, plan_important_claim_case


@dataclass(frozen=True)
class ProofReport:
    contradictions: tuple[Contradiction, ...] = ()
    claim_reviews: tuple[Decision, ...] = ()
    unresolved_issues: tuple[str, ...] = ()
    ctp_cases: tuple[CTPCase, ...] = ()


def review_proof(claims, evidence):
    """Review evidence and create unexecuted CTP plans for detected conflicts."""
    issues = []
    # Materialize once: evidence may be a generator and is consumed by validation
    # as well as by each claim review below.
    evidence = tuple(evidence)
    unique = []
    by_id = {}
    ambiguous_claim_ids = set()
    for claim in claims:
        if not isinstance(claim, Claim):
            issues.append("Invalid claim record; expected a Claim instance.")
            continue
        claim_id = claim.claim_id
        if not isinstance(claim_id, str) or not claim_id.strip():
            issues.append("Claim has an invalid claim ID and was excluded.")
            continue
        previous = by_id.get(claim_id)
        if previous is None and claim_id not in ambiguous_claim_ids:
            by_id[claim_id] = claim
            unique.append(claim)
        elif previous != claim:
            issues.append("Duplicate claim ID with different content: " + claim_id)
            ambiguous_claim_ids.add(claim_id)
    if ambiguous_claim_ids:
        # Do not let evidence attach to an arbitrary first-seen interpretation.
        by_id = {claim_id: claim for claim_id, claim in by_id.items()
                 if claim_id not in ambiguous_claim_ids}
        unique = [claim for claim in unique if claim.claim_id not in ambiguous_claim_ids]
    known = set(by_id)
    evidence_ids = {}
    duplicate_evidence_ids = set()
    invalid_evidence_objects = set()
    for index, item in enumerate(evidence):
        evidence_id = getattr(item, "evidence_id", None)
        claim_id = getattr(item, "claim_id", None)
        valid_evidence_id = isinstance(evidence_id, str) and bool(evidence_id.strip())
        valid_claim_id = isinstance(claim_id, str) and bool(claim_id.strip())
        if not valid_evidence_id:
            issues.append("Evidence record has an invalid evidence ID; excluded.")
            invalid_evidence_objects.add(index)
        if not valid_claim_id or claim_id not in known:
            label = evidence_id if valid_evidence_id else "<invalid-id>"
            issues.append("Evidence is not linked to a known claim: " + label)
        if not valid_evidence_id:
            continue
        if evidence_id in evidence_ids:
            duplicate_evidence_ids.add(evidence_id)
        else:
            evidence_ids[evidence_id] = item
    for evidence_id in sorted(duplicate_evidence_ids):
        issues.append("Duplicate evidence ID: " + evidence_id)

    # An ambiguous ID must not contribute evidence or independence counts.
    # Exclude every occurrence, rather than keeping the first and making the
    # outcome depend on input ordering.
    usable_evidence = tuple(
        item for index, item in enumerate(evidence)
        if index not in invalid_evidence_objects
        and isinstance(getattr(item, "claim_id", None), str)
        and bool(item.claim_id.strip())
        and isinstance(getattr(item, "evidence_id", None), str)
        and bool(item.evidence_id.strip())
        and item.evidence_id not in duplicate_evidence_ids
    )
    conflicts = tuple(assess_contradictions(unique))
    reviews = tuple(evaluate_claim(claim, usable_evidence) for claim in unique)
    if conflicts:
        issues.append("Potential conflicts remain unresolved.")
    if any(item.status in {"contested", "unverified", "challenged_by_recorded_evidence"} for item in reviews):
        issues.append("Some claims need further review.")
    if any(item.status == "supported_by_recorded_evidence" for item in reviews):
        issues.append("Recorded support still requires source and independence checks.")

    ctp_cases = []
    covered_claim_ids = set()
    for conflict in conflicts:
        claim_a = by_id.get(conflict.claim_a)
        claim_b = by_id.get(conflict.claim_b)
        if claim_a is None or claim_b is None:
            issues.append("A detected conflict could not be linked to both original claims for CTP planning.")
            continue
        case = plan_contradiction_case(claim_a, claim_b, conflict)
        if case.validate():
            issues.append("A generated CTP case failed structural validation.")
        ctp_cases.append(case)
        covered_claim_ids.update(case.claim_ids)

    important_values = {ClaimImportance.HIGH.value, ClaimImportance.CRITICAL.value}
    valid_values = {item.value for item in ClaimImportance}
    for claim in unique:
        raw_importance = getattr(claim.importance, "value", claim.importance)
        if raw_importance not in valid_values:
            issues.append(f"Claim {claim.claim_id} has an unrecognized importance tier.")
            continue
        if raw_importance not in important_values or claim.claim_id in covered_claim_ids:
            continue
        if not isinstance(claim.claim_id, str) or not claim.claim_id.strip():
            issues.append("A high-importance claim without a valid ID could not receive a CTP plan.")
            continue
        case = plan_important_claim_case(claim)
        if case.validate():
            issues.append(f"CTP plan for high-importance claim {claim.claim_id} failed structural validation.")
        ctp_cases.append(case)

    return ProofReport(
        conflicts,
        reviews,
        tuple(dict.fromkeys(issues)),
        tuple(ctp_cases),
    )
