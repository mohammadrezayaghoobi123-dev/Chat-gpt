"""Policy-gated mission execution pipeline prototype.

This composes the existing contract approval gate and dispatch boundary. It is
not a production identity provider, distributed transaction, or proof that an
external side effect occurred. Callers supply authenticated actor metadata and
unique event IDs/timestamps.
"""
from __future__ import annotations

from dataclasses import dataclass
import hashlib
import json
from typing import Any, Mapping

from master_brain.audit_store import AuditStore, AuditStoreError
from master_brain.dispatch import DispatchResult, DispatchStatus, IntegrationAdapter, dispatch_once
from master_brain.integrations import IntegrationDescriptor, IntegrationRequirement
from master_brain.mission_approval import (
    MissionApprovalReceipt,
    evaluate_approved_execution_gate,
    mission_contract_digest,
)
from master_brain.mission_contract import MissionContract
from master_brain.execution_registry import (
    IdempotencyConflict, RegistryError, SQLiteExecutionRegistry, State,
)


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
    except Exception:
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
    except Exception:
        return MissionExecutionResult(
            contract.mission_id,
            "executed_audit_incomplete",
            dispatch_result=result,
            reason="post_dispatch_audit_failed_do_not_retry_blindly",
        )

    if result.status is DispatchStatus.SUCCEEDED:
        return MissionExecutionResult(
            contract.mission_id, "response_received", dispatch_result=result,
            reason="external_effect_not_confirmed",
        )
    if result.status is DispatchStatus.ADAPTER_ERROR:
        # The adapter may have caused an external side effect before raising.
        # An exception is therefore uncertainty, not proof of a clean failure.
        return MissionExecutionResult(
            contract.mission_id, "outcome_unknown", dispatch_result=result,
            reason="adapter_exception_external_effect_may_have_occurred",
        )
    if (
        result.status is DispatchStatus.INVALID_OUTPUT
        and result.reason == "output_not_json_compatible_object"
    ):
        # The adapter was invoked and may already have caused an external
        # effect; malformed output is not proof that the effect did not occur.
        return MissionExecutionResult(
            contract.mission_id, "outcome_unknown", dispatch_result=result,
            reason="invalid_adapter_output_external_effect_may_have_occurred",
        )
    return MissionExecutionResult(
        contract.mission_id, "dispatch_failed", dispatch_result=result, reason=result.reason
    )


def execute_mission_idempotently(
    contract: MissionContract,
    store: AuditStore,
    receipt: MissionApprovalReceipt | None,
    integration: IntegrationDescriptor,
    requirement: IntegrationRequirement,
    adapter: IntegrationAdapter | None,
    payload: Mapping[str, Any],
    registry: SQLiteExecutionRegistry,
    *,
    idempotency_key: str,
    event_id_prefix: str,
    recorded_at: str,
    actor: str,
) -> MissionExecutionResult:
    """Reserve a stable key before dispatch; duplicates never invoke the adapter.

    This local prototype is deliberately conservative: any result after the
    dispatch boundary is recorded as OUTCOME_UNKNOWN until provider-specific
    completion evidence can be verified. It is not distributed exactly-once.
    """
    gate = evaluate_approved_execution_gate(contract, store, receipt)
    if not gate.allowed:
        return MissionExecutionResult(contract.mission_id, "rejected", reason="; ".join(gate.reasons))

    # Validate all caller-controlled execution metadata before reserving or
    # claiming a registry record. Invalid metadata must not strand a mission
    # in RUNNING/OUTCOME_UNKNOWN when no dispatch attempt was possible.
    for name, value in (
        ("idempotency_key", idempotency_key),
        ("event_id_prefix", event_id_prefix),
        ("recorded_at", recorded_at),
        ("actor", actor),
    ):
        if not isinstance(value, str) or not value.strip():
            return MissionExecutionResult(
                contract.mission_id, "rejected", reason=f"invalid_{name}"
            )

    try:
        payload_bytes = json.dumps(
            payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False
        ).encode("utf-8")
        payload_digest = hashlib.sha256(payload_bytes).hexdigest()
        contract_digest = mission_contract_digest(contract)
        record, created = registry.reserve(
            key=idempotency_key, mission_id=contract.mission_id,
            contract_digest=contract_digest, payload_digest=payload_digest,
            recorded_at=recorded_at,
        )
    except IdempotencyConflict:
        return MissionExecutionResult(contract.mission_id, "idempotency_conflict", reason="key_reused_with_different_request")
    except (RegistryError, TypeError, ValueError):
        return MissionExecutionResult(contract.mission_id, "registry_unavailable", reason="reservation_failed")

    if not created:
        return MissionExecutionResult(
            contract.mission_id, "duplicate_existing_execution",
            reason=f"existing_execution_state:{record.state.value}",
        )

    try:
        running = registry.transition(
            key=idempotency_key, expected_version=record.version, target=State.RUNNING,
            recorded_at=recorded_at,
        )
    except RegistryError:
        return MissionExecutionResult(
            contract.mission_id, "registry_unavailable",
            reason="claim_failed_adapter_not_invoked",
        )

    try:
        result = execute_mission_once(
            contract, store, receipt, integration, requirement, adapter, payload,
            event_id_prefix=event_id_prefix, recorded_at=recorded_at, actor=actor,
        )
    except Exception:
        result = MissionExecutionResult(
            contract.mission_id, "outcome_unknown",
            reason="execution_exception_after_claim; external_effect_may_have_occurred",
        )
    # Once the registry enters RUNNING, this generic API cannot prove that
    # dispatch did not happen. Even for known pre-dispatch aborts, keep the
    # record in OUTCOME_UNKNOWN until a dedicated evidence-aware terminal
    # transition exists; never bypass the registry's fail-closed state guard.
    target = State.OUTCOME_UNKNOWN
    try:
        registry.transition(
            key=idempotency_key, expected_version=running.version, target=target,
            recorded_at=recorded_at,
        )
    except RegistryError:
        return MissionExecutionResult(
            contract.mission_id, "execution_registry_incomplete",
            dispatch_result=result.dispatch_result,
            reason="registry_update_failed_do_not_retry_blindly",
        )
    return MissionExecutionResult(
        contract.mission_id, result.status, dispatch_result=result.dispatch_result,
        reason=(result.reason + "; registry_state:" + target.value).strip("; "),
    )


__all__ = ["MissionExecutionResult", "execute_mission_once", "execute_mission_idempotently"]
