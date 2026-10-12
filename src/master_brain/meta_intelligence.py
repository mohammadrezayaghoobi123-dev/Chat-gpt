"""Auditable coordination-planning scaffold; deterministic baseline, not semantic AI."""
from __future__ import annotations
from dataclasses import dataclass
from enum import Enum
import re
from typing import Iterable

class ReviewLevel(str, Enum):
    LIGHT = "light"
    STANDARD = "standard"
    STRICT = "strict"
    HUMAN_GATED = "human_gated"

@dataclass(frozen=True)
class Mission:
    objective: str
    constraints: tuple[str, ...] = ()
    success_criteria: tuple[str, ...] = ()
    risk_tier: str = "medium"
    irreversible_action: bool = False
    budget_units: int = 10
    deadline_seconds: int = 120

@dataclass(frozen=True)
class IslandProfile:
    island_id: str
    keywords: tuple[str, ...]
    enabled: bool = True

@dataclass(frozen=True)
class Selection:
    island_id: str
    matched_terms: tuple[str, ...]
    reason: str

@dataclass(frozen=True)
class CoordinationPlan:
    planner_version: str
    original_objective: str
    selections: tuple[Selection, ...]
    assumptions: tuple[str, ...]
    unknowns: tuple[str, ...]
    clarification_questions: tuple[str, ...]
    verification_steps: tuple[str, ...]
    capability_gaps: tuple[str, ...]
    review_level: ReviewLevel
    budget_units: int
    deadline_seconds: int
    stop_conditions: tuple[str, ...]
    rationale: tuple[str, ...]

DEFAULT_PROFILES = (
    IslandProfile("general", ("plan", "strategy", "decision", "compare", "evaluate", "help", "برنامه", "تصمیم")),
    IslandProfile("industrial", ("factory", "industrial", "machine", "manufacturing", "production", "material", "formulation", "capacity", "supplier", "خط تولید", "ماشین آلات", "تولید", "کارخانه", "مواد اولیه")),
    IslandProfile("economics", ("economics", "economic", "market", "demand", "price", "investment", "profit", "business case", "بازار", "سرمایه گذاری", "سود", "قیمت")),
    IslandProfile("accounting", ("accounting", "bookkeeping", "cash flow", "cost of goods", "costing", "inventory", "balance sheet", "break-even", "حسابداری", "جریان نقدی", "موجودی", "بهای تمام شده")),
    IslandProfile("science_research", ("research", "paper", "study", "evidence", "experiment", "scientific", "hypothesis", "verify", "source", "پژوهش", "مقاله", "شواهد", "آزمایش", "علمی")),
    IslandProfile("software_ai", ("software", "code", "coding", "programming", "architecture", "model", "ai", "algorithm", "api", "نرم افزار", "کدنویسی", "هوش مصنوعی", "معماری")),
    IslandProfile("security_risk", ("security", "threat", "risk", "privacy", "permission", "audit", "safety", "red team", "امنیت", "تهدید", "ریسک", "حریم خصوصی")),
)

def _review_level(mission: Mission, unknown_count: int, selection_count: int) -> ReviewLevel:
    risk = mission.risk_tier.casefold() if isinstance(mission.risk_tier, str) else "unrecognized"
    if mission.irreversible_action or risk == "critical":
        return ReviewLevel.HUMAN_GATED
    if risk == "high" or unknown_count >= 3:
        return ReviewLevel.STRICT
    if selection_count >= 2 or unknown_count:
        return ReviewLevel.STANDARD
    return ReviewLevel.LIGHT

def plan_coordination(mission: Mission, profiles: Iterable[IslandProfile] = DEFAULT_PROFILES) -> CoordinationPlan:
    """Return a traceable plan; selected islands are not claimed to have run."""
    original_objective = mission.objective if isinstance(mission.objective, str) else ""
    objective = " ".join(original_objective.casefold().split())
    risk_tier = mission.risk_tier.casefold() if isinstance(mission.risk_tier, str) else "unrecognized"
    enabled = []
    seen_profile_ids = set()
    duplicate_profile_ids = set()
    invalid_profile_count = 0
    for profile in profiles:
        if (
            not isinstance(profile, IslandProfile)
            or not isinstance(profile.island_id, str) or not profile.island_id.strip()
            or not isinstance(profile.keywords, (tuple, list))
            or isinstance(profile.keywords, str)
            or any(not isinstance(keyword, str) or not keyword.strip() for keyword in profile.keywords)
            or not isinstance(profile.enabled, bool)
        ):
            invalid_profile_count += 1
            continue
        if not profile.enabled:
            continue
        if profile.island_id in seen_profile_ids:
            duplicate_profile_ids.add(profile.island_id)
            continue
        seen_profile_ids.add(profile.island_id)
        enabled.append(profile)
    selections = []
    gaps, assumptions = [], []
    unknowns = [f"Duplicate island profile ID: {profile_id}" for profile_id in sorted(duplicate_profile_ids)]
    if invalid_profile_count:
        unknowns.append(f"{invalid_profile_count} invalid island profile(s) were excluded.")
    questions = []
    rationale = [
        "The Supreme Command Core retains policy authority and final synthesis.",
        "This is a routing proposal; selected islands have not yet been executed or consulted.",
        "Keyword matching is a transparent baseline, not proof of semantic relevance.",
    ]
    for profile in enabled:
        matched = tuple(
            keyword for keyword in profile.keywords
            if re.search(r"(?<!\w)" + re.escape(keyword.casefold()) + r"(?!\w)", objective)
        )
        if matched:
            selections.append(Selection(profile.island_id, matched[:6], "Matched terms: " + ", ".join(matched[:6])))
    if not original_objective.strip():
        unknowns.append("The mission objective is empty.")
        questions.append("What outcome should Master Brain achieve?")
    elif len(original_objective.split()) < 4:
        unknowns.append("The objective may not contain enough context for reliable routing.")
        questions.append("What context, constraints and success criteria should govern this task?")
    if not mission.success_criteria:
        assumptions.append("No explicit success criteria were supplied; confirm provisional criteria before high-impact decisions.")
    if not mission.constraints:
        assumptions.append("No explicit task constraints were supplied; global safety and policy limits still apply.")
    if not any(s.island_id != "general" for s in selections):
        gaps.append("No specialist island matched; clarify the objective or extend the registry.")
        unknowns.append("Specialist coverage is not established for this objective.")
    if risk_tier not in {"low", "medium", "high", "critical"}:
        unknowns.append("Unrecognized risk tier: " + repr(mission.risk_tier))
        questions.append("Confirm the risk tier before dispatch.")
    verification = [
        "Confirm selected islands are enabled and available before dispatch.",
        "Require provenance and limitations for factual claims returned by islands.",
        "Preserve counterevidence and unresolved disagreement; consensus is not ground truth.",
        "Evaluate the final result against success criteria and policy constraints.",
    ]
    if risk_tier in {"high", "critical"} or mission.irreversible_action:
        verification += [
            "Require explicit approval before consequential external actions.",
            "Independently check critical claims and calculations.",
        ]
    return CoordinationPlan(
        planner_version="0.1.0", original_objective=original_objective,
        selections=tuple(selections), assumptions=tuple(assumptions), unknowns=tuple(unknowns),
        clarification_questions=tuple(questions), verification_steps=tuple(verification),
        capability_gaps=tuple(gaps), review_level=_review_level(mission, len(unknowns), len(selections)),
        budget_units=max(0, mission.budget_units), deadline_seconds=max(1, mission.deadline_seconds),
        stop_conditions=("Stop when budget is exhausted.", "Return partial results when deadline is reached.",
                         "Ask for clarification if missing information could materially change a high-impact decision.",
                         "This planner does not execute external actions."),
        rationale=tuple(rationale),
    )
