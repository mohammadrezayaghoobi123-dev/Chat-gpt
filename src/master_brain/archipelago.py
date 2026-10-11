"""Initial multi-island mission planner for the Master Brain archipelago.

This module plans collaboration but does not call models or execute actions.
Routing is deterministic, transparent, and replaceable.
"""
from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from typing import Iterable


class Layer(str, Enum):
    COMMAND = "supreme_command"
    META_COORDINATION = "meta_intelligence"
    SPECIALIST = "specialist_island"
    SHARED_FOUNDATION = "shared_foundation"


@dataclass(frozen=True)
class Island:
    island_id: str
    display_name: str
    keywords: tuple[str, ...]
    description: str
    enabled: bool = True


@dataclass(frozen=True)
class IslandAssignment:
    island_id: str
    reason: str


@dataclass(frozen=True)
class MissionPlan:
    objective: str
    command_core: str
    coordination_layer: str
    assignments: tuple[IslandAssignment, ...]
    shared_foundations: tuple[str, ...]
    capability_gaps: tuple[str, ...]
    rationale: tuple[str, ...]


DEFAULT_ISLANDS: tuple[Island, ...] = (
    Island("general", "General reasoning", ("general", "plan", "strategy", "decision"), "General reasoning and problem framing."),
    Island("industrial", "Industrial engineering", ("factory", "industrial", "machine", "manufacturing", "production", "material", "formulation", "capacity", "supplier"), "Industrial operations, engineering and manufacturing."),
    Island("economics", "Economics and markets", ("economics", "economic", "market", "demand", "price", "investment", "profit", "business case"), "Market analysis, economic scenarios and investment evaluation."),
    Island("accounting", "Accounting and finance", ("accounting", "bookkeeping", "cash flow", "cost of goods", "costing", "inventory", "balance sheet", "break-even"), "Accounting, cost models, cash flow and inventory."),
    Island("science_research", "Science and research", ("research", "paper", "study", "evidence", "experiment", "scientific", "hypothesis", "verify", "source"), "Evidence-led research, hypotheses and validation planning."),
    Island("software_ai", "Software and AI", ("software", "code", "coding", "programming", "architecture", "model", "ai", "algorithm", "api"), "Software engineering, AI systems and model evaluation."),
    Island("security_risk", "Security and risk", ("security", "threat", "risk", "privacy", "permission", "audit", "safety", "red team"), "Security, risk assessment and governance."),
)


def plan_mission(
    objective: str,
    islands: Iterable[Island] = DEFAULT_ISLANDS,
) -> MissionPlan:
    """Create a transparent multi-island plan from a natural-language objective.

    This is an initial keyword baseline, not semantic understanding. It always
    includes the general island and shared proof/memory/policy foundations.
    """
    normalized = " ".join(objective.casefold().split())
    available = tuple(island for island in islands if island.enabled)
    assignments: list[IslandAssignment] = []
    gaps: list[str] = []
    rationale: list[str] = [
        "The Supreme Command Core owns the objective, policy boundaries and final synthesis.",
        "The Meta-Intelligence Layer decomposes the mission and coordinates selected islands.",
    ]

    general = next((island for island in available if island.island_id == "general"), None)
    if general:
        assignments.append(IslandAssignment(general.island_id, "Always included for framing and cross-domain synthesis."))
    else:
        gaps.append("general")

    for island in available:
        if island.island_id == "general":
            continue
        matched = tuple(keyword for keyword in island.keywords if keyword in normalized)
        if matched:
            assignments.append(IslandAssignment(
                island.island_id,
                "Matched objective terms: " + ", ".join(matched[:5]) + ".",
            ))

    if not any(item.island_id != "general" for item in assignments):
        rationale.append("No specialist rule matched; this plan may need clarification or a new island.")
    if not objective.strip():
        rationale.append("Objective is empty; clarify the mission before execution.")

    return MissionPlan(
        objective=objective,
        command_core="supreme_command",
        coordination_layer="meta_intelligence",
        assignments=tuple(assignments),
        shared_foundations=("intelligence_plane", "proof_plane", "memory_and_evidence", "security_and_policy", "audit_and_budget"),
        capability_gaps=tuple(gaps),
        rationale=tuple(rationale),
    )
