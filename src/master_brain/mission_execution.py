"""Policy-gated mission execution pipeline prototype.

This composes the existing contract approval gate and dispatch boundary. It is
not a production identity provider, distributed transaction, or proof that an
external side effect occurred. Callers supply authenticated actor metadata and
unique event IDs/timestamps.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
import hashlib
import json
from typing import Any, Callable, Mapping

from master_brain.audit_store import NOW, AuditPreconditionError, AuditStore, AuditStoreError
from master_brain.dispatch import DispatchResult, DispatchStatus, IntegrationAdapter, dispatch_once
from master_brain.integrations import IntegrationDescriptor, IntegrationRequirement
from master_brain.mission_lifecycle import (
    MissionLifecycleError, MissionState, derive_mission_state, load_mission_contract,
    unresolved_attempt_ids,
)
from master_brain.approval_signing import ApprovalVerifier
from master_brain.mission_approval import (
    MissionApprovalReceipt,
    action_digest,
    evaluate_approved_execution_gate,
    mission_contract_digest,
)
from master_brain.mission_contract import MissionContract, MissionRiskTier
from master_brain.execution_registry import (
    DuplicateIntent, IdempotencyConflict, RegistryError, SQLiteExecutionRegistry, State,
)


@dataclass(frozen=True)
class MissionExecutionResult:
    mission_id: str
    status: str
    dispatch_result: DispatchResult | None = None
    reason: str = ""


# Effective risk is taken from the mission contract only: a caller-supplied
# requirement may narrow, but never raise, the integration risk the contract allows.
MAX_INTEGRATION_RISK_BY_TIER = {
    MissionRiskTier.LOW: 1,
    MissionRiskTier.MEDIUM: 2,
    MissionRiskTier.HIGH: 3,
    MissionRiskTier.CRITICAL: 4,
}


def _requirement_exceeds_contract_risk(contract: Any, requirement: Any) -> str | None:
    ceiling = MAX_INTEGRATION_RISK_BY_TIER.get(getattr(contract, "risk_tier", None))
    if ceiling is None:
        return "unknown_contract_risk_tier"
    requested = getattr(requirement, "max_risk_level", None)
    if type(requested) is not int or requested > ceiling:
        return "requirement_exceeds_contract_risk_ceiling"
    return None


def _is_timezone_aware_timestamp(value: Any) -> bool:
    """Accept ISO-8601 timestamps only when an explicit UTC offset is present."""
    if not isinstance(value, str) or not value.strip():
        return False
    try:
        parsed = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
    except ValueError:
        return False
    return parsed.tzinfo is not None and parsed.utcoffset() is not None


def _snapshot_payload(payload: Any) -> Any:
    """Detached JSON copy taken ONCE at the entry point (closes check/use races).

    The approval digest, registry digest and dispatch must all see the same bytes;
    otherwise a shared mutable mapping could be changed after the gate approved it.
    Non-JSON payloads are returned unchanged so existing validation still rejects
    them (and an action-bound approval fails closed because no digest can be made).
    """
    try:
        return json.loads(json.dumps(dict(payload), allow_nan=False))
    except (TypeError, ValueError, OverflowError):
        return payload


def _safe_action_digest(integration: Any, payload: Any) -> str | None:
    """Digest of the concrete action; None if it cannot be canonicalized (fails closed
    only when the approval is action-bound)."""
    try:
        return action_digest(getattr(integration, "integration_id", ""), payload)
    except (TypeError, ValueError):
        return None


def _registration_error(contract: MissionContract, store: AuditStore) -> str | None:
    """Fail closed unless this exact contract is the one registered and the mission's
    replayed lifecycle is consistent. Runs before any dispatch audit/reservation."""
    try:
        registered = load_mission_contract(store, contract.mission_id)
        if mission_contract_digest(registered) != mission_contract_digest(contract):
            return "registered_contract_mismatch"
        if derive_mission_state(store, contract.mission_id).state is MissionState.INCONSISTENT:
            return "mission_lifecycle_inconsistent"
    except MissionLifecycleError as exc:
        text = str(exc)
        return "contract_not_registered" if text.startswith("no contract registered") \
            else "mission_lifecycle_inconsistent"
    except Exception:  # audit unreadable/invalid: no verified registration
        return "mission_lifecycle_unavailable"
    return None


UNRESOLVED_REASON = "mission_dispatch_unresolved_requires_reconciliation"


def _unresolved_error(contract: MissionContract, store: AuditStore) -> str | None:
    """Early (non-atomic) block: an earlier attempt's external effect is unresolved.

    The authoritative, race-free check is the precondition on the dispatch-started
    append; this one only avoids reserving work that would be refused."""
    try:
        if unresolved_attempt_ids(store.read_all(), contract.mission_id):
            return UNRESOLVED_REASON
    except Exception:
        return "mission_lifecycle_unavailable"
    return None


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
    before_dispatch: Callable[[], None] | None = None,
    attempt_id: str | None = None,
    dispatch_timeout_seconds: float | None = None,
    approval_verifier: ApprovalVerifier | None = None,
) -> MissionExecutionResult:
    """Gate, write a pre-dispatch audit event, dispatch once, then record outcome.

    If pre-dispatch audit persistence fails, the adapter is not invoked. If
    post-dispatch persistence fails, the returned status explicitly says the
    outcome is not fully audited; callers must not blindly retry side effects.
    """
    if attempt_id is None and isinstance(event_id_prefix, str) and event_id_prefix.strip():
        # Direct runs still need a distinct attempt id: audit event ids are unique, so
        # one derived from the prefix keeps separate runs from collapsing into one.
        attempt_id = f"direct:{event_id_prefix}"
    payload = _snapshot_payload(payload)
    gate = evaluate_approved_execution_gate(
        contract, store, receipt, _safe_action_digest(integration, payload),
        verifier=approval_verifier,
    )
    if not gate.allowed:
        return MissionExecutionResult(
            contract.mission_id, "rejected", reason="; ".join(gate.reasons)
        )
    risk_reason = _requirement_exceeds_contract_risk(contract, requirement)
    if risk_reason:
        return MissionExecutionResult(contract.mission_id, "rejected", reason=risk_reason)
    registration_reason = _registration_error(contract, store)
    if registration_reason:
        return MissionExecutionResult(contract.mission_id, "rejected", reason=registration_reason)
    unresolved_reason = _unresolved_error(contract, store)
    if unresolved_reason:
        return MissionExecutionResult(contract.mission_id, "rejected", reason=unresolved_reason)

    if not isinstance(event_id_prefix, str) or not event_id_prefix.strip():
        return MissionExecutionResult(contract.mission_id, "rejected", reason="invalid_event_id_prefix")
    if recorded_at is not NOW and (not isinstance(recorded_at, str) or not recorded_at.strip()):
        return MissionExecutionResult(contract.mission_id, "rejected", reason="invalid_recorded_at")
    if not isinstance(actor, str) or not actor.strip():
        return MissionExecutionResult(contract.mission_id, "rejected", reason="invalid_actor")

    # An approval bound to one concrete action is single-use: it is consumed
    # atomically (under the audit store lock) by the first dispatch-started event
    # that references it. Contract-only approvals remain reusable.
    consumes_approval = (
        isinstance(receipt, MissionApprovalReceipt) and receipt.action_digest is not None
    )
    approval_event_id = receipt.event_id if consumes_approval else None

    def _dispatch_admissible(history):
        if consumes_approval:
            for event in history:
                if (
                    event.event_type == "mission.dispatch_started"
                    and event.payload.get("approval_event_id") == approval_event_id
                ):
                    return "approval_already_consumed"
        if unresolved_attempt_ids(history, contract.mission_id):
            return UNRESOLVED_REASON
        return None

    try:
        store.append(
            precondition=_dispatch_admissible,
            event_id=f"{event_id_prefix}:dispatch-started",
            event_type="mission.dispatch_started",
            recorded_at=recorded_at,
            actor=actor,
            subject_ref=f"mission:{contract.mission_id}",
            payload={
                "mission_id": contract.mission_id,
                "contract_digest": mission_contract_digest(contract),
                "integration_id": getattr(integration, "integration_id", "unknown"),
                "attempt_id": attempt_id,
                **({"approval_event_id": approval_event_id} if consumes_approval else {}),
            },
        )
    except AuditPreconditionError as exc:
        return MissionExecutionResult(contract.mission_id, "rejected", reason=str(exc))
    except Exception:
        return MissionExecutionResult(
            contract.mission_id, "audit_unavailable", reason="pre_dispatch_audit_failed"
        )

    if before_dispatch is not None:
        try:
            before_dispatch()
        except Exception:
            return MissionExecutionResult(
                contract.mission_id, "registry_unavailable",
                reason="dispatch_boundary_persistence_failed_adapter_not_invoked",
            )

    result = dispatch_once(
        integration, requirement, adapter, payload,
        timeout_seconds=dispatch_timeout_seconds,
    )
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
                "attempt_id": attempt_id,
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
    if result.status is DispatchStatus.TIMEOUT:
        # The adapter was invoked and may still be running or may complete later.
        return MissionExecutionResult(
            contract.mission_id, "outcome_unknown", dispatch_result=result,
            reason="adapter_timeout_external_effect_may_have_occurred",
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


def execution_event_id_prefix_for(event_id_prefix: str, idempotency_key: str) -> str:
    """Audit event-id prefix of one idempotent execution (public so callers can locate its events)."""
    return f"{event_id_prefix}:{hashlib.sha256(idempotency_key.encode('utf-8')).hexdigest()[:16]}"


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
    dispatch_timeout_seconds: float | None = None,
    approval_verifier: ApprovalVerifier | None = None,
) -> MissionExecutionResult:
    """Reserve a stable key before dispatch; duplicates never invoke the adapter.

    This local prototype is deliberately conservative: any result after the
    dispatch boundary is recorded as OUTCOME_UNKNOWN until provider-specific
    completion evidence can be verified. It is not distributed exactly-once.
    """
    payload = _snapshot_payload(payload)

    def _rt() -> str:
        """Registry timestamp. ``recorded_at=NOW`` means audit events are stamped under the store
        lock (never backdated by a concurrent writer); the registry just gets the current time."""
        return recorded_at if isinstance(recorded_at, str) else store.now().isoformat().replace("+00:00", "Z")

    gate = evaluate_approved_execution_gate(
        contract, store, receipt, _safe_action_digest(integration, payload),
        verifier=approval_verifier,
    )
    if not gate.allowed:
        return MissionExecutionResult(contract.mission_id, "rejected", reason="; ".join(gate.reasons))
    risk_reason = _requirement_exceeds_contract_risk(contract, requirement)
    if risk_reason:
        return MissionExecutionResult(contract.mission_id, "rejected", reason=risk_reason)
    registration_reason = _registration_error(contract, store)
    if registration_reason:
        return MissionExecutionResult(contract.mission_id, "rejected", reason=registration_reason)

    # Validate all caller-controlled execution metadata before reserving or
    # claiming a registry record. Invalid metadata must not strand a mission
    # in RUNNING/OUTCOME_UNKNOWN when no dispatch attempt was possible.
    for name, value in (
        ("idempotency_key", idempotency_key),
        ("event_id_prefix", event_id_prefix),
        ("recorded_at", recorded_at),
        ("actor", actor),
    ):
        valid = (
            value is NOW or _is_timezone_aware_timestamp(value)
            if name == "recorded_at"
            else isinstance(value, str) and bool(value.strip())
        )
        if not valid:
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
            recorded_at=_rt(),
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

    # A same-key replay is answered above; a NEW key must not start work while an
    # earlier attempt of this mission is unresolved. No dispatch happened for this
    # key, so close it as FAILED (allowed from PENDING) instead of stranding it.
    unresolved_reason = _unresolved_error(contract, store)
    if unresolved_reason:
        try:
            registry.transition(
                key=idempotency_key, expected_version=record.version, target=State.FAILED,
                recorded_at=_rt(),
            )
        except RegistryError:
            pass
        return MissionExecutionResult(contract.mission_id, "rejected", reason=unresolved_reason)

    try:
        running = registry.transition(
            key=idempotency_key, expected_version=record.version, target=State.RUNNING,
            recorded_at=_rt(),
        )
    except DuplicateIntent:
        # No dispatch happened for this key: close it as FAILED (allowed from PENDING)
        # so it does not linger, and never invoke the adapter.
        try:
            registry.transition(
                key=idempotency_key, expected_version=record.version, target=State.FAILED,
                recorded_at=_rt(),
            )
        except RegistryError:
            pass
        return MissionExecutionResult(
            contract.mission_id, "duplicate_intent",
            reason="same_intent_already_ran_or_unknown_under_another_key_adapter_not_invoked",
        )
    except RegistryError:
        return MissionExecutionResult(
            contract.mission_id, "registry_unavailable",
            reason="claim_failed_adapter_not_invoked",
        )

    # Persist a distinct attempt before entering the adapter/dispatch path.
    # A failure here must never invoke the adapter.
    try:
        attempt = registry.reserve_attempt(
            key=idempotency_key,
            expected_version=running.version,
            integration_id=integration.integration_id,
            adapter_version=integration.version,
            provider_id=str(getattr(integration, "provider_id", "unspecified")),
            recorded_at=_rt(),
        )
    except (RegistryError, TypeError, ValueError):
        return MissionExecutionResult(
            contract.mission_id, "registry_unavailable",
            reason="attempt_reservation_or_boundary_failed_adapter_not_invoked",
        )

    # Audit event IDs must be unique across distinct executions even when a
    # caller reuses a human-readable prefix. The stable key-derived suffix
    # preserves retry identity without exposing the raw idempotency key.
    execution_event_id_prefix = execution_event_id_prefix_for(event_id_prefix, idempotency_key)
    try:
        result = execute_mission_once(
            contract, store, receipt, integration, requirement, adapter, payload,
            event_id_prefix=execution_event_id_prefix,
            recorded_at=recorded_at, actor=actor,
            before_dispatch=lambda: registry.mark_attempt_dispatch_boundary(
                attempt_id=attempt.attempt_id, recorded_at=_rt()
            ),
            attempt_id=attempt.attempt_id,
            dispatch_timeout_seconds=dispatch_timeout_seconds,
            approval_verifier=approval_verifier,
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
            recorded_at=_rt(),
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


__all__ = ["MissionExecutionResult", "execute_mission_once", "execute_mission_idempotently",
           "execution_event_id_prefix_for"]
