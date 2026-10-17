"""Persisted mission contract and replay-derived mission lifecycle (MISSION-001/002/003).

The contract is persisted as one event in the hash-chained ``AuditStore`` (no second
store), so it survives restart and shares the store's tamper evidence. The mission
state is never stored: it is *derived* by replaying the verified audit history, so
there is no mutable status field that can disagree with the evidence.

Deliberate limits of the state vocabulary (MISSION-002): the lifecycle ends at
``RESPONSE_RECEIVED``. There is no COMPLETED/VERIFIED state, because a dispatch
response is not proof the intended effect happened, and independent verification
is a separate, not yet implemented stage. Outcomes whose external effect cannot be
excluded (timeout, adapter error, invalid output, any attempt with no finish event)
dominate later successes: such a mission needs reconciliation, not a retry.

Not provided here: authentication of ``actor`` (see mission_approval trust
boundary) and any change to the executors; requiring a registered contract before
dispatch is a separate, behavior-changing step.
"""
from __future__ import annotations

from dataclasses import asdict, dataclass
from enum import Enum
from typing import Any

from master_brain.audit_store import AuditPreconditionError, AuditStore
from master_brain.mission_approval import (
    APPROVAL_EVENT_TYPE,
    _contract_integrity_error,
    _json_value,
    mission_contract_digest,
)
from master_brain.mission_contract import (
    MissionContract,
    MissionReviewLevel,
    MissionRiskTier,
)

CONTRACT_REGISTERED_EVENT_TYPE = "mission.contract_registered"
_DISPATCH_STARTED = "mission.dispatch_started"
_DISPATCH_FINISHED = "mission.dispatch_finished"
# Statuses where the adapter was never invoked, so no external effect can have happened.
_NO_EFFECT_STATUSES = frozenset({"rejected", "adapter_missing"})
_SUCCESS_STATUS = "succeeded"

_TUPLE_FIELDS = (
    "constraints", "success_criteria", "selected_islands", "capability_gaps",
    "assumptions", "unknowns", "clarification_questions", "dependencies",
    "stop_conditions", "rationale", "traceability",
)


class MissionLifecycleError(Exception):
    """Persisted mission data is missing, inconsistent or failed verification."""


class MissionContractConflict(MissionLifecycleError):
    """A different contract is already registered under this mission_id."""


class MissionState(str, Enum):
    UNREGISTERED = "unregistered"
    PLANNED = "planned"
    APPROVED = "approved"
    DISPATCH_UNRESOLVED = "dispatch_unresolved"
    RESPONSE_RECEIVED = "response_received"
    DISPATCH_FAILED_NO_EFFECT = "dispatch_failed_no_effect"
    INCONSISTENT = "inconsistent"


@dataclass(frozen=True)
class RegisteredContract:
    event_id: str
    mission_id: str
    contract_digest: str
    recorded_at: str
    event_hash: str


@dataclass(frozen=True)
class MissionLifecycleView:
    mission_id: str
    state: MissionState
    contract_digest: str | None
    anomalies: tuple[str, ...] = ()


def _subject(mission_id: str) -> str:
    return f"mission:{mission_id}"


def _registrations(history, mission_id: str):
    return [
        e for e in history
        if e.event_type == CONTRACT_REGISTERED_EVENT_TYPE and e.subject_ref == _subject(mission_id)
    ]


def _contract_from_snapshot(snapshot: Any) -> MissionContract:
    if not isinstance(snapshot, dict):
        raise MissionLifecycleError("contract snapshot is not an object")
    data = dict(snapshot)
    try:
        for name in _TUPLE_FIELDS:
            data[name] = tuple(data[name])
        data["risk_tier"] = MissionRiskTier(data["risk_tier"])
        data["review_level"] = MissionReviewLevel(data["review_level"])
        return MissionContract(**data)
    except (KeyError, TypeError, ValueError) as exc:
        raise MissionLifecycleError(f"contract snapshot is invalid: {exc}") from exc


def register_mission_contract(
    store: AuditStore, contract: MissionContract, *,
    event_id: str, recorded_at: str, actor: str,
) -> RegisteredContract:
    """Persist ``contract`` once per mission_id (atomic; idempotent for the same digest).

    A different contract under an already-registered mission_id raises
    MissionContractConflict; a changed contract needs a new mission_id.
    """
    error = _contract_integrity_error(contract)
    if error:
        raise ValueError(error)
    digest = mission_contract_digest(contract)

    def _absent(history):
        if _registrations(history, contract.mission_id):
            return "mission_already_registered"
        return None

    try:
        event = store.append(
            event_id=event_id, event_type=CONTRACT_REGISTERED_EVENT_TYPE,
            recorded_at=recorded_at, actor=actor, subject_ref=_subject(contract.mission_id),
            payload={
                "mission_id": contract.mission_id,
                "contract_schema_version": contract.schema_version,
                "contract_digest": digest,
                "contract": _json_value(asdict(contract)),
            },
            precondition=_absent,
        )
    except AuditPreconditionError:
        existing = _registrations(store.read_all(), contract.mission_id)[0]
        if existing.payload.get("contract_digest") == digest:
            return RegisteredContract(
                existing.event_id, contract.mission_id, digest,
                existing.recorded_at, existing.event_hash)
        raise MissionContractConflict(
            f"a different contract is already registered for {contract.mission_id}") from None
    return RegisteredContract(event.event_id, contract.mission_id, digest,
                              event.recorded_at, event.event_hash)


def load_mission_contract(store: AuditStore, mission_id: str) -> MissionContract:
    """Rebuild the registered contract and verify it against its recorded digest.

    Raises MissionLifecycleError if absent, duplicated, malformed or if the snapshot
    does not hash to the digest recorded with it. A broken audit chain raises the
    store's own error: this never returns unverified data.
    """
    regs = _registrations(store.read_all(), mission_id)
    if not regs:
        raise MissionLifecycleError(f"no contract registered for mission {mission_id}")
    if len(regs) != 1:
        raise MissionLifecycleError(f"mission {mission_id} has multiple contract registrations")
    payload = regs[0].payload
    contract = _contract_from_snapshot(payload.get("contract"))
    if contract.mission_id != mission_id or payload.get("mission_id") != mission_id:
        raise MissionLifecycleError("registered contract belongs to a different mission")
    digest = mission_contract_digest(contract)
    if payload.get("contract_digest") != digest:
        raise MissionLifecycleError("registered contract does not match its recorded digest")
    return contract


def derive_mission_state(store: AuditStore, mission_id: str) -> MissionLifecycleView:
    """Derive the mission state by replaying verified history. Fails closed:
    any contradiction yields INCONSISTENT with the reasons listed."""
    history = [e for e in store.read_all() if e.subject_ref == _subject(mission_id)]
    regs = _registrations(history, mission_id)
    started = [e for e in history if e.event_type == _DISPATCH_STARTED]
    finished = [e for e in history if e.event_type == _DISPATCH_FINISHED]
    approvals = [e for e in history if e.event_type == APPROVAL_EVENT_TYPE]

    if not regs:
        if history:
            return MissionLifecycleView(
                mission_id, MissionState.INCONSISTENT, None,
                ("mission events exist without a registered contract",))
        return MissionLifecycleView(mission_id, MissionState.UNREGISTERED, None)

    anomalies: list[str] = []
    digest = None
    try:
        digest = mission_contract_digest(load_mission_contract(store, mission_id))
    except MissionLifecycleError as exc:
        anomalies.append(str(exc))

    started_attempts = {e.payload.get("attempt_id") for e in started}
    for e in started:
        if digest is not None and e.payload.get("contract_digest") != digest:
            anomalies.append(f"dispatch {e.event_id} used a different contract digest")
    for e in finished:
        if e.payload.get("attempt_id") not in started_attempts:
            anomalies.append(f"dispatch finish {e.event_id} has no matching start")
    if anomalies:
        return MissionLifecycleView(mission_id, MissionState.INCONSISTENT, digest, tuple(anomalies))

    status_by_attempt = {e.payload.get("attempt_id"): e.payload.get("dispatch_status") for e in finished}
    outcomes = [status_by_attempt.get(a) for a in started_attempts]  # None == no finish event
    if any(o is None or o not in _NO_EFFECT_STATUSES and o != _SUCCESS_STATUS for o in outcomes):
        state = MissionState.DISPATCH_UNRESOLVED
    elif any(o == _SUCCESS_STATUS for o in outcomes):
        state = MissionState.RESPONSE_RECEIVED
    elif outcomes:
        state = MissionState.DISPATCH_FAILED_NO_EFFECT
    elif any(e.payload.get("contract_digest") == digest for e in approvals):
        state = MissionState.APPROVED
    else:
        state = MissionState.PLANNED
    return MissionLifecycleView(mission_id, state, digest)


__all__ = [
    "CONTRACT_REGISTERED_EVENT_TYPE", "MissionContractConflict", "MissionLifecycleError",
    "MissionLifecycleView", "MissionState", "RegisteredContract",
    "derive_mission_state", "load_mission_contract", "register_mission_contract",
]
