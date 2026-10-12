"""Shared proof review and falsification planning for mission results."""
from dataclasses import dataclass

from .core import Claim, Contradiction, Decision, Evidence, assess_contradictions, evaluate_claim
from .ctp import CTPCase, plan_contradiction_case


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

    return ProofReport(
        conflicts,
        reviews,
        tuple(dict.fromkeys(issues)),
        tuple(ctp_cases),
    )
