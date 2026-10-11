"""Canonical hash-chained audit events for local, offline Master Brain workflows.

A hash chain detects accidental edits and partial tampering only when a trusted
checkpoint/hash is kept outside the chain. It is not a digital signature, trusted
timestamp, or defense against an attacker who can rewrite the whole ledger.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from hashlib import sha256
import json
from typing import Any, Iterable


GENESIS_HASH = "0" * 64


def _canonical_json(value: Any) -> str:
    try:
        return json.dumps(
            value,
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=False,
            allow_nan=False,
        )
    except (TypeError, ValueError) as exc:
        raise ValueError("audit payload must contain finite, JSON-serializable values") from exc


def _validate_timestamp(value: str) -> None:
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise ValueError("recorded_at must be ISO-8601") from exc
    if parsed.tzinfo is None:
        raise ValueError("recorded_at must include a timezone")


@dataclass(frozen=True)
class AuditEvent:
    event_id: str
    event_type: str
    recorded_at: str
    actor: str
    subject_ref: str
    payload: dict[str, Any]
    previous_hash: str
    event_hash: str

    def __post_init__(self) -> None:
        for field_name in ("event_id", "event_type", "recorded_at", "actor", "subject_ref"):
            value = getattr(self, field_name)
            if not isinstance(value, str):
                raise TypeError(f"{field_name} must be a string")
            if not value.strip():
                raise ValueError(f"{field_name} must not be empty")
        if not isinstance(self.payload, dict):
            raise TypeError("payload must be a dictionary")
        for field_name in ("previous_hash", "event_hash"):
            value = getattr(self, field_name)
            if not isinstance(value, str):
                raise TypeError(f"{field_name} must be a string")
            if len(value) != 64:
                raise ValueError("hashes must be 64-character SHA-256 hex digests")
            try:
                int(value, 16)
            except ValueError as exc:
                raise ValueError("hashes must be hexadecimal") from exc
        _validate_timestamp(self.recorded_at)
        _canonical_json(self.payload)


@dataclass(frozen=True)
class ChainVerification:
    valid: bool
    checked_events: int
    failing_event_id: str = ""
    reason: str = ""


def _event_body(
    event_id: str,
    event_type: str,
    recorded_at: str,
    actor: str,
    subject_ref: str,
    payload: dict[str, Any],
    previous_hash: str,
) -> dict[str, Any]:
    return {
        "actor": actor,
        "event_id": event_id,
        "event_type": event_type,
        "payload": payload,
        "previous_hash": previous_hash,
        "recorded_at": recorded_at,
        "subject_ref": subject_ref,
    }


def compute_event_hash(
    event_id: str,
    event_type: str,
    recorded_at: str,
    actor: str,
    subject_ref: str,
    payload: dict[str, Any],
    previous_hash: str,
) -> str:
    """Compute the digest over all event fields except event_hash itself."""
    body = _event_body(
        event_id, event_type, recorded_at, actor, subject_ref, payload, previous_hash
    )
    return sha256(_canonical_json(body).encode("utf-8")).hexdigest()


def create_event(
    *,
    event_id: str,
    event_type: str,
    recorded_at: str,
    actor: str,
    subject_ref: str,
    payload: dict[str, Any],
    previous_hash: str = GENESIS_HASH,
) -> AuditEvent:
    """Create one immutable event; caller owns durable storage and anchoring."""
    event_hash = compute_event_hash(
        event_id, event_type, recorded_at, actor, subject_ref, payload, previous_hash
    )
    return AuditEvent(
        event_id=event_id,
        event_type=event_type,
        recorded_at=recorded_at,
        actor=actor,
        subject_ref=subject_ref,
        payload=payload,
        previous_hash=previous_hash,
        event_hash=event_hash,
    )


def build_chain(
    events: Iterable[dict[str, Any]],
    *,
    genesis_hash: str = GENESIS_HASH,
) -> tuple[AuditEvent, ...]:
    """Build a hash chain from event dictionaries, preserving input order."""
    previous_hash = genesis_hash
    built: list[AuditEvent] = []
    seen_ids: set[str] = set()
    for raw in events:
        event_id = str(raw.get("event_id", ""))
        if event_id in seen_ids:
            raise ValueError(f"duplicate event_id: {event_id}")
        event = create_event(
            event_id=event_id,
            event_type=str(raw.get("event_type", "")),
            recorded_at=str(raw.get("recorded_at", "")),
            actor=str(raw.get("actor", "")),
            subject_ref=str(raw.get("subject_ref", "")),
            payload=raw.get("payload", {}),
            previous_hash=previous_hash,
        )
        built.append(event)
        seen_ids.add(event.event_id)
        previous_hash = event.event_hash
    return tuple(built)


def verify_chain(
    events: Iterable[AuditEvent],
    *,
    genesis_hash: str = GENESIS_HASH,
) -> ChainVerification:
    """Verify event hashes, link order, and unique IDs; return first failure."""
    previous_hash = genesis_hash
    seen_ids: set[str] = set()
    checked = 0
    for event in events:
        if event.event_id in seen_ids:
            return ChainVerification(False, checked, event.event_id, "duplicate_event_id")
        if event.previous_hash != previous_hash:
            return ChainVerification(False, checked, event.event_id, "previous_hash_mismatch")
        expected = compute_event_hash(
            event.event_id,
            event.event_type,
            event.recorded_at,
            event.actor,
            event.subject_ref,
            event.payload,
            event.previous_hash,
        )
        if event.event_hash != expected:
            return ChainVerification(False, checked, event.event_id, "event_hash_mismatch")
        seen_ids.add(event.event_id)
        previous_hash = event.event_hash
        checked += 1
    return ChainVerification(True, checked)
