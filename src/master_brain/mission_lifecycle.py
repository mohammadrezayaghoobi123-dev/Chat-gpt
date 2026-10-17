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
``record_dispatch_reconciliation`` is the only way to resolve one: it records an
assertion (by an unauthenticated actor) with an evidence reference; it is not
independent verification.

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
RECONCILED_EVENT_TYPE = "mission.dispatch_reconciled"
RECONCILIATION_RESOLUTIONS = frozenset({"effect_occurred", "effect_did_not_occur"})
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
    EFFECT_RECONCILED = "effect_reconciled"
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


def _classify_attempts(history) -> tuple[dict[str, str], list[str]]:
    """Per-attempt outcome from one mission's events, plus contradictions.

    Outcomes: ``response`` (dispatch succeeded), ``no_effect`` (adapter never invoked,
    or reconciled as having had no effect), ``effect_confirmed`` (reconciled as having
    occurred) and ``unresolved`` (started with no finish, or an outcome whose external
    effect cannot be excluded). Malformed attempt ids are kept as unresolved.
    """
    outcomes: dict[str, str] = {}
    anomalies: list[str] = []
    for e in history:
        if e.event_type != _DISPATCH_STARTED:
            continue
        aid = e.payload.get("attempt_id")
        if not isinstance(aid, str) or not aid.strip():
            anomalies.append(f"dispatch {e.event_id} has no valid attempt id")
            outcomes[f"<invalid:{e.event_id}>"] = "unresolved"
        elif aid in outcomes:
            anomalies.append(f"attempt {aid} was started more than once")
        else:
            outcomes[aid] = "unresolved"
    resolved_by_finish: set[str] = set()
    finished_attempts: set[str] = set()
    for e in history:
        if e.event_type != _DISPATCH_FINISHED:
            continue
        aid = e.payload.get("attempt_id")
        if aid not in outcomes or aid.startswith("<invalid:"):
            anomalies.append(f"dispatch finish {e.event_id} has no matching start")
        elif aid in finished_attempts:
            anomalies.append(f"attempt {aid} finished more than once")
        else:
            finished_attempts.add(aid)
            status = e.payload.get("dispatch_status")
            if status == _SUCCESS_STATUS:
                outcomes[aid] = "response"
                resolved_by_finish.add(aid)
            elif status in _NO_EFFECT_STATUSES:
                outcomes[aid] = "no_effect"
                resolved_by_finish.add(aid)
            # any other status keeps the attempt unresolved
    reconciled: set[str] = set()
    for e in history:
        if e.event_type != RECONCILED_EVENT_TYPE:
            continue
        aid = e.payload.get("attempt_id")
        resolution = e.payload.get("resolution")
        if aid not in outcomes:
            anomalies.append(f"reconciliation {e.event_id} has no matching attempt")
        elif aid in resolved_by_finish:
            anomalies.append(f"reconciliation {e.event_id} targets an attempt that was not unresolved")
        elif aid in reconciled:
            anomalies.append(f"attempt {aid} was reconciled more than once")
        elif resolution not in RECONCILIATION_RESOLUTIONS:
            anomalies.append(f"reconciliation {e.event_id} has an invalid resolution")
        else:
            reconciled.add(aid)
            outcomes[aid] = "effect_confirmed" if resolution == "effect_occurred" else "no_effect"
    return outcomes, anomalies


def unresolved_attempt_ids(history, mission_id: str) -> tuple[str, ...]:
    """Attempts of ``mission_id`` whose external effect is not yet resolved (pure)."""
    mine = [e for e in history if e.subject_ref == _subject(mission_id)]
    outcomes, _ = _classify_attempts(mine)
    return tuple(sorted(a for a, o in outcomes.items() if o == "unresolved"))


class ReconciliationRejected(MissionLifecycleError):
    """The reconciliation claim is not admissible for the current history."""


def record_dispatch_reconciliation(
    store: AuditStore, mission_id: str, attempt_id: str, resolution: str, evidence_ref: str,
    *, event_id: str, recorded_at: str, actor: str,
) -> None:
    """Resolve an unresolved attempt with an evidence reference (atomic).

    ``resolution`` is ``effect_occurred`` or ``effect_did_not_occur``. The claim is
    only an assertion by ``actor`` (unauthenticated here) pointing at ``evidence_ref``
    (for example a provider receipt id); it is not independent verification.
    """
    if resolution not in RECONCILIATION_RESOLUTIONS:
        raise ReconciliationRejected("resolution must be effect_occurred or effect_did_not_occur")
    for name, value in (("attempt_id", attempt_id), ("evidence_ref", evidence_ref)):
        if not isinstance(value, str) or not value.strip():
            raise ReconciliationRejected(f"{name} must be a non-empty string")

    def _admissible(history):
        mine = [e for e in history if e.subject_ref == _subject(mission_id)]
        if not _registrations(mine, mission_id):
            return "mission_not_registered"
        outcomes, anomalies = _classify_attempts(mine)
        if anomalies:
            return "mission_lifecycle_inconsistent"
        if attempt_id not in outcomes:
            return "unknown_attempt"
        if outcomes[attempt_id] != "unresolved":
            return "attempt_not_unresolved"
        return None

    try:
        store.append(
            event_id=event_id, event_type=RECONCILED_EVENT_TYPE, recorded_at=recorded_at,
            actor=actor, subject_ref=_subject(mission_id),
            payload={"mission_id": mission_id, "attempt_id": attempt_id,
                     "resolution": resolution, "evidence_ref": evidence_ref},
            precondition=_admissible,
        )
    except AuditPreconditionError as exc:
        raise ReconciliationRejected(str(exc)) from None


def derive_mission_state(store: AuditStore, mission_id: str) -> MissionLifecycleView:
    """Derive the mission state by replaying verified history. Fails closed:
    any contradiction yields INCONSISTENT with the reasons listed."""
    history = [e for e in store.read_all() if e.subject_ref == _subject(mission_id)]
    regs = _registrations(history, mission_id)
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
    for e in history:
        if (e.event_type == _DISPATCH_STARTED and digest is not None
                and e.payload.get("contract_digest") != digest):
            anomalies.append(f"dispatch {e.event_id} used a different contract digest")
    outcomes, attempt_anomalies = _classify_attempts(history)
    anomalies.extend(attempt_anomalies)
    if anomalies:
        return MissionLifecycleView(mission_id, MissionState.INCONSISTENT, digest, tuple(anomalies))

    values = set(outcomes.values())
    if "unresolved" in values:
        state = MissionState.DISPATCH_UNRESOLVED
    elif "response" in values:
        state = MissionState.RESPONSE_RECEIVED
    elif "effect_confirmed" in values:
        state = MissionState.EFFECT_RECONCILED
    elif values:
        state = MissionState.DISPATCH_FAILED_NO_EFFECT
    elif any(e.payload.get("contract_digest") == digest for e in approvals):
        state = MissionState.APPROVED
    else:
        state = MissionState.PLANNED
    return MissionLifecycleView(mission_id, state, digest)


__all__ = [
    "CONTRACT_REGISTERED_EVENT_TYPE", "MissionContractConflict", "MissionLifecycleError",
    "MissionLifecycleView", "MissionState", "RECONCILED_EVENT_TYPE",
    "RECONCILIATION_RESOLUTIONS", "ReconciliationRejected", "RegisteredContract",
    "derive_mission_state", "load_mission_contract", "record_dispatch_reconciliation",
    "register_mission_contract", "unresolved_attempt_ids",
]
