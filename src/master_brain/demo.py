"""Small offline demonstration of the Master Brain core.

Run with: PYTHONPATH=src python -m master_brain.demo
"""
from __future__ import annotations

from .core import (
    Claim,
    Evidence,
    Opportunity,
    RiskTier,
    Task,
    assess_contradictions,
    evaluate_claim,
    route_task,
    score_opportunity,
)


def main() -> None:
    task = Task(
        objective="Research and verify a supplier before prioritizing the opportunity",
        constraints=("No purchase without approval",),
        risk=RiskTier.HIGH,
        requires_external_action=False,
    )
    route = route_task(task)
    print("ROUTE")
    print(f"  specialist: {route.specialist}")
    print(f"  evidence required: {route.needs_evidence}")
    print(f"  approval required: {route.requires_approval}")

    claims = [
        Claim("capacity-a", "supplier-X", "daily_capacity", "1 ton/day", "factory-line-A", "2026", "finished product"),
        Claim("capacity-b", "supplier-X", "daily_capacity", "700 kg/day", "factory-line-A", "2026", "finished product"),
    ]
    print("\nPOTENTIAL CONTRADICTIONS")
    for conflict in assess_contradictions(claims):
        print(f"  {conflict.claim_a} vs {conflict.claim_b}: {conflict.status}")
        print(f"  {conflict.reason}")

    evidence = [
        Evidence("quote-01", "supplier quotation", "capacity-a", True, independent_group="supplier"),
        Evidence("inspection-01", "independent inspection", "capacity-a", False, independent_group="inspector"),
    ]
    review = evaluate_claim(claims[0], evidence)
    print("\nCLAIM REVIEW")
    print(f"  status: {review.status}")
    print(f"  supporting evidence: {', '.join(review.supporting_evidence) or 'none'}")
    print(f"  counterevidence: {', '.join(review.counterevidence) or 'none'}")
    for question in review.unresolved_questions:
        print(f"  unresolved: {question}")

    opportunity = Opportunity(
        title="Pilot supplier qualification",
        expected_value=0.75,
        feasibility=0.80,
        time_to_value=0.40,
        downside_risk=0.25,
        uncertainty=0.45,
        evidence_quality=0.55,
    )
    print("\nOPPORTUNITY SCORE (illustrative, not a forecast)")
    print(f"  {opportunity.title}: {score_opportunity(opportunity):.3f}")


if __name__ == "__main__":
    main()
