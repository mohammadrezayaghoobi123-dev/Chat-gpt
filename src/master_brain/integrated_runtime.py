"""Integrated, offline-testable mission execution across the Master Brain planning and proof core.

Executors are explicit injected boundaries. This module never implies that an
unconfigured island, model, provider, tool, or external action was used.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Callable, Mapping

from .core import Claim, Contradiction, Decision, Evidence, assess_contradictions, evaluate_claim
from .meta_intelligence import Mission, CoordinationPlan, ReviewLevel, plan_coordination


@dataclass(frozen=True)
class IslandResult:
    """Typed result returned by an island executor that actually ran."""
    island_id: str
    summary: str
    claims: tuple[Claim, ...] = ()
    evidence: tuple[Evidence, ...] = ()
    provenance: tuple[str, ...] = ()
    limitations: tuple[str, ...] = ()


IslandExecutor = Callable[[Mission], IslandResult]


@dataclass(frozen=True)
class MissionRun:
    plan: CoordinationPlan
    status: str
    results: tuple[IslandResult, ...] = ()
    missing_islands: tuple[str, ...] = ()
    execution_errors: tuple[str, ...] = ()
    contradictions: tuple[Contradiction, ...] = ()
    claim_reviews: tuple[Decision, ...] = ()
    provenance: tuple[str, ...] = ()
    unresolved_issues: tuple[str, ...] = ()


def execute_mission(
    mission: Mission,
    executors: Mapping[str, IslandExecutor],
) -> MissionRun:
    """Plan, dispatch configured islands, and review returned claims together.

    This is a synchronous orchestration seam, not a provider integration.
    Human-gated missions fail closed because this prototype has no authenticated,
    digest-bound approval service. An approval must not be simulated by a bool.
    """
    plan = plan_coordination(mission)
    if plan.review_level is ReviewLevel.HUMAN_GATED:
        return MissionRun(
            plan=plan,
            status="approval_required",
            unresolved_issues=(
                "Human-gated mission was not dispatched: authenticated approval bound to the exact mission contract is not configured.",
            ),
        )

    selected = tuple(selection.island_id for selection in plan.selections)
    results: list[IslandResult] = []
    missing: list[str] = []
    errors: list[str] = []

    for island_id in selected:
        executor = executors.get(island_id)
        if executor is None:
            missing.append(f"{island_id}: not executed (no executor configured)")
            continue
        try:
            result = executor(mission)
            if not isinstance(result, IslandResult):
                raise TypeError("executor must return IslandResult")
            if result.island_id != island_id:
                raise ValueError("result island_id does not match dispatched island")
            results.append(result)
        except Exception as exc:
            errors.append(f"{island_id}: execution failed ({type(exc).__name__})")

    claims = tuple(claim for result in results for claim in result.claims)
    evidence = tuple(item for result in results for item in result.evidence)
    contradictions = tuple(assess_contradictions(claims))
    reviews = tuple(
        evaluate_claim(claim, evidence)
        for index, claim in enumerate(claims)
        if claim.claim_id not in {prior.claim_id for prior in claims[:index]}
    )
    provenance = tuple(dict.fromkeys(
        item for result in results for item in result.provenance
    ))
    unresolved: list[str] = []
    if contradictions:
        unresolved.append("Potential cross-island contradictions remain unresolved; compare scope, units, provenance and counterevidence.")
    if missing:
        unresolved.append("One or more selected islands were not executed because no executor was configured.")
    if errors:
        unresolved.append("One or more selected islands failed; partial results must not be treated as complete.")
    if any(review.status in {"contested", "unverified", "challenged_by_recorded_evidence"} for review in reviews):
        unresolved.append("At least one returned claim is contested, challenged, or unverified by the recorded evidence.")

    if contradictions:
        status = "needs_review"
    elif missing or errors:
        status = "incomplete"
    elif unresolved:
        status = "needs_review"
    else:
        status = "completed_with_recorded_results"

    return MissionRun(
        plan=plan,
        status=status,
        results=tuple(results),
        missing_islands=tuple(missing),
        execution_errors=tuple(errors),
        contradictions=contradictions,
        claim_reviews=reviews,
        provenance=provenance,
        unresolved_issues=tuple(unresolved),
    )
