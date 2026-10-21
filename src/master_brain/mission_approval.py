"""Version-bound mission approvals backed by the append-only audit store.

This module records an upstream-authenticated approval assertion; it does not
perform identity authentication itself and must not be treated as an auth
provider. Every approval is bound to the canonical digest of one exact mission
contract version. A changed contract invalidates the approval.
"""
from __future__ import annotations

from dataclasses import asdict, dataclass
from datetime import datetime, timedelta
from enum import Enum
import hashlib
import json
from typing import Any

from master_brain.approval_signing import (
    ApprovalSigner, ApprovalVerifier, SIGNATURE_FIELDS, attach_external_signature,
    build_signing_message, sign_approval_payload, verify_approval_event,
)
from master_brain.audit_store import NOW, AuditStore, AuditStoreError
from master_brain.mission_contract import (
    MissionContract,
    MissionReviewLevel,
    MissionRiskTier,
)


APPROVAL_EVENT_TYPE = "mission.approval_granted"
APPROVAL_SCHEMA_VERSION = 1
# Upper bound on how long one approval may stay valid, measured from the store clock
# at approval time. A far-future expiry would defeat the purpose of expiring.
MAX_APPROVAL_LIFETIME_SECONDS = 7 * 24 * 3600


def _high_risk(contract: MissionContract) -> bool:
    return contract.risk_tier in {MissionRiskTier.HIGH, MissionRiskTier.CRITICAL}


def _parse_expiry(value: Any) -> datetime | None:
    """Parse a timezone-aware ISO-8601 instant; None if absent/naive/malformed."""
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        at = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
    except ValueError:
        return None
    return at if at.tzinfo is not None else None


def _approval_required(contract: MissionContract) -> bool:
    """Derive the safety requirement independently of the stored boolean flag."""
    return (
        contract.requires_approval
        or contract.review_level is MissionReviewLevel.HUMAN_GATED
        or contract.risk_tier in {MissionRiskTier.HIGH, MissionRiskTier.CRITICAL}
    )


def approval_required(contract: MissionContract) -> bool:
    """Public, single definition of "this mission needs human approval" (API layer uses it)."""
    return _approval_required(contract)


def _json_value(value: Any) -> Any:
    if isinstance(value, Enum):
        return value.value
    if isinstance(value, dict):
        return {str(key): _json_value(item) for key, item in value.items()}
    if isinstance(value, (tuple, list)):
        return [_json_value(item) for item in value]
    return value


def _contract_integrity_error(contract: MissionContract) -> str | None:
    """Re-run dataclass validation at trust boundaries; reject bypassed invariants."""
    if not isinstance(contract, MissionContract):
        return "mission contract has an invalid type"
    try:
        # Reconstructing invokes MissionContract.__post_init__ again. This is
        # defense in depth against malformed/deserialized objects or mutation
        # through low-level Python APIs; it is not a cryptographic guarantee.
        MissionContract(**asdict(contract))
    except (TypeError, ValueError, AttributeError) as exc:
        return f"mission contract failed integrity validation: {exc}"
    return None


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


def action_digest(integration_id: str, payload: Any) -> str:
    """Return SHA-256 of the canonical (integration_id, payload) pair.

    Lets an approval cover the concrete external action, not only the contract.
    Raises TypeError/ValueError if the payload is not canonical-JSON compatible.
    """
    if not isinstance(integration_id, str) or not integration_id.strip():
        raise ValueError("integration_id must be a non-empty string")
    canonical = json.dumps(
        {"integration_id": integration_id, "payload": _json_value(payload)},
        sort_keys=True, ensure_ascii=False, separators=(",", ":"), allow_nan=False,
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
    # Optional action binding. None means the approval covers the contract only
    # (legacy scope): any integration/payload is then permitted under it.
    action_digest: str | None = None
    # Optional validity bound (ISO-8601 with timezone). Mandatory for HIGH/CRITICAL.
    expires_at: str | None = None
    # Optional signature (SAFE-002). Present only for approvals recorded with a signer.
    signature: str | None = None
    signing_key_id: str | None = None
    signature_alg: str | None = None


@dataclass(frozen=True)
class ApprovedExecutionGateResult:
    """Policy result only; it never dispatches or executes a mission."""

    allowed: bool
    reasons: tuple[str, ...]
    # True only if a verifier confirmed a valid signature by a key bound to the approver.
    approver_authenticated: bool = False


def _prepare_approval(
    store: AuditStore, contract: MissionContract, *, event_id: str, approver_subject: str,
    authentication_method: str, action_digest: str | None, expires_at: str | None,
) -> tuple[str, dict[str, Any]]:
    """Validate approval inputs and build the (unsigned) audited payload."""
    integrity_error = _contract_integrity_error(contract)
    if integrity_error:
        raise ValueError(integrity_error)
    for name, value in (
        ("event_id", event_id),
        ("approver_subject", approver_subject),
        ("authentication_method", authentication_method),
    ):
        if not isinstance(value, str) or not value.strip():
            raise ValueError(f"{name} must be a non-empty string")
    if not _approval_required(contract):
        raise ValueError("mission contract does not require human approval")
    if action_digest is not None and (
        not isinstance(action_digest, str) or not action_digest.strip()
    ):
        raise ValueError("action_digest must be a non-empty string when supplied")

    if expires_at is None:
        if _high_risk(contract):
            raise ValueError("high/critical-risk approvals require an expires_at")
    else:
        expiry = _parse_expiry(expires_at)
        if expiry is None:
            raise ValueError("expires_at must be a timezone-aware ISO-8601 timestamp")
        now = store.now()
        if expiry <= now:
            raise ValueError("expires_at is not in the future")
        if expiry - now > timedelta(seconds=MAX_APPROVAL_LIFETIME_SECONDS):
            raise ValueError("expires_at exceeds the maximum approval lifetime")

    digest = mission_contract_digest(contract)
    payload: dict[str, Any] = {
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
    if action_digest is not None:
        payload["scope"] = "exact_contract_digest_and_action"
        payload["action_digest"] = action_digest
    if expires_at is not None:
        payload["expires_at"] = expires_at
    return digest, payload


def approval_signing_message(
    store: AuditStore, contract: MissionContract, *, event_id: str, approver_subject: str,
    authentication_method: str, signing_key_id: str, signature_alg: str,
    action_digest: str | None = None, expires_at: str | None = None,
) -> bytes:
    """Exact bytes an approver must sign for ``record_mission_approval(signature=...)``.

    Applies the same validation as recording, so an unsignable/invalid approval is
    refused before the approver is asked to sign it."""
    for name, value in (("signing_key_id", signing_key_id), ("signature_alg", signature_alg)):
        if not isinstance(value, str) or not value.strip():
            raise ValueError(f"{name} must be a non-empty string")
    _, payload = _prepare_approval(
        store, contract, event_id=event_id, approver_subject=approver_subject,
        authentication_method=authentication_method, action_digest=action_digest,
        expires_at=expires_at,
    )
    payload = {**payload, "signing_key_id": signing_key_id, "signature_alg": signature_alg}
    return build_signing_message(event_id, payload)


def record_mission_approval(
    store: AuditStore,
    contract: MissionContract,
    *,
    event_id: str,
    recorded_at: str,
    approver_subject: str,
    authentication_method: str,
    action_digest: str | None = None,
    expires_at: str | None = None,
    signer: ApprovalSigner | None = None,
    signature: bytes | None = None,
    signing_key_id: str | None = None,
    signature_alg: str | None = None,
) -> MissionApprovalReceipt:
    """Persist an approval assertion bound to the exact contract digest.

    The caller MUST authenticate the approver before invoking this function.
    The supplied subject/method are recorded assertions, not verified identity.
    Signed approvals: pass ``signer`` (signed here) OR a ``signature`` produced
    elsewhere over ``approval_signing_message`` with its ``signing_key_id`` and
    ``signature_alg`` (never both). Recording does not verify the signature; the
    execution gate does, using a configured verifier.
    If audit persistence fails, no receipt is returned.
    """
    if recorded_at is not NOW and (not isinstance(recorded_at, str) or not recorded_at.strip()):
        raise ValueError("recorded_at must be a non-empty string")
    if signer is not None and signature is not None:
        raise ValueError("pass either signer or signature, not both")
    digest, payload = _prepare_approval(
        store, contract, event_id=event_id, approver_subject=approver_subject,
        authentication_method=authentication_method, action_digest=action_digest,
        expires_at=expires_at,
    )
    if signer is not None:
        # Raises (before anything is written) if the signer is unusable.
        payload = sign_approval_payload(signer, event_id, payload)
    elif signature is not None:
        payload = attach_external_signature(payload, signing_key_id, signature_alg, signature)
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
        action_digest=action_digest,
        expires_at=expires_at,
        signature=payload.get("signature"),
        signing_key_id=payload.get("signing_key_id"),
        signature_alg=payload.get("signature_alg"),
    )


def evaluate_approved_execution_gate(
    contract: MissionContract,
    store: AuditStore,
    receipt: MissionApprovalReceipt | None,
    action_digest: str | None = None,
    verifier: ApprovalVerifier | None = None,
) -> ApprovedExecutionGateResult:
    """Fail closed unless a matching approval is present in verified audit history.

    With a ``verifier`` the approval must also carry a valid signature by a key bound
    to the approver (``approver_authenticated``). HIGH/CRITICAL missions REQUIRE a
    verifier (SAFE-002): without one they are refused. Lower tiers without a verifier
    keep the legacy behaviour (approver identity is an unauthenticated assertion).

    If the receipt carries an action binding, the caller's ``action_digest`` (see
    ``action_digest()``) must be supplied and equal it; otherwise the approval
    only covers the contract.
    """
    reasons: list[str] = []
    integrity_error = _contract_integrity_error(contract)
    if integrity_error:
        return ApprovedExecutionGateResult(False, (integrity_error,))
    if not contract.objective.strip():
        reasons.append("mission objective is empty and requires clarification")
    if contract.clarification_questions:
        reasons.append("mission requires clarification before dispatch")
    if not _approval_required(contract):
        return ApprovedExecutionGateResult(not reasons, tuple(reasons))
    if receipt is None:
        reasons.append("required human approval receipt is missing")
        return ApprovedExecutionGateResult(False, tuple(reasons))
    if not isinstance(receipt, MissionApprovalReceipt):
        reasons.append("approval receipt has an invalid type")
        return ApprovedExecutionGateResult(False, tuple(reasons))

    for name, value in (
        ("event_id", receipt.event_id),
        ("mission_id", receipt.mission_id),
        ("contract_digest", receipt.contract_digest),
        ("contract_schema_version", receipt.contract_schema_version),
        ("approver_subject", receipt.approver_subject),
        ("authentication_method", receipt.authentication_method),
        ("recorded_at", receipt.recorded_at),
        ("event_hash", receipt.event_hash),
    ):
        if not isinstance(value, str):
            reasons.append(f"approval receipt field {name} must be a string")
    if receipt.action_digest is not None and not isinstance(receipt.action_digest, str):
        reasons.append("approval receipt field action_digest must be a string")
    if receipt.expires_at is not None and not isinstance(receipt.expires_at, str):
        reasons.append("approval receipt field expires_at must be a string")
    if reasons:
        return ApprovedExecutionGateResult(False, tuple(reasons))
    if _high_risk(contract) and verifier is None:
        reasons.append(
            "high/critical-risk missions require a configured approval verifier "
            "(authenticated approver)"
        )
    if receipt.action_digest is None and contract.risk_tier in {
        MissionRiskTier.HIGH, MissionRiskTier.CRITICAL,
    }:
        reasons.append(
            "high/critical-risk missions require an approval bound to the exact action"
        )
    if receipt.expires_at is None:
        if _high_risk(contract):
            reasons.append("high/critical-risk missions require an approval with an expiry")
    else:
        expiry = _parse_expiry(receipt.expires_at)
        if expiry is None:
            reasons.append("approval expiry is malformed")
        else:
            try:
                now = store.now()
                expired = now >= expiry
            except Exception:  # no trusted clock or incomparable value: fail closed
                reasons.append("approval expiry cannot be evaluated (no usable clock)")
            else:
                if expired:
                    reasons.append("approval has expired")
    if receipt.action_digest is not None:
        if action_digest is None:
            reasons.append("approval is bound to a specific action but no action digest was supplied")
        elif action_digest != receipt.action_digest:
            reasons.append("action (integration or payload) differs from the approved action")

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
        if receipt.action_digest is not None:
            expected_payload["scope"] = "exact_contract_digest_and_action"
            expected_payload["action_digest"] = receipt.action_digest
        if receipt.expires_at is not None:
            expected_payload["expires_at"] = receipt.expires_at
        for field, value in (("signature", receipt.signature),
                             ("signing_key_id", receipt.signing_key_id),
                             ("signature_alg", receipt.signature_alg)):
            if value is not None:
                expected_payload[field] = value
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
        if verifier is not None:
            signature_reason = verify_approval_event(verifier, event)
            if signature_reason:
                reasons.append(signature_reason)

    return ApprovedExecutionGateResult(
        not reasons, tuple(reasons),
        approver_authenticated=verifier is not None and not reasons,
    )


__all__ = [
    "APPROVAL_EVENT_TYPE",
    "action_digest",
    "approval_required",
    "approval_signing_message",
    "ApprovedExecutionGateResult",
    "MissionApprovalReceipt",
    "evaluate_approved_execution_gate",
    "MAX_APPROVAL_LIFETIME_SECONDS",
    "mission_contract_digest",
    "record_mission_approval",
]
