"""Canonical, versioned contract for planner interoperability.

Adapters preserve each legacy planner's output rather than replacing the
planner. The contract is a transport/compatibility boundary, not a claim that
routing is semantically correct or that selected islands have executed.
"""
from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
import hashlib
import json
from typing import Iterable

from master_brain.archipelago import MissionPlan as ArchipelagoMissionPlan
from master_brain.core import RiskTier, Task, route_task
from master_brain.meta_intelligence import (
    CoordinationPlan,
    ReviewLevel as MetaReviewLevel,
    plan_coordination,
)


MISSION_CONTRACT_SCHEMA_VERSION = "1.0"


class MissionRiskTier(str, Enum):
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"
    CRITICAL = "critical"


class MissionReviewLevel(str, Enum):
    LIGHT = "light"
    STANDARD = "standard"
    STRICT = "strict"
    HUMAN_GATED = "human_gated"


@dataclass(frozen=True)
class MissionContract:
    """Normalized mission request and planning traceability.

    mission_id is stable across planner adapters for the same normalized
    objective, constraints, success criteria, and risk tier. Callers should
    provide an explicit ID when two distinct mission instances share those
    same inputs.
    """

    mission_id: str
    objective: str
    schema_version: str = MISSION_CONTRACT_SCHEMA_VERSION
    constraints: tuple[str, ...] = ()
    success_criteria: tuple[str, ...] = ()
    risk_tier: MissionRiskTier = MissionRiskTier.MEDIUM
    selected_islands: tuple[str, ...] = ()
    review_level: MissionReviewLevel = MissionReviewLevel.STANDARD
    budget_units: int = 10
    deadline_seconds: int = 120
    requires_approval: bool = False
    capability_gaps: tuple[str, ...] = ()
    assumptions: tuple[str, ...] = ()
    unknowns: tuple[str, ...] = ()
    clarification_questions: tuple[str, ...] = ()
    dependencies: tuple[str, ...] = ()
    stop_conditions: tuple[str, ...] = ()
    rationale: tuple[str, ...] = ()
    traceability: tuple[str, ...] = ()

    def __post_init__(self) -> None:
        if not isinstance(self.mission_id, str) or not self.mission_id.strip():
            raise ValueError("mission_id must be a non-empty string")
        if not isinstance(self.objective, str):
            raise TypeError("objective must be a string")
        if not isinstance(self.schema_version, str):
            raise TypeError("schema_version must be a string")
        if self.schema_version != MISSION_CONTRACT_SCHEMA_VERSION:
            raise ValueError(
                f"unsupported mission contract schema version: {self.schema_version}"
            )
        if not isinstance(self.risk_tier, MissionRiskTier):
            raise TypeError("risk_tier must be a MissionRiskTier")
        if not isinstance(self.review_level, MissionReviewLevel):
            raise TypeError("review_level must be a MissionReviewLevel")
        if type(self.requires_approval) is not bool:
            raise TypeError("requires_approval must be a boolean")
        # A frozen dataclass is only shallowly immutable. Requiring tuples here
        # prevents callers from mutating contract contents after approval/digest.
        sequence_fields = (
            "constraints", "success_criteria", "selected_islands",
            "capability_gaps", "assumptions", "unknowns",
            "clarification_questions", "dependencies", "stop_conditions",
            "rationale", "traceability",
        )
        for field_name in sequence_fields:
            if not isinstance(getattr(self, field_name), tuple):
                raise TypeError(f"{field_name} must be a tuple")
        # bool is an int subclass in Python; reject it explicitly because
        # policy budgets and deadlines must be actual integer quantities.
        if type(self.budget_units) is not int:
            raise TypeError("budget_units must be an integer")
        if self.budget_units < 0:
            raise ValueError("budget_units must be >= 0")
        if type(self.deadline_seconds) is not int:
            raise TypeError("deadline_seconds must be an integer")
        if self.deadline_seconds < 1:
            raise ValueError("deadline_seconds must be >= 1")
        if any(not isinstance(item, str) for item in self.selected_islands):
            raise TypeError("selected island IDs must be strings")
        if len(self.selected_islands) != len(set(self.selected_islands)):
            raise ValueError("selected island IDs must be unique")
        if any(not item.strip() for item in self.selected_islands):
            raise ValueError("selected island IDs must not be empty")
        for field_name in (
            "constraints", "success_criteria", "capability_gaps", "assumptions",
            "unknowns", "clarification_questions", "dependencies", "stop_conditions",
            "rationale", "traceability",
        ):
            values = getattr(self, field_name)
            if any(not isinstance(value, str) or not value.strip() for value in values):
                raise ValueError(f"{field_name} entries must be non-empty strings")
        if self.risk_tier in {MissionRiskTier.HIGH, MissionRiskTier.CRITICAL} and not self.requires_approval:
            raise ValueError("high/critical risk missions require approval")
        if self.review_level is MissionReviewLevel.HUMAN_GATED and not self.requires_approval:
            raise ValueError("human_gated review requires approval")


def _normalize_risk(value: MissionRiskTier | RiskTier | str) -> MissionRiskTier:
    if isinstance(value, MissionRiskTier):
        return value
    raw = value.value if isinstance(value, Enum) else value
    try:
        return MissionRiskTier(str(raw).casefold())
    except ValueError as exc:
        raise ValueError(f"unsupported risk tier: {raw!r}") from exc


def _stable_mission_id(
    objective: str,
    constraints: Iterable[str],
    success_criteria: Iterable[str],
    risk_tier: MissionRiskTier,
) -> str:
    payload = {
        "objective": " ".join(objective.casefold().split()),
        "constraints": list(constraints),
        "success_criteria": list(success_criteria),
        "risk_tier": risk_tier.value,
        "schema_version": MISSION_CONTRACT_SCHEMA_VERSION,
    }
    canonical = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return "mission-" + hashlib.sha256(canonical.encode("utf-8")).hexdigest()[:16]


def _review_for(risk: MissionRiskTier, requires_approval: bool, gaps: tuple[str, ...],
                selection_count: int) -> MissionReviewLevel:
    if requires_approval:
        return MissionReviewLevel.HUMAN_GATED
    if risk is MissionRiskTier.HIGH or gaps:
        return MissionReviewLevel.STRICT
    if risk is MissionRiskTier.MEDIUM or selection_count > 1:
        return MissionReviewLevel.STANDARD
    return MissionReviewLevel.LIGHT


def _normalize_string_sequence(name: str, values: Iterable[str]) -> tuple[str, ...]:
    """Reject scalar strings and mappings before normalizing planner inputs."""
    if isinstance(values, (str, bytes, bytearray, dict)):
        raise TypeError(f"{name} must be an iterable of non-empty strings")
    try:
        normalized = tuple(values)
    except TypeError as exc:
        raise TypeError(f"{name} must be an iterable of non-empty strings") from exc
    if any(not isinstance(item, str) or not item.strip() for item in normalized):
        raise ValueError(f"{name} entries must be non-empty strings")
    return normalized


def _build_contract(
    *,
    objective: str,
    mission_id: str | None = None,
    constraints: Iterable[str] = (),
    success_criteria: Iterable[str] = (),
    risk_tier: MissionRiskTier | RiskTier | str = MissionRiskTier.MEDIUM,
    selected_islands: Iterable[str] = (),
    review_level: MissionReviewLevel | str | None = None,
    budget_units: int = 10,
    deadline_seconds: int = 120,
    requires_approval: bool = False,
    capability_gaps: Iterable[str] = (),
    assumptions: Iterable[str] = (),
    unknowns: Iterable[str] = (),
    clarification_questions: Iterable[str] = (),
    dependencies: Iterable[str] = (),
    stop_conditions: Iterable[str] = (),
    rationale: Iterable[str] = (),
    traceability: Iterable[str] = (),
) -> MissionContract:
    if not isinstance(objective, str):
        raise TypeError("objective must be a string")
    if type(requires_approval) is not bool:
        raise TypeError("requires_approval must be a boolean")
    constraint_tuple = _normalize_string_sequence("constraints", constraints)
    criteria_tuple = _normalize_string_sequence("success_criteria", success_criteria)
    risk = _normalize_risk(risk_tier)
    approval = bool(
        requires_approval
        or risk in {MissionRiskTier.HIGH, MissionRiskTier.CRITICAL}
    )
    selected = tuple(dict.fromkeys(_normalize_string_sequence("selected_islands", selected_islands)))
    gaps = _normalize_string_sequence("capability_gaps", capability_gaps)
    if review_level is None:
        review = _review_for(risk, approval, gaps, len(selected))
    elif isinstance(review_level, MissionReviewLevel):
        review = review_level
    else:
        review = MissionReviewLevel(str(review_level))
    identifier = mission_id or _stable_mission_id(
        objective, constraint_tuple, criteria_tuple, risk
    )
    return MissionContract(
        mission_id=identifier,
        objective=objective,
        schema_version=MISSION_CONTRACT_SCHEMA_VERSION,
        constraints=constraint_tuple,
        success_criteria=criteria_tuple,
        risk_tier=risk,
        selected_islands=selected,
        review_level=review,
        budget_units=budget_units,
        deadline_seconds=deadline_seconds,
        requires_approval=approval,
        capability_gaps=gaps,
        assumptions=_normalize_string_sequence("assumptions", assumptions),
        unknowns=_normalize_string_sequence("unknowns", unknowns),
        clarification_questions=_normalize_string_sequence("clarification_questions", clarification_questions),
        dependencies=tuple(dict.fromkeys(_normalize_string_sequence("dependencies", dependencies))),
        stop_conditions=_normalize_string_sequence("stop_conditions", stop_conditions),
        rationale=_normalize_string_sequence("rationale", rationale),
        traceability=_normalize_string_sequence("traceability", traceability),
    )


def from_core_task(
    task: Task,
    mission_id: str | None = None,
    *,
    budget_units: int = 10,
    deadline_seconds: int = 120,
    success_criteria: Iterable[str] = (),
) -> MissionContract:
    """Adapt the legacy core router without changing its routing behavior."""
    route = route_task(task)
    legacy_to_island = {
        "opportunity_engine": "economics",
        "research_and_proof": "science_research",
        "general_planner": "general",
    }
    selected = legacy_to_island.get(route.specialist, "general")
    questions = ("Clarify the objective before dispatch.",) if not task.objective.strip() else ()
    unknowns = ("The objective is empty.",) if not task.objective.strip() else ()
    return _build_contract(
        objective=task.objective,
        mission_id=mission_id,
        constraints=task.constraints,
        success_criteria=success_criteria,
        risk_tier=task.risk,
        selected_islands=(selected,),
        budget_units=budget_units,
        deadline_seconds=deadline_seconds,
        requires_approval=route.requires_approval,
        review_level=(
            MissionReviewLevel.HUMAN_GATED
            if route.requires_approval else None
        ),
        unknowns=unknowns,
        clarification_questions=questions,
        rationale=(
            route.rationale,
            f"Compatibility alias only: legacy route {route.specialist} maps to canonical island "
            f"{selected}; semantic equivalence has not been independently validated.",
        ),
        traceability=(
            "planner=core.route_task",
            f"legacy_route={route.specialist}",
            f"compatibility_mapping={route.specialist}->{selected}",
        ),
    )


def from_archipelago_plan(
    plan: ArchipelagoMissionPlan,
    mission_id: str | None = None,
    *,
    constraints: Iterable[str] = (),
    success_criteria: Iterable[str] = (),
    risk_tier: MissionRiskTier | RiskTier | str = MissionRiskTier.MEDIUM,
    budget_units: int = 10,
    deadline_seconds: int = 120,
    requires_approval: bool = False,
) -> MissionContract:
    """Adapt an archipelago plan, preserving assignments and shared foundations."""
    selected = tuple(item.island_id for item in plan.assignments)
    gaps = tuple(plan.capability_gaps)
    questions = ("Clarify the objective before dispatch.",) if not plan.objective.strip() else ()
    unknowns = ("The objective is empty.",) if not plan.objective.strip() else ()
    return _build_contract(
        objective=plan.objective,
        mission_id=mission_id,
        constraints=constraints,
        success_criteria=success_criteria,
        risk_tier=risk_tier,
        selected_islands=selected,
        budget_units=budget_units,
        deadline_seconds=deadline_seconds,
        requires_approval=requires_approval,
        capability_gaps=gaps,
        unknowns=unknowns,
        clarification_questions=questions,
        dependencies=plan.shared_foundations,
        rationale=plan.rationale,
        traceability=("planner=archipelago.plan_mission",),
    )


def from_coordination_plan(
    plan: CoordinationPlan,
    mission_id: str | None = None,
    *,
    constraints: Iterable[str] = (),
    success_criteria: Iterable[str] = (),
    risk_tier: MissionRiskTier | RiskTier | str = MissionRiskTier.MEDIUM,
    irreversible_action: bool = False,
) -> MissionContract:
    """Adapt the meta-intelligence plan without claiming selected islands ran."""
    risk = _normalize_risk(risk_tier)
    legacy_review = {
        MetaReviewLevel.LIGHT: MissionReviewLevel.LIGHT,
        MetaReviewLevel.STANDARD: MissionReviewLevel.STANDARD,
        MetaReviewLevel.STRICT: MissionReviewLevel.STRICT,
        MetaReviewLevel.HUMAN_GATED: MissionReviewLevel.HUMAN_GATED,
    }[plan.review_level]
    selected = tuple(item.island_id for item in plan.selections)
    approval = irreversible_action or risk in {
        MissionRiskTier.HIGH, MissionRiskTier.CRITICAL
    } or plan.review_level is MetaReviewLevel.HUMAN_GATED
    return _build_contract(
        objective=plan.original_objective,
        mission_id=mission_id,
        constraints=constraints,
        success_criteria=success_criteria,
        risk_tier=risk,
        selected_islands=selected,
        review_level=legacy_review,
        budget_units=plan.budget_units,
        deadline_seconds=plan.deadline_seconds,
        requires_approval=approval,
        capability_gaps=plan.capability_gaps,
        assumptions=plan.assumptions,
        unknowns=plan.unknowns,
        clarification_questions=plan.clarification_questions,
        stop_conditions=plan.stop_conditions,
        rationale=plan.rationale,
        traceability=(f"planner=meta_intelligence.plan_coordination",
                      f"legacy_planner_version={plan.planner_version}"),
    )



@dataclass(frozen=True)
class ExecutionGateResult:
    """Policy decision only; this function never dispatches or executes a mission."""

    allowed: bool
    reasons: tuple[str, ...]


def evaluate_execution_gate(
    contract: MissionContract,
    *,
    approval_granted: bool = False,
) -> ExecutionGateResult:
    """Legacy preflight only; a boolean must never authorize a gated mission.

    The parameter remains for source compatibility, but is intentionally not
    trusted. For any contract requiring approval, callers must use the audited
    gate in mission_approval with a receipt backed by verified audit history.
    This function never dispatches work.
    """
    reasons: list[str] = []
    if not contract.objective.strip():
        reasons.append("mission objective is empty and requires clarification")
    if contract.clarification_questions:
        reasons.append("mission requires clarification before dispatch")
    approval_required = (
        contract.requires_approval
        or contract.review_level is MissionReviewLevel.HUMAN_GATED
        or contract.risk_tier in {MissionRiskTier.HIGH, MissionRiskTier.CRITICAL}
    )
    if approval_required:
        reasons.append(
            "audited approval receipt is required; boolean approval assertions are not accepted"
        )
    return ExecutionGateResult(allowed=not reasons, reasons=tuple(reasons))


__all__ = [
    "MISSION_CONTRACT_SCHEMA_VERSION",
    "ExecutionGateResult",
    "evaluate_execution_gate",
    "MissionContract",
    "MissionReviewLevel",
    "MissionRiskTier",
    "from_archipelago_plan",
    "from_coordination_plan",
    "from_core_task",
]
