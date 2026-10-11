"""Provider-neutral integration contracts and deterministic candidate filtering.

This module only describes and filters integrations. It does not call models,
tools, networks, or external actions. A selected candidate has not been invoked.
"""
from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from math import isfinite
from typing import Iterable


class IntegrationKind(str, Enum):
    MODEL = "model"
    RETRIEVAL_TOOL = "retrieval_tool"
    ACTION_TOOL = "action_tool"
    DATA_SOURCE = "data_source"
    EVALUATOR = "evaluator"
    AGENT = "agent"


class IntegrationMaturity(str, Enum):
    DISCOVERED = "discovered"
    REVIEWED = "reviewed"
    CONTRACT_TESTED = "contract_tested"
    SECURITY_REVIEWED = "security_reviewed"
    ENABLED = "enabled"
    MONITORED = "monitored"
    SUSPENDED = "suspended"
    RETIRED = "retired"


class IntegrationHealth(str, Enum):
    UNKNOWN = "unknown"
    AVAILABLE = "available"
    DEGRADED = "degraded"
    UNAVAILABLE = "unavailable"


@dataclass(frozen=True)
class IntegrationDescriptor:
    """Auditable metadata for one provider/tool adapter; not credentials."""

    integration_id: str
    version: str
    kind: IntegrationKind
    capabilities: tuple[str, ...]
    maturity: IntegrationMaturity = IntegrationMaturity.DISCOVERED
    health: IntegrationHealth = IntegrationHealth.UNKNOWN
    permission_scopes: tuple[str, ...] = ()
    risk_level: int = 0
    estimated_cost_per_call: float | None = None
    data_regions: tuple[str, ...] = ()
    limitations: tuple[str, ...] = ()

    def __post_init__(self) -> None:
        for name in ("integration_id", "version"):
            value = getattr(self, name)
            if not isinstance(value, str) or not value.strip():
                raise ValueError(f"{name} must be a non-empty string")
        enum_types = {
            "kind": IntegrationKind,
            "maturity": IntegrationMaturity,
            "health": IntegrationHealth,
        }
        for name, enum_type in enum_types.items():
            if not isinstance(getattr(self, name), enum_type):
                raise TypeError(f"{name} has an invalid enum type")
        for name in ("capabilities", "permission_scopes", "data_regions", "limitations"):
            value = getattr(self, name)
            if not isinstance(value, tuple):
                raise TypeError(f"{name} must be a tuple")
            if any(not isinstance(item, str) or not item.strip() for item in value):
                raise ValueError(f"{name} entries must be non-empty strings")
        if len(set(self.capabilities)) != len(self.capabilities):
            raise ValueError("capabilities must be unique")
        if type(self.risk_level) is not int or not 0 <= self.risk_level <= 4:
            raise ValueError("risk_level must be an integer from 0 through 4")
        if self.estimated_cost_per_call is not None:
            cost = self.estimated_cost_per_call
            if isinstance(cost, bool) or not isinstance(cost, (int, float)):
                raise TypeError("estimated_cost_per_call must be numeric or None")
            if not isfinite(cost) or cost < 0:
                raise ValueError("estimated_cost_per_call must be finite and >= 0")


@dataclass(frozen=True)
class IntegrationRequirement:
    """Capability and policy requirements for a proposed integration call."""

    capabilities: tuple[str, ...]
    required_kind: IntegrationKind | None = None
    required_permission_scopes: tuple[str, ...] = ()
    allowed_data_regions: tuple[str, ...] = ()
    max_risk_level: int = 0
    max_cost_per_call: float | None = None

    def __post_init__(self) -> None:
        if self.required_kind is not None and not isinstance(self.required_kind, IntegrationKind):
            raise TypeError("required_kind must be an IntegrationKind or None")
        for name in ("capabilities", "required_permission_scopes", "allowed_data_regions"):
            value = getattr(self, name)
            if not isinstance(value, tuple):
                raise TypeError(f"{name} must be a tuple")
            if any(not isinstance(item, str) or not item.strip() for item in value):
                raise ValueError(f"{name} entries must be non-empty strings")
        if type(self.max_risk_level) is not int or not 0 <= self.max_risk_level <= 4:
            raise ValueError("max_risk_level must be an integer from 0 through 4")
        if self.max_cost_per_call is not None:
            value = self.max_cost_per_call
            if isinstance(value, bool) or not isinstance(value, (int, float)):
                raise TypeError("max_cost_per_call must be numeric or None")
            if not isfinite(value) or value < 0:
                raise ValueError("max_cost_per_call must be finite and >= 0")


@dataclass(frozen=True)
class CandidateAssessment:
    integration_id: str
    eligible: bool
    reasons: tuple[str, ...]


def assess_integration(
    integration: IntegrationDescriptor,
    requirement: IntegrationRequirement,
) -> CandidateAssessment:
    """Explain deterministic eligibility; never invokes the integration."""
    reasons: list[str] = []
    if requirement.required_kind is not None and integration.kind is not requirement.required_kind:
        reasons.append(
            f"integration kind is {integration.kind.value}, not required kind "
            f"{requirement.required_kind.value}"
        )
    if integration.maturity not in {IntegrationMaturity.ENABLED, IntegrationMaturity.MONITORED}:
        reasons.append("integration is not enabled")
    if integration.health is not IntegrationHealth.AVAILABLE:
        reasons.append(f"integration health is {integration.health.value}, not available")
    missing = sorted(set(requirement.capabilities) - set(integration.capabilities))
    if missing:
        reasons.append("missing capabilities: " + ", ".join(missing))
    missing_scopes = sorted(set(requirement.required_permission_scopes) - set(integration.permission_scopes))
    if missing_scopes:
        reasons.append("missing permission scopes: " + ", ".join(missing_scopes))
    if integration.risk_level > requirement.max_risk_level:
        reasons.append("integration risk level exceeds mission limit")
    if requirement.allowed_data_regions:
        if not integration.data_regions:
            reasons.append("data-region compatibility is unknown")
        elif not set(integration.data_regions).intersection(requirement.allowed_data_regions):
            reasons.append("no allowed data-region match")
    if requirement.max_cost_per_call is not None:
        if integration.estimated_cost_per_call is None:
            reasons.append("cost is unknown under a bounded-cost requirement")
        elif integration.estimated_cost_per_call > requirement.max_cost_per_call:
            reasons.append("estimated cost exceeds per-call budget")
    return CandidateAssessment(integration.integration_id, not reasons, tuple(reasons))


def assess_candidates(
    integrations: Iterable[IntegrationDescriptor],
    requirement: IntegrationRequirement,
) -> tuple[CandidateAssessment, ...]:
    """Assess all candidates and preserve exclusion reasons in input order."""
    return tuple(assess_integration(item, requirement) for item in integrations)
