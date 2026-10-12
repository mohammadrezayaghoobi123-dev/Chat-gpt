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
    risk = mission.risk_tier.casefold()
    if mission.irreversible_action or risk == "critical":
        return ReviewLevel.HUMAN_GATED
    if risk == "high" or unknown_count >= 3:
        return ReviewLevel.STRICT
    if selection_count >= 2 or unknown_count:
        return ReviewLevel.STANDARD
    return ReviewLevel.LIGHT

def plan_coordination(mission: Mission, profiles: Iterable[IslandProfile] = DEFAULT_PROFILES) -> CoordinationPlan:
    """Return a traceable plan; selected islands are not claimed to have run."""
    objective = " ".join(mission.objective.casefold().split())
    enabled = tuple(p for p in profiles if p.enabled)
    selections = []
    gaps, assumptions, unknowns, questions = [], [], [], []
    rationale = [
        "The Supreme Command Core retains policy authority and final synthesis.",
        "This is a routing proposal; selected islands have not yet been executed or consulted.",
        "Keyword matching is a transparent baseline, not proof of semantic relevance.",
    ]
    for profile in enabled:
        matched = tuple(
            keyword for keyword in profile.keywords
            if re.search(r"(?<!\\w)" + re.escape(keyword.casefold()) + r"(?!\\w)", objective)
        )
        if matched:
            selections.append(Selection(profile.island_id, matched[:6], "Matched terms: " + ", ".join(matched[:6])))
    if not mission.objective.strip():
        unknowns.append("The mission objective is empty.")
        questions.append("What outcome should Master Brain achieve?")
    elif len(mission.objective.split()) < 4:
        unknowns.append("The objective may not contain enough context for reliable routing.")
        questions.append("What context, constraints and success criteria should govern this task?")
    if not mission.success_criteria:
        assumptions.append("No explicit success criteria were supplied; confirm provisional criteria before high-impact decisions.")
    if not mission.constraints:
        assumptions.append("No explicit task constraints were supplied; global safety and policy limits still apply.")
    if not any(s.island_id != "general" for s in selections):
        gaps.append("No specialist island matched; clarify the objective or extend the registry.")
        unknowns.append("Specialist coverage is not established for this objective.")
    if mission.risk_tier.casefold() not in {"low", "medium", "high", "critical"}:
        unknowns.append("Unrecognized risk tier: " + mission.risk_tier)
        questions.append("Confirm the risk tier before dispatch.")
    verification = [
        "Confirm selected islands are enabled and available before dispatch.",
        "Require provenance and limitations for factual claims returned by islands.",
        "Preserve counterevidence and unresolved disagreement; consensus is not ground truth.",
        "Evaluate the final result against success criteria and policy constraints.",
    ]
    if mission.risk_tier.casefold() in {"high", "critical"} or mission.irreversible_action:
        verification += [
            "Require explicit approval before consequential external actions.",
            "Independently check critical claims and calculations.",
        ]
    return CoordinationPlan(
        planner_version="0.1.0", original_objective=mission.objective,
        selections=tuple(selections), assumptions=tuple(assumptions), unknowns=tuple(unknowns),
        clarification_questions=tuple(questions), verification_steps=tuple(verification),
        capability_gaps=tuple(gaps), review_level=_review_level(mission, len(unknowns), len(selections)),
        budget_units=max(0, mission.budget_units), deadline_seconds=max(1, mission.deadline_seconds),
        stop_conditions=("Stop when budget is exhausted.", "Return partial results when deadline is reached.",
                         "Ask for clarification if missing information could materially change a high-impact decision.",
                         "This planner does not execute external actions."),
        rationale=tuple(rationale),
    )
