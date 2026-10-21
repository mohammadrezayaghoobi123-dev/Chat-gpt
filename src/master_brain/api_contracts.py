"""Versioned API contracts for the first vertical slice (Gate 1, PLAT-001/OPS-001).

Transport-neutral request/response schemas, strict validation, a closed error model
and a mapping from domain outcomes to API errors. No server, no persistence, no
authentication provider: those are open decisions in the platform architecture.

Rules frozen here (documented in docs/MASTER_BRAIN_API_CONTRACT_V1.md):
- Requests are strict: unknown fields are rejected, so a client can never smuggle in
  ``user_id``/``mission_id``/approval flags. Identity comes from the authenticated
  session on the server, never from the body.
- Every state-changing request carries an ``idempotency_key``.
- Responses are server-authoritative. Planning is distinguishable from execution
  (``execution``), and a dispatch response is never presented as independent
  verification (``result_verification``).
- Error ``message`` is a fixed string per code; internal reason text is not echoed.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import datetime
from enum import Enum
from typing import Any, Mapping

from master_brain.mission_approval import approval_required
from master_brain.mission_contract import MissionContract, MissionRiskTier
from master_brain.mission_lifecycle import RECONCILIATION_RESOLUTIONS, MissionLifecycleView, MissionState

API_VERSION = "1"
MAX_TEXT_CHARS = 4000
MAX_LIST_ITEMS = 50
_IDEMPOTENCY_KEY = re.compile(r"^[A-Za-z0-9._:-]{8,128}$")
_DIGEST = re.compile(r"^[0-9a-f]{64}$")
_KEY_ID = re.compile(r"^[A-Za-z0-9._:-]{1,128}$")
_CONTROL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")


class ContractError(ValueError):
    """A request violates the contract; ``path`` names the offending field."""

    def __init__(self, path: str, problem: str) -> None:
        super().__init__(f"{path}: {problem}")
        self.path = path
        self.problem = problem


# ---------------------------------------------------------------- validation helpers
def _object(data: Any, where: str, required: set[str], optional: set[str]) -> Mapping[str, Any]:
    if not isinstance(data, Mapping):
        raise ContractError(where, "must be an object")
    unknown = sorted(str(k) for k in data if k not in required | optional)
    if unknown:
        raise ContractError(where, f"unknown field(s): {', '.join(unknown)}")
    missing = sorted(required - set(data))
    if missing:
        raise ContractError(where, f"missing field(s): {', '.join(missing)}")
    return data


def _text(value: Any, path: str, *, max_chars: int = MAX_TEXT_CHARS) -> str:
    if not isinstance(value, str):
        raise ContractError(path, "must be a string")
    if not value.strip():
        raise ContractError(path, "must not be blank")
    if len(value) > max_chars:
        raise ContractError(path, f"must be at most {max_chars} characters")
    if _CONTROL.search(value):
        raise ContractError(path, "contains control characters")
    return value


def _text_list(value: Any, path: str) -> tuple[str, ...]:
    if not isinstance(value, list):
        raise ContractError(path, "must be an array")
    if len(value) > MAX_LIST_ITEMS:
        raise ContractError(path, f"must have at most {MAX_LIST_ITEMS} items")
    return tuple(_text(item, f"{path}[{i}]") for i, item in enumerate(value))


def _pattern(value: Any, path: str, pattern: re.Pattern[str], what: str) -> str:
    if not isinstance(value, str) or not pattern.match(value):
        raise ContractError(path, f"must be {what}")
    return value


def _aware_timestamp(value: Any, path: str) -> str:
    text = _text(value, path, max_chars=64)
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        raise ContractError(path, "must be an ISO-8601 timestamp") from None
    if parsed.tzinfo is None:
        raise ContractError(path, "must include a UTC offset")
    return text


def _bool(value: Any, path: str) -> bool:
    if type(value) is not bool:
        raise ContractError(path, "must be a boolean")
    return value


# ---------------------------------------------------------------------------- requests
@dataclass(frozen=True)
class CreateMissionRequest:
    idempotency_key: str
    objective: str
    constraints: tuple[str, ...] = ()
    success_criteria: tuple[str, ...] = ()
    risk_tier: str = MissionRiskTier.MEDIUM.value
    requires_approval: bool = False

    @classmethod
    def from_dict(cls, data: Any) -> "CreateMissionRequest":
        d = _object(data, "request",
                    {"idempotency_key", "objective"},
                    {"constraints", "success_criteria", "risk_tier", "requires_approval"})
        tier = d.get("risk_tier", MissionRiskTier.MEDIUM.value)
        if tier not in {t.value for t in MissionRiskTier}:
            raise ContractError("request.risk_tier", "must be one of low, medium, high, critical")
        return cls(
            idempotency_key=_pattern(d["idempotency_key"], "request.idempotency_key",
                                     _IDEMPOTENCY_KEY, "8-128 characters of [A-Za-z0-9._:-]"),
            objective=_text(d["objective"], "request.objective"),
            constraints=_text_list(d.get("constraints", []), "request.constraints"),
            success_criteria=_text_list(d.get("success_criteria", []), "request.success_criteria"),
            risk_tier=tier,
            requires_approval=_bool(d.get("requires_approval", False), "request.requires_approval"),
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "idempotency_key": self.idempotency_key, "objective": self.objective,
            "constraints": list(self.constraints), "success_criteria": list(self.success_criteria),
            "risk_tier": self.risk_tier, "requires_approval": self.requires_approval,
        }


@dataclass(frozen=True)
class ApprovalChallengeRequest:
    """Ask the server for the exact bytes to sign; the approver is the session identity."""

    contract_digest: str
    signing_key_id: str  # the signed message binds the key id and algorithm (SAFE-002)
    signature_alg: str
    action_digest: str | None = None
    expires_at: str | None = None

    @classmethod
    def from_dict(cls, data: Any) -> "ApprovalChallengeRequest":
        d = _object(data, "request", {"contract_digest", "signing_key_id", "signature_alg"},
                    {"action_digest", "expires_at"})
        return cls(
            contract_digest=_pattern(d["contract_digest"], "request.contract_digest",
                                     _DIGEST, "a 64-character lowercase hex SHA-256 digest"),
            signing_key_id=_pattern(d["signing_key_id"], "request.signing_key_id",
                                    _KEY_ID, "1-128 characters of [A-Za-z0-9._:-]"),
            signature_alg=_pattern(d["signature_alg"], "request.signature_alg",
                                   _KEY_ID, "1-128 characters of [A-Za-z0-9._:-]"),
            action_digest=(_pattern(d["action_digest"], "request.action_digest", _DIGEST,
                                    "a 64-character lowercase hex SHA-256 digest")
                           if d.get("action_digest") is not None else None),
            expires_at=(_aware_timestamp(d["expires_at"], "request.expires_at")
                        if d.get("expires_at") is not None else None),
        )


@dataclass(frozen=True)
class SubmitApprovalRequest:
    idempotency_key: str
    approval_event_id: str
    signing_key_id: str
    signature_alg: str
    signature_hex: str

    @classmethod
    def from_dict(cls, data: Any) -> "SubmitApprovalRequest":
        d = _object(data, "request",
                    {"idempotency_key", "approval_event_id", "signing_key_id",
                     "signature_alg", "signature_hex"}, set())
        sig = d["signature_hex"]
        if (not isinstance(sig, str) or not 2 <= len(sig) <= 1024 or len(sig) % 2
                or not re.fullmatch(r"[0-9a-f]+", sig)):
            raise ContractError("request.signature_hex", "must be lowercase hex of even length (<= 1024)")
        return cls(
            idempotency_key=_pattern(d["idempotency_key"], "request.idempotency_key",
                                     _IDEMPOTENCY_KEY, "8-128 characters of [A-Za-z0-9._:-]"),
            approval_event_id=_pattern(d["approval_event_id"], "request.approval_event_id",
                                       _KEY_ID, "1-128 characters of [A-Za-z0-9._:-]"),
            signing_key_id=_pattern(d["signing_key_id"], "request.signing_key_id",
                                    _KEY_ID, "1-128 characters of [A-Za-z0-9._:-]"),
            signature_alg=_pattern(d["signature_alg"], "request.signature_alg",
                                   _KEY_ID, "1-128 characters of [A-Za-z0-9._:-]"),
            signature_hex=sig,
        )


_TASK_ID = re.compile(r"^[a-z0-9][a-z0-9._-]{0,63}$")


@dataclass(frozen=True)
class ExecuteMissionRequest:
    """Run one operator-defined task for a mission. No adapter/payload/identity in the body."""

    idempotency_key: str
    task_id: str

    @classmethod
    def from_dict(cls, data: Any) -> "ExecuteMissionRequest":
        d = _object(data, "request", {"idempotency_key", "task_id"}, set())
        return cls(
            idempotency_key=_pattern(d["idempotency_key"], "request.idempotency_key",
                                     _IDEMPOTENCY_KEY, "8-128 characters of [A-Za-z0-9._:-]"),
            task_id=_pattern(d["task_id"], "request.task_id", _TASK_ID,
                             "1-64 characters of [a-z0-9._-] starting with a letter or digit"),
        )


MAX_EVIDENCE_REF_CHARS = 500


@dataclass(frozen=True)
class ReconcileRequest:
    """Operator claim about an unresolved attempt. The claim is an assertion, not verification."""

    idempotency_key: str
    attempt_id: str
    resolution: str
    evidence_ref: str

    @classmethod
    def from_dict(cls, data: Any) -> "ReconcileRequest":
        d = _object(data, "request", {"idempotency_key", "attempt_id", "resolution", "evidence_ref"}, set())
        if d["resolution"] not in RECONCILIATION_RESOLUTIONS:
            raise ContractError("request.resolution", "must be effect_occurred or effect_did_not_occur")
        return cls(
            idempotency_key=_pattern(d["idempotency_key"], "request.idempotency_key",
                                     _IDEMPOTENCY_KEY, "8-128 characters of [A-Za-z0-9._:-]"),
            attempt_id=_pattern(d["attempt_id"], "request.attempt_id", _KEY_ID,
                                "1-128 characters of [A-Za-z0-9._:-]"),
            resolution=d["resolution"],
            evidence_ref=_text(d["evidence_ref"], "request.evidence_ref", max_chars=MAX_EVIDENCE_REF_CHARS),
        )


# --------------------------------------------------------------------------- responses
class ApprovalStatus(str, Enum):
    NOT_REQUIRED = "not_required"
    REQUIRED = "required"
    GRANTED = "granted"


class ExecutionPhase(str, Enum):
    NOT_STARTED = "not_started"
    STARTED = "started"
    UNKNOWN = "unknown"


_EXECUTION_BY_STATE = {
    MissionState.UNREGISTERED: ExecutionPhase.NOT_STARTED,
    MissionState.PLANNED: ExecutionPhase.NOT_STARTED,
    MissionState.APPROVED: ExecutionPhase.NOT_STARTED,
    MissionState.DISPATCH_UNRESOLVED: ExecutionPhase.STARTED,
    MissionState.RESPONSE_RECEIVED: ExecutionPhase.STARTED,
    MissionState.EFFECT_RECONCILED: ExecutionPhase.STARTED,
    MissionState.DISPATCH_FAILED_NO_EFFECT: ExecutionPhase.STARTED,
    MissionState.INCONSISTENT: ExecutionPhase.UNKNOWN,
}
RESULT_NOT_VERIFIED = "not_independently_verified"


@dataclass(frozen=True)
class MissionView:
    mission_id: str
    objective: str
    contract_schema_version: str
    risk_tier: str
    state: str
    contract_digest: str | None
    execution: str
    approval_required: bool
    approval_status: str
    selected_islands: tuple[str, ...]
    clarification_questions: tuple[str, ...]
    anomalies: tuple[str, ...]
    result_verification: str = RESULT_NOT_VERIFIED

    def to_dict(self) -> dict[str, Any]:
        return {
            "api_version": API_VERSION, "mission_id": self.mission_id, "objective": self.objective,
            "contract_schema_version": self.contract_schema_version, "risk_tier": self.risk_tier,
            "state": self.state, "contract_digest": self.contract_digest,
            "execution": self.execution, "approval_required": self.approval_required,
            "approval_status": self.approval_status,
            "selected_islands": list(self.selected_islands),
            "clarification_questions": list(self.clarification_questions),
            "anomalies": list(self.anomalies), "result_verification": self.result_verification,
        }


def mission_view_from_domain(
    contract: MissionContract, lifecycle: MissionLifecycleView, *, approval_status: ApprovalStatus,
) -> MissionView:
    """Server-side projection. ``approval_status`` must come from the verified audit gate."""
    if lifecycle.mission_id != contract.mission_id:
        raise ValueError("lifecycle view belongs to a different mission")
    required = approval_required(contract)
    if required != (approval_status is not ApprovalStatus.NOT_REQUIRED):
        raise ValueError("approval_status disagrees with whether the contract requires approval")
    return MissionView(
        mission_id=contract.mission_id, objective=contract.objective,
        contract_schema_version=contract.schema_version, risk_tier=contract.risk_tier.value,
        state=lifecycle.state.value, contract_digest=lifecycle.contract_digest,
        execution=_EXECUTION_BY_STATE[lifecycle.state].value,
        approval_required=required, approval_status=approval_status.value,
        selected_islands=contract.selected_islands,
        clarification_questions=contract.clarification_questions,
        anomalies=tuple(lifecycle.anomalies),
    )


@dataclass(frozen=True)
class TaskView:
    task_id: str
    description: str
    action_digest: str
    risk_level: int
    limitations: tuple[str, ...]

    def to_dict(self) -> dict[str, Any]:
        return {"task_id": self.task_id, "description": self.description,
                "action_digest": self.action_digest, "risk_level": self.risk_level,
                "limitations": list(self.limitations)}


@dataclass(frozen=True)
class AttemptView:
    """One dispatch attempt. Free-text reasons are deliberately not exposed (they may carry
    adapter-internal detail); ``dispatch_status`` is a closed set."""

    attempt_id: str
    integration_id: str
    dispatch_status: str  # unresolved | one of DispatchStatus values
    external_effect_confirmed: bool
    output: Mapping[str, Any] | None
    output_digest: str | None
    reconciliation: str | None  # effect_occurred | effect_did_not_occur | None
    limitations: tuple[str, ...]

    def to_dict(self) -> dict[str, Any]:
        return {
            "attempt_id": self.attempt_id, "integration_id": self.integration_id,
            "dispatch_status": self.dispatch_status,
            "external_effect_confirmed": self.external_effect_confirmed,
            "output": None if self.output is None else dict(self.output),
            "output_digest": self.output_digest, "reconciliation": self.reconciliation,
            "limitations": list(self.limitations),
        }


RESULT_NOTES = (
    "A dispatch response is not independent verification of the result.",
    "An external effect is confirmed only by reconciliation with evidence, never by the response.",
)


@dataclass(frozen=True)
class ResultView:
    mission_id: str
    state: str
    execution: str
    attempts: tuple[AttemptView, ...]
    result_verification: str = RESULT_NOT_VERIFIED
    notes: tuple[str, ...] = RESULT_NOTES

    def to_dict(self) -> dict[str, Any]:
        return {
            "api_version": API_VERSION, "mission_id": self.mission_id, "state": self.state,
            "execution": self.execution, "attempts": [a.to_dict() for a in self.attempts],
            "result_verification": self.result_verification, "notes": list(self.notes),
        }


@dataclass(frozen=True)
class ApprovalChallenge:
    mission_id: str
    contract_digest: str
    approval_event_id: str
    expires_at: str
    action_digest: str | None
    signing_message_hex: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "api_version": API_VERSION, "mission_id": self.mission_id,
            "contract_digest": self.contract_digest, "approval_event_id": self.approval_event_id,
            "expires_at": self.expires_at,
            "action_digest": self.action_digest, "signing_message_hex": self.signing_message_hex,
        }


# AuditEventView deliberately has NO payload: audit detail is role-gated later, and the
# default view must not expose more than is needed.
@dataclass(frozen=True)
class AuditEventView:
    event_id: str
    event_type: str
    recorded_at: str
    actor: str
    event_hash: str

    def to_dict(self) -> dict[str, Any]:
        return {"event_id": self.event_id, "event_type": self.event_type,
                "recorded_at": self.recorded_at, "actor": self.actor,
                "event_hash": self.event_hash}


def audit_event_view(event: Any) -> AuditEventView:
    return AuditEventView(event.event_id, event.event_type, event.recorded_at,
                          event.actor, event.event_hash)


# ------------------------------------------------------------------------------ errors
class ErrorCode(str, Enum):
    INVALID_REQUEST = "invalid_request"
    UNAUTHENTICATED = "unauthenticated"
    FORBIDDEN = "forbidden"
    NOT_FOUND = "not_found"
    CONFLICT = "conflict"
    STALE_CONTRACT = "stale_contract"
    APPROVAL_REQUIRED = "approval_required"
    APPROVAL_INVALID = "approval_invalid"
    CLARIFICATION_REQUIRED = "clarification_required"
    RECONCILIATION_REQUIRED = "reconciliation_required"
    DUPLICATE_REQUEST = "duplicate_request"
    DISPATCH_FAILED = "dispatch_failed"
    UNAVAILABLE = "unavailable"
    OUTCOME_UNKNOWN = "outcome_unknown"
    RATE_LIMITED = "rate_limited"


# code -> (HTTP status for a future transport, fixed client-safe message)
ERROR_TABLE: dict[ErrorCode, tuple[int, str]] = {
    ErrorCode.INVALID_REQUEST: (400, "The request is not valid."),
    ErrorCode.UNAUTHENTICATED: (401, "Authentication is required."),
    ErrorCode.FORBIDDEN: (403, "This action is not permitted."),
    ErrorCode.NOT_FOUND: (404, "The mission was not found."),
    ErrorCode.CONFLICT: (409, "The request conflicts with the current mission state."),
    ErrorCode.STALE_CONTRACT: (409, "The mission contract changed; review it again."),
    ErrorCode.APPROVAL_REQUIRED: (403, "A valid approval is required."),
    ErrorCode.APPROVAL_INVALID: (403, "The approval is invalid, expired or already used."),
    ErrorCode.CLARIFICATION_REQUIRED: (422, "The mission needs clarification before it can proceed."),
    ErrorCode.RECONCILIATION_REQUIRED: (409, "An earlier attempt has an unresolved outcome."),
    ErrorCode.DUPLICATE_REQUEST: (409, "This request was already processed."),
    ErrorCode.DISPATCH_FAILED: (502, "The action could not be dispatched."),
    ErrorCode.UNAVAILABLE: (503, "The service is temporarily unavailable; nothing was executed."),
    ErrorCode.OUTCOME_UNKNOWN: (500, "The outcome is unknown; do not retry blindly."),
    ErrorCode.RATE_LIMITED: (429, "Too many requests; nothing was executed. Wait and try again."),
}
_RETRYABLE = {ErrorCode.UNAVAILABLE, ErrorCode.RATE_LIMITED}


@dataclass(frozen=True)
class ErrorResponse:
    code: ErrorCode
    correlation_id: str

    @property
    def http_status(self) -> int:
        return ERROR_TABLE[self.code][0]

    @property
    def message(self) -> str:
        return ERROR_TABLE[self.code][1]

    @property
    def retryable(self) -> bool:
        return self.code in _RETRYABLE

    def to_dict(self) -> dict[str, Any]:
        return {"api_version": API_VERSION, "error": {
            "code": self.code.value, "message": self.message,
            "retryable": self.retryable, "correlation_id": self.correlation_id}}


def error_response(code: ErrorCode, correlation_id: str) -> ErrorResponse:
    if not isinstance(correlation_id, str) or not correlation_id.strip():
        raise ValueError("correlation_id must be a non-empty string")
    return ErrorResponse(code, correlation_id)


# Execution statuses the domain can return (guarded by a test that parses the source).
_STATUS_TO_CODE: dict[str, ErrorCode | None] = {
    "response_received": None,  # success: not an error
    "audit_unavailable": ErrorCode.UNAVAILABLE,
    "registry_unavailable": ErrorCode.UNAVAILABLE,
    "execution_registry_incomplete": ErrorCode.OUTCOME_UNKNOWN,
    "executed_audit_incomplete": ErrorCode.OUTCOME_UNKNOWN,
    "outcome_unknown": ErrorCode.OUTCOME_UNKNOWN,
    "dispatch_failed": ErrorCode.DISPATCH_FAILED,
    "idempotency_conflict": ErrorCode.CONFLICT,
    "duplicate_existing_execution": ErrorCode.DUPLICATE_REQUEST,
    "duplicate_intent": ErrorCode.DUPLICATE_REQUEST,
    "rejected": ErrorCode.FORBIDDEN,  # refined by reason below
}
EXECUTION_STATUSES = frozenset(_STATUS_TO_CODE)

# Ordered (substring, code) rules for ``rejected`` reasons; first match wins; default FORBIDDEN.
_REJECTED_RULES: tuple[tuple[str, ErrorCode], ...] = (
    ("contract_not_registered", ErrorCode.NOT_FOUND),
    ("registered_contract_mismatch", ErrorCode.STALE_CONTRACT),
    ("mission contract changed after approval", ErrorCode.STALE_CONTRACT),
    ("mission_dispatch_unresolved_requires_reconciliation", ErrorCode.RECONCILIATION_REQUIRED),
    ("mission_lifecycle_unavailable", ErrorCode.UNAVAILABLE),
    ("verified audit history is unavailable", ErrorCode.UNAVAILABLE),
    ("mission_lifecycle_inconsistent", ErrorCode.CONFLICT),
    ("requires clarification", ErrorCode.CLARIFICATION_REQUIRED),
    # Server not configured to authenticate approvers: nothing ran, and retrying will not help.
    ("a configured approval verifier", ErrorCode.FORBIDDEN),
    ("require an approval bound to the exact action", ErrorCode.APPROVAL_REQUIRED),
    ("require an approval with an expiry", ErrorCode.APPROVAL_REQUIRED),
    ("differs from the approved action", ErrorCode.APPROVAL_INVALID),
    ("receipt is missing", ErrorCode.APPROVAL_REQUIRED),
    # Everything else about approval (consumed, expired, bad signature, wrong mission...):
    ("approval", ErrorCode.APPROVAL_INVALID),
)


def error_from_execution_result(result: Any, correlation_id: str) -> ErrorResponse | None:
    """Map a domain MissionExecutionResult to an API error, or None for success.

    Fail closed: an unknown status is reported as OUTCOME_UNKNOWN, never as success."""
    status = getattr(result, "status", None)
    if status not in _STATUS_TO_CODE:
        return error_response(ErrorCode.OUTCOME_UNKNOWN, correlation_id)
    code = _STATUS_TO_CODE[status]
    if status == "rejected":
        reason = str(getattr(result, "reason", ""))
        code = next((c for needle, c in _REJECTED_RULES if needle in reason), ErrorCode.FORBIDDEN)
    return None if code is None else error_response(code, correlation_id)


__all__ = [
    "API_VERSION", "ApprovalChallenge", "ApprovalChallengeRequest", "ApprovalStatus",
    "AttemptView", "AuditEventView", "ContractError", "CreateMissionRequest", "ExecuteMissionRequest",
    "MAX_EVIDENCE_REF_CHARS", "RECONCILIATION_RESOLUTIONS", "ReconcileRequest",
    "RESULT_NOTES", "ResultView", "TaskView", "ERROR_TABLE", "EXECUTION_STATUSES",
    "ErrorCode", "ErrorResponse", "ExecutionPhase", "MissionView", "RESULT_NOT_VERIFIED",
    "SubmitApprovalRequest", "audit_event_view", "error_from_execution_result",
    "error_response", "mission_view_from_domain",
]
