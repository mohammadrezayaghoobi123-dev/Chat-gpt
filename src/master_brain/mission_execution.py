"""Policy-gated mission execution pipeline prototype.

This composes the existing contract approval gate and dispatch boundary. It is
not a production identity provider, distributed transaction, or proof that an
external side effect occurred. Callers supply authenticated actor metadata and
unique event IDs/timestamps.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Mapping

from master_brain.audit_store import AuditStore, AuditStoreError
from master_brain.dispatch import DispatchResult, DispatchStatus, dispatch_once
from master_brain.integrations import IntegrationAdapter, IntegrationDescriptor, IntegrationRequirement
from master_brain.mission_approval import (
    MissionApprovalReceipt,
    evaluate_approved_execution_gate,
    mission_contract_digest,
)
from master_brain.mission_contract import MissionContract


@dataclass(frozen=True)
class MissionExecutionResult:
    mission_id: str
    status: str
    dispatch_result: DispatchResult | None = None
    reason: str = ""


def execute_mission_once(
    contract: MissionContract,
    store: AuditStore,
    receipt: MissionApprovalReceipt | None,
    integration: IntegrationDescriptor,
    requirement: IntegrationRequirement,
    adapter: IntegrationAdapter | None,
    payload: Mapping[str, Any],
    *,
    event_id_prefix: str,
    recorded_at: str,
    actor: str,
) -> MissionExecutionResult:
    """Gate, write a pre-dispatch audit event, dispatch once, then record outcome.

    If pre-dispatch audit persistence fails, the adapter is not invoked. If
    post-dispatch persistence fails, the returned status explicitly says the
    outcome is not fully audited; callers must not blindly retry side effects.
    """
    gate = evaluate_approved_execution_gate(contract, store, receipt)
    if not gate.allowed:
        return MissionExecutionResult(
            contract.mission_id, "rejected", reason="; ".join(gate.reasons)
        )

    if not isinstance(event_id_prefix, str) or not event_id_prefix.strip():
        return MissionExecutionResult(contract.mission_id, "rejected", reason="invalid_event_id_prefix")
    if not isinstance(recorded_at, str) or not recorded_at.strip():
        return MissionExecutionResult(contract.mission_id, "rejected", reason="invalid_recorded_at")
    if not isinstance(actor, str) or not actor.strip():
        return MissionExecutionResult(contract.mission_id, "rejected", reason="invalid_actor")

    try:
        store.append(
            event_id=f"{event_id_prefix}:dispatch-started",
            event_type="mission.dispatch_started",
            recorded_at=recorded_at,
            actor=actor,
            subject_ref=f"mission:{contract.mission_id}",
            payload={
                "mission_id": contract.mission_id,
                "contract_digest": mission_contract_digest(contract),
                "integration_id": getattr(integration, "integration_id", "unknown"),
            },
        )
    except (AuditStoreError, OSError, ValueError, TypeError):
        return MissionExecutionResult(
            contract.mission_id, "audit_unavailable", reason="pre_dispatch_audit_failed"
        )

    result = dispatch_once(integration, requirement, adapter, payload)
    try:
        store.append(
            event_id=f"{event_id_prefix}:dispatch-finished",
            event_type="mission.dispatch_finished",
            recorded_at=recorded_at,
            actor=actor,
            subject_ref=f"mission:{contract.mission_id}",
            payload={
                "mission_id": contract.mission_id,
                "integration_id": result.integration_id,
                "dispatch_status": result.status.value,
                "reason": result.reason,
                "external_effect_confirmed": False,
            },
        )
    except (AuditStoreError, OSError, ValueError, TypeError):
        return MissionExecutionResult(
            contract.mission_id,
            "executed_audit_incomplete",
            dispatch_result=result,
            reason="post_dispatch_audit_failed_do_not_retry_blindly",
        )

    if result.status is DispatchStatus.SUCCEEDED:
        return MissionExecutionResult(
            contract.mission_id,
            "response_received",
            dispatch_result=result,
            reason="external_effect_not_confirmed",
        )
    return MissionExecutionResult(
        contract.mission_id, "dispatch_failed", dispatch_result=result, reason=result.reason
    )


__all__ = ["MissionExecutionResult", "execute_mission_once"]
