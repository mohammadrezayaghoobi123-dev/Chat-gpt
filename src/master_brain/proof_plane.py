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
    unique = []
    by_id = {}
    for claim in claims:
        previous = by_id.get(claim.claim_id)
        if previous is None:
            by_id[claim.claim_id] = claim
            unique.append(claim)
        elif previous != claim:
            issues.append("Duplicate claim ID with different content: " + claim.claim_id)
    known = set(by_id)
    seen = set()
    for item in evidence:
        if item.claim_id not in known:
            issues.append("Evidence is not linked to a known claim: " + item.evidence_id)
        if item.evidence_id in seen:
            issues.append("Duplicate evidence ID: " + item.evidence_id)
        seen.add(item.evidence_id)
    conflicts = tuple(assess_contradictions(unique))
    reviews = tuple(evaluate_claim(claim, evidence) for claim in unique)
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
