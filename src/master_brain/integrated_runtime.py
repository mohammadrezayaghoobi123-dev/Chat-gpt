"""Integrated, offline-testable mission execution across the Master Brain planning and proof core.

Executors are explicit injected boundaries. This module never implies that an
unconfigured island, model, provider, tool, or external action was used.
"""
from __future__ import annotations

from dataclasses import dataclass, replace
from datetime import datetime, timezone
from typing import Callable, Mapping
from uuid import uuid4

from .audit import AuditRecord
from .core import Claim, Contradiction, Decision, Evidence
from .ctp import CTPCase
from .meta_intelligence import Mission, CoordinationPlan, ReviewLevel, plan_coordination
from .proof_plane import review_proof
from .observability import observation


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
    audit_records: tuple[AuditRecord, ...] = ()
    ctp_cases: tuple[CTPCase, ...] = ()


def _safe_refs(values) -> tuple[str, ...]:
    """Keep only non-empty string identifiers; never place raw content in refs."""
    return tuple(value for value in values if isinstance(value, str) and value.strip())


def _build_audit_records(mission: Mission, run: MissionRun) -> tuple[AuditRecord, ...]:
    """Create in-memory mission/proof events without raw objectives or outputs."""
    now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    records: list[AuditRecord] = []
    # Preserve the proof plane's exact first-seen claim ordering, even when an
    # upstream executor supplies a malformed/blank ID. References are filtered
    # separately so a bad identifier cannot shift another claim's review status.
    claims_by_id: dict[str, Claim] = {}
    ambiguous_claim_ids: set[str] = set()
    evidence_by_claim: dict[str, list[Evidence]] = {}

    for result in run.results:
        for claim in result.claims:
            if not isinstance(claim, Claim):
                continue
            claim_id = claim.claim_id
            if not isinstance(claim_id, str) or not claim_id.strip():
                continue
            if any(
                not isinstance(getattr(claim, name), str)
                for name in ("subject", "predicate", "value", "context", "time_scope", "definition")
            ):
                continue
            previous = claims_by_id.get(claim_id)
            if previous is None and claim_id not in ambiguous_claim_ids:
                claims_by_id[claim_id] = claim
            elif previous != claim:
                # Match proof_plane policy: an ID reused for different claims
                # is ambiguous, so neither interpretation receives a review.
                ambiguous_claim_ids.add(claim_id)
        for evidence in result.evidence:
            if (
                isinstance(evidence, Evidence)
                and isinstance(evidence.claim_id, str)
                and evidence.claim_id.strip()
            ):
                evidence_by_claim.setdefault(evidence.claim_id, []).append(evidence)

    for claim_id in ambiguous_claim_ids:
        claims_by_id.pop(claim_id, None)
    reviewable_claims = tuple(claims_by_id.values())

    all_evidence = tuple(item for result in run.results for item in result.evidence)
    all_claim_ids = tuple(claim.claim_id for claim in reviewable_claims)
    executed_islands = tuple(result.island_id for result in run.results)
    allowed_risk_tiers = {"low", "medium", "high", "critical"}
    risk_tier = mission.risk_tier.casefold()
    if risk_tier not in allowed_risk_tiers:
        risk_tier = "unrecognized"

    records.append(AuditRecord(
        event_id=f"evt-{uuid4().hex}",
        event_type="mission_run",
        occurred_at=now,
        component="integrated_runtime",
        status=run.status,
        input_refs=_safe_refs(executed_islands),
        output_refs=_safe_refs(all_claim_ids),
        metadata={
            "risk_tier": risk_tier,
            "review_level": run.plan.review_level.value,
            "selected_island_count": len(run.plan.selections),
            "executed_island_count": len(run.results),
            "missing_island_count": len(run.missing_islands),
            "execution_error_count": len(run.execution_errors),
            "claim_count": len(all_claim_ids),
            "evidence_count": len(all_evidence),
            "contradiction_count": len(run.contradictions),
            "claim_review_count": len(run.claim_reviews),
            "ctp_case_count": len(run.ctp_cases),
            "unresolved_issue_count": len(run.unresolved_issues),
        },
    ))

    # The proof plane omits malformed and ambiguous claims. Pair decisions
    # only with that same validated sequence; never zip against raw inputs.
    for claim, decision in zip(reviewable_claims, run.claim_reviews):
        matching_evidence = evidence_by_claim.get(claim.claim_id, [])
        supporting_count = sum(1 for item in matching_evidence if item.supports)
        counterevidence_count = sum(1 for item in matching_evidence if not item.supports)
        records.append(AuditRecord(
            event_id=f"evt-{uuid4().hex}",
            event_type="claim_review",
            occurred_at=now,
            component="proof_plane",
            status=decision.status,
            input_refs=_safe_refs(item.evidence_id for item in matching_evidence),
            output_refs=_safe_refs((claim.claim_id,)),
            metadata={
                "supporting_evidence_count": supporting_count,
                "counterevidence_count": counterevidence_count,
                "maturity": decision.maturity.value,
            },
        ))

    for contradiction in run.contradictions:
        records.append(AuditRecord(
            event_id=f"evt-{uuid4().hex}",
            event_type="contradiction_detected",
            occurred_at=now,
            component="proof_plane",
            status=contradiction.status,
            input_refs=_safe_refs((contradiction.claim_a, contradiction.claim_b)),
            metadata={"review_required": True},
        ))

    for case in run.ctp_cases:
        records.append(AuditRecord(
            event_id=f"evt-{uuid4().hex}",
            event_type="ctp_case_planned",
            occurred_at=now,
            component="ctp",
            status="planned_not_run",
            input_refs=_safe_refs(case.claim_ids),
            output_refs=_safe_refs((case.case_id,)),
            metadata={
                "hypothesis_count": len(case.hypotheses),
                "falsifier_count": len(case.falsifiers),
                "test_count": len(case.tests),
                "unresolved_test_count": len(case.unresolved_test_ids),
                "executed_test_count": 0,
            },
        ))

    return tuple(records)


def _execute_mission_untraced(
    mission: Mission,
    executors: Mapping[str, IslandExecutor],
) -> MissionRun:
    """Plan, dispatch configured islands, and review returned claims together.

    This is a synchronous orchestration seam, not a provider integration.
    Human-gated missions fail closed because this prototype has no authenticated,
    digest-bound approval service. An approval must not be simulated by a bool.
    """
    plan = plan_coordination(mission)
    if mission.risk_tier.casefold() not in {"low", "medium", "high", "critical"}:
        return MissionRun(
            plan=plan,
            status="needs_clarification",
            unresolved_issues=("Mission not dispatched because its risk tier is unrecognized.",),
        )
    if mission.risk_tier.casefold() in {"high", "critical"} or mission.irreversible_action or plan.review_level is ReviewLevel.HUMAN_GATED:
        return MissionRun(
            plan=plan,
            status="approval_required",
            unresolved_issues=(
                "Mission was not dispatched because an approval mechanism is not configured.",
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
            with observation(
                name=f"master-brain-island-{island_id}",
                as_type="agent",
                input_data={"island_id": island_id, "risk_tier": mission.risk_tier},
                metadata={"component": "specialist-island"},
            ) as island_trace:
                result = executor(mission)
                if island_trace is not None and isinstance(result, IslandResult):
                    island_trace.update(output={
                        "status": "completed",
                        "claim_count": len(result.claims),
                        "evidence_count": len(result.evidence),
                        "provenance_count": len(result.provenance),
                        "limitation_count": len(result.limitations),
                    })
            if not isinstance(result, IslandResult):
                raise TypeError("executor must return IslandResult")
            if result.island_id != island_id:
                raise ValueError("result island_id does not match dispatched island")
            results.append(result)
        except Exception as exc:
            errors.append(f"{island_id}: execution failed ({type(exc).__name__})")

    claims = tuple(claim for result in results for claim in result.claims)
    evidence = tuple(item for result in results for item in result.evidence)
    proof_report = review_proof(claims, evidence)
    contradictions = proof_report.contradictions
    reviews = proof_report.claim_reviews
    provenance = tuple(dict.fromkeys(
        item for result in results for item in result.provenance
    ))
    unresolved: list[str] = list(proof_report.unresolved_issues)
    if missing:
        unresolved.append("One or more selected islands were not executed because no executor was configured.")
    if errors:
        unresolved.append("One or more selected islands failed; partial results must not be treated as complete.")
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
        ctp_cases=proof_report.ctp_cases,
    )


def execute_mission(
    mission: Mission,
    executors: Mapping[str, IslandExecutor],
) -> MissionRun:
    """Execute a mission with optional, privacy-conscious Langfuse tracing.

    Mission objective text, evidence content, and raw executor outputs are not
    sent to telemetry or included in audit metadata. Audit events are returned
    in memory only; this function does not persist them to durable storage.
    CTP cases are proposed plans; their tests are not run by this runtime.
    """
    with observation(
        name="master-brain-mission",
        as_type="agent",
        input_data={
            "risk_tier": mission.risk_tier,
            "irreversible_action": mission.irreversible_action,
            "budget_units": mission.budget_units,
            "deadline_seconds": mission.deadline_seconds,
            "configured_executor_ids": sorted(executors.keys()),
        },
        metadata={"component": "master-brain", "trace_schema_version": "1"},
    ) as mission_trace:
        run = _execute_mission_untraced(mission, executors)
        run = replace(run, audit_records=_build_audit_records(mission, run))
        if mission_trace is not None:
            mission_trace.update(
                output={
                    "status": run.status,
                    "executed_islands": [result.island_id for result in run.results],
                    "missing_island_count": len(run.missing_islands),
                    "execution_error_count": len(run.execution_errors),
                    "contradiction_count": len(run.contradictions),
                    "claim_review_count": len(run.claim_reviews),
                    "ctp_case_count": len(run.ctp_cases),
                    "unresolved_issue_count": len(run.unresolved_issues),
                    "audit_record_count": len(run.audit_records),
                },
                metadata={"review_level": run.plan.review_level.value},
            )
        return run
