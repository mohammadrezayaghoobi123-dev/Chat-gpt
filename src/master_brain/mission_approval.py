"""Version-bound mission approvals backed by the append-only audit store.

This module records an upstream-authenticated approval assertion; it does not
perform identity authentication itself and must not be treated as an auth
provider. Every approval is bound to the canonical digest of one exact mission
contract version. A changed contract invalidates the approval.
"""
from __future__ import annotations

from dataclasses import asdict, dataclass
from enum import Enum
import hashlib
import json
from typing import Any

from master_brain.audit_store import AuditStore, AuditStoreError
from master_brain.mission_contract import MissionContract


APPROVAL_EVENT_TYPE = "mission.approval_granted"
APPROVAL_SCHEMA_VERSION = 1


def _json_value(value: Any) -> Any:
    if isinstance(value, Enum):
        return value.value
    if isinstance(value, dict):
        return {str(key): _json_value(item) for key, item in value.items()}
    if isinstance(value, (tuple, list)):
        return [_json_value(item) for item in value]
    return value


def mission_contract_digest(contract: MissionContract) -> str:
    """Return SHA-256 of the canonical, complete mission contract."""
    canonical = json.dumps(
        _json_value(asdict(contract)),
        sort_keys=True,
        ensure_ascii=False,
        separators=(",", ":"),
        allow_nan=False,
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


@dataclass(frozen=True)
class MissionApprovalReceipt:
    """Receipt for an approval event; not an independently signed credential."""

    event_id: str
    mission_id: str
    contract_digest: str
    contract_schema_version: str
    approver_subject: str
    authentication_method: str
    recorded_at: str
    event_hash: str


@dataclass(frozen=True)
class ApprovedExecutionGateResult:
    """Policy result only; it never dispatches or executes a mission."""

    allowed: bool
    reasons: tuple[str, ...]


def record_mission_approval(
    store: AuditStore,
    contract: MissionContract,
    *,
    event_id: str,
    recorded_at: str,
    approver_subject: str,
    authentication_method: str,
) -> MissionApprovalReceipt:
    """Persist an approval assertion bound to the exact contract digest.

    The caller MUST authenticate the approver before invoking this function.
    The supplied subject/method are recorded assertions, not verified identity.
    If audit persistence fails, no receipt is returned.
    """
    for name, value in (
        ("event_id", event_id),
        ("recorded_at", recorded_at),
        ("approver_subject", approver_subject),
        ("authentication_method", authentication_method),
    ):
        if not isinstance(value, str) or not value.strip():
            raise ValueError(f"{name} must be a non-empty string")
    if not contract.requires_approval:
        raise ValueError("mission contract does not require human approval")

    digest = mission_contract_digest(contract)
    payload = {
        "approval_schema_version": APPROVAL_SCHEMA_VERSION,
        "decision": "approved",
        "mission_id": contract.mission_id,
        "contract_schema_version": contract.schema_version,
        "contract_digest": digest,
        "approver_subject": approver_subject,
        "authentication_method": authentication_method,
        "scope": "exact_contract_digest",
        "identity_verified_by_this_module": False,
    }
    event = store.append(
        event_id=event_id,
        event_type=APPROVAL_EVENT_TYPE,
        recorded_at=recorded_at,
        actor=approver_subject,
        subject_ref=f"mission:{contract.mission_id}",
        payload=payload,
    )
    return MissionApprovalReceipt(
        event_id=event.event_id,
        mission_id=contract.mission_id,
        contract_digest=digest,
        contract_schema_version=contract.schema_version,
        approver_subject=approver_subject,
        authentication_method=authentication_method,
        recorded_at=event.recorded_at,
        event_hash=event.event_hash,
    )


def evaluate_approved_execution_gate(
    contract: MissionContract,
    store: AuditStore,
    receipt: MissionApprovalReceipt | None,
) -> ApprovedExecutionGateResult:
    """Fail closed unless a matching approval is present in verified audit history."""
    reasons: list[str] = []
    if not contract.objective.strip():
        reasons.append("mission objective is empty and requires clarification")
    if contract.clarification_questions:
        reasons.append("mission requires clarification before dispatch")
    if not contract.requires_approval:
        return ApprovedExecutionGateResult(not reasons, tuple(reasons))
    if receipt is None:
        reasons.append("required human approval receipt is missing")
        return ApprovedExecutionGateResult(False, tuple(reasons))

    current_digest = mission_contract_digest(contract)
    if receipt.mission_id != contract.mission_id:
        reasons.append("approval receipt belongs to a different mission")
    if receipt.contract_schema_version != contract.schema_version:
        reasons.append("approval receipt uses a different contract schema version")
    if receipt.contract_digest != current_digest:
        reasons.append("mission contract changed after approval")
    if not receipt.approver_subject.strip() or not receipt.authentication_method.strip():
        reasons.append("approval receipt has incomplete approver metadata")

    try:
        history = store.read_all()
    except AuditStoreError:
        reasons.append("verified audit history is unavailable or invalid")
        return ApprovedExecutionGateResult(False, tuple(reasons))

    matching = [event for event in history if event.event_id == receipt.event_id]
    if len(matching) != 1:
        reasons.append("approval event is missing or duplicated in audit history")
    else:
        event = matching[0]
        expected_payload = {
            "approval_schema_version": APPROVAL_SCHEMA_VERSION,
            "decision": "approved",
            "mission_id": contract.mission_id,
            "contract_schema_version": contract.schema_version,
            "contract_digest": current_digest,
            "approver_subject": receipt.approver_subject,
            "authentication_method": receipt.authentication_method,
            "scope": "exact_contract_digest",
            "identity_verified_by_this_module": False,
        }
        if event.event_type != APPROVAL_EVENT_TYPE:
            reasons.append("receipt does not reference a mission approval event")
        if event.subject_ref != f"mission:{contract.mission_id}":
            reasons.append("approval event subject does not match this mission")
        if event.actor != receipt.approver_subject:
            reasons.append("approval event actor does not match receipt")
        if event.recorded_at != receipt.recorded_at:
            reasons.append("approval event timestamp does not match receipt")
        if event.event_hash != receipt.event_hash:
            reasons.append("approval event hash does not match receipt")
        if event.payload != expected_payload:
            reasons.append("approval event payload does not match this contract and receipt")

    return ApprovedExecutionGateResult(not reasons, tuple(reasons))


__all__ = [
    "APPROVAL_EVENT_TYPE",
    "ApprovedExecutionGateResult",
    "MissionApprovalReceipt",
    "evaluate_approved_execution_gate",
    "mission_contract_digest",
    "record_mission_approval",
]
