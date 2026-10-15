"""Pre-persistence policy for audit payloads: key allow-list + secret screening.

Two layers, applied by ``AuditStore.append`` before anything is written:

1. **Allow-list (strong).** Event types emitted by production code are registered
   in ``PAYLOAD_KEY_ALLOWLIST`` with the exact top-level keys they may carry. An
   unknown top-level key on a registered type is rejected, so a new field (or a
   smuggled credential) cannot reach the audit log without a reviewed change here.
2. **Secret screening (defence in depth, all event types).** Sensitive key names
   and high-precision credential value patterns are rejected anywhere in the
   payload, including nested values and registered free-text fields.

Limits: layer 2 is a deny-list. It cannot recognise unknown credential formats or
low-entropy passwords inside free text of an allowed field; that residual risk is
why ``AuditStore`` rejects unregistered event types by default
(``strict_event_types=True``); new event types must be registered here after review.
Opt out (``False``) only for tests of generic store mechanics.
"""
from __future__ import annotations

import re
import unicodedata
from typing import Any, Mapping

PAYLOAD_KEY_ALLOWLIST: dict[str, frozenset[str]] = {
    "mission.approval_granted": frozenset({
        "approval_schema_version", "decision", "mission_id", "contract_schema_version",
        "contract_digest", "approver_subject", "authentication_method", "scope",
        "identity_verified_by_this_module", "action_digest",
    }),
    "mission.dispatch_started": frozenset({
        "mission_id", "contract_digest", "integration_id", "attempt_id", "approval_event_id",
    }),
    "mission.dispatch_finished": frozenset({
        "mission_id", "integration_id", "attempt_id", "dispatch_status", "reason",
        "external_effect_confirmed",
    }),
    "falsification.reviewed": frozenset({
        "schema_version", "outcome_mapping_version", "claim_id", "mission_context", "status",
        "previous_decision", "decision_changed", "decision_change_reason", "truth_established",
        "evidence_assessment", "tests", "rival_hypothesis_ids", "disconfirmation_criteria",
        "counterexample_evidence_ids", "evidence_records", "reasons",
    }),
}

_SENSITIVE_KEY_PARTS = (
    "apikey", "secret", "password", "passwd", "authorization", "credential",
    "privatekey", "accesstoken", "refreshtoken", "bearer", "cookie", "sessiontoken",
)
_SENSITIVE_KEY_EXACT = frozenset({"token", "auth", "pwd", "pass", "sessionid", "jwt"})

_SECRET_VALUE_PATTERNS = (
    ("private key block", re.compile(r"-----BEGIN [A-Z0-9 ]*PRIVATE KEY")),
    ("bearer token", re.compile(r"\bBearer\s+[A-Za-z0-9._~+/=-]{16,}", re.IGNORECASE)),
    ("sk- api key", re.compile(r"\bsk-[A-Za-z0-9_-]{16,}")),
    ("github token", re.compile(r"\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{20,})")),
    ("aws access key id", re.compile(r"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b")),
    ("slack token", re.compile(r"\bxox[abprs]-[A-Za-z0-9-]{10,}")),
    ("google api key", re.compile(r"\bAIza[0-9A-Za-z_-]{35}")),
    ("jwt", re.compile(r"\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}")),
    ("url credentials", re.compile(r"://[^/\s:@]+:[^/\s@]+@")),
)

_MAX_DEPTH = 40


class AuditPayloadRejected(ValueError):
    """Raised when a payload violates the audit allow-list or contains a secret."""


def _norm_key(key: str) -> str:
    return re.sub(r"[^a-z0-9]", "", unicodedata.normalize("NFKC", key).casefold())


def _check_text(text: str, where: str) -> None:
    flat = unicodedata.normalize("NFKC", text)
    for label, pattern in _SECRET_VALUE_PATTERNS:
        if pattern.search(flat):
            raise AuditPayloadRejected(f"payload contains a probable {label} at {where}")


def _walk(value: Any, where: str, depth: int, active: set[int]) -> None:
    if depth > _MAX_DEPTH:
        raise AuditPayloadRejected(f"payload nesting too deep at {where}")
    if isinstance(value, str):
        _check_text(value, where)
        return
    if isinstance(value, (Mapping, list, tuple)):
        ident = id(value)
        if ident in active:
            raise AuditPayloadRejected(f"cyclic payload at {where}")
        active.add(ident)
        try:
            if isinstance(value, Mapping):
                for key, child in value.items():
                    if not isinstance(key, str):
                        raise AuditPayloadRejected(f"payload keys must be strings at {where}")
                    norm = _norm_key(key)
                    if norm in _SENSITIVE_KEY_EXACT or any(p in norm for p in _SENSITIVE_KEY_PARTS):
                        raise AuditPayloadRejected(f"sensitive field name not allowed: {where}.{key}")
                    _check_text(key, f"{where}.<key>")
                    _walk(child, f"{where}.{key}", depth + 1, active)
            else:
                for index, child in enumerate(value):
                    _walk(child, f"{where}[{index}]", depth + 1, active)
        finally:
            active.discard(ident)


def enforce_payload_policy(
    event_type: str, payload: Any, *, strict_event_types: bool = True
) -> None:
    """Raise AuditPayloadRejected unless the payload may be persisted."""
    if not isinstance(payload, Mapping):
        raise AuditPayloadRejected("payload must be a mapping")
    allowed = PAYLOAD_KEY_ALLOWLIST.get(event_type)
    if allowed is None:
        if strict_event_types:
            raise AuditPayloadRejected(f"event type is not registered: {event_type}")
    else:
        unknown = sorted(str(k) for k in payload if k not in allowed)
        if unknown:
            raise AuditPayloadRejected(
                f"payload keys not in allow-list for {event_type}: {', '.join(unknown)}"
            )
    _walk(payload, "payload", 0, set())
