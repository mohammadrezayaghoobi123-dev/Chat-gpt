"""Shared proof review for mission results."""
from dataclasses import dataclass
from .core import Claim, Contradiction, Decision, Evidence, assess_contradictions, evaluate_claim

@dataclass(frozen=True)
class ProofReport:
    contradictions: tuple[Contradiction, ...] = ()
    claim_reviews: tuple[Decision, ...] = ()
    unresolved_issues: tuple[str, ...] = ()

def review_proof(claims, evidence):
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
    return ProofReport(conflicts, reviews, tuple(dict.fromkeys(issues)))
