"""Validated, stable, secret-conscious audit records for Master Brain.

This module serializes audit metadata only; callers are responsible for passing
references and summaries rather than raw user inputs or model outputs.
"""
from __future__ import annotations

from copy import deepcopy
from dataclasses import asdict, dataclass, field
from datetime import datetime
import json
import re
from typing import Any, Mapping


class AuditValidationError(ValueError):
    """Raised when an audit record is incomplete or unsafe to serialize."""


_SENSITIVE_KEY_PARTS = (
    "api_key",
    "apikey",
    "secret",
    "password",
    "authorization",
    "credential",
    "private_key",
    "privatekey",
    "access_token",
    "refresh_token",
)


def _check_sensitive_keys(value: Any, path: str = "metadata", _active: set[int] | None = None) -> None:
    if _active is None:
        _active = set()
    if not isinstance(value, (Mapping, list, tuple)):
        return
    identity = id(value)
    if identity in _active:
        raise AuditValidationError(f"cyclic metadata is not allowed: {path}")
    _active.add(identity)
    try:
        if isinstance(value, Mapping):
            for key, child in value.items():
                if not isinstance(key, str):
                    raise AuditValidationError(f"{path} keys must be strings")
                normalized = re.sub(r"[^a-z0-9]", "", key.lower())
                sensitive_parts = (re.sub(r"[^a-z0-9]", "", part) for part in _SENSITIVE_KEY_PARTS)
                if any(part in normalized for part in sensitive_parts):
                    raise AuditValidationError(
                        f"sensitive field name is not allowed in audit metadata: {path}.{key}"
                    )
                _check_sensitive_keys(child, f"{path}.{key}", _active)
        else:
            for index, child in enumerate(value):
                _check_sensitive_keys(child, f"{path}[{index}]", _active)
    finally:
        _active.remove(identity)

def _require_text(name: str, value: str) -> None:
    if not isinstance(value, str) or not value.strip():
        raise AuditValidationError(f"{name} must be a non-empty string")


@dataclass(frozen=True)
class AuditRecord:
    """Small, versionable audit event without raw prompts or secrets by default."""

    event_id: str
    event_type: str
    occurred_at: str
    component: str
    status: str
    input_refs: tuple[str, ...] = ()
    output_refs: tuple[str, ...] = ()
    metadata: Mapping[str, Any] = field(default_factory=dict)
    schema_version: int = 1

    def __post_init__(self) -> None:
        """Defensively copy nested metadata and validate at construction."""
        object.__setattr__(self, "metadata", deepcopy(self.metadata))
        self.validate()

    def validate(self) -> None:
        for name in ("event_id", "event_type", "occurred_at", "component", "status"):
            _require_text(name, getattr(self, name))

        if type(self.schema_version) is not int or self.schema_version != 1:
            raise AuditValidationError("unsupported audit schema_version")

        try:
            parsed = datetime.fromisoformat(
                self.occurred_at[:-1] + "+00:00"
                if self.occurred_at.endswith("Z")
                else self.occurred_at
            )
        except (TypeError, ValueError) as exc:
            raise AuditValidationError("occurred_at must be ISO-8601 with timezone") from exc
        if parsed.tzinfo is None or parsed.utcoffset() is None:
            raise AuditValidationError("occurred_at must include a timezone")

        for name in ("input_refs", "output_refs"):
            refs = getattr(self, name)
            if not isinstance(refs, (tuple, list)):
                raise AuditValidationError(f"{name} must be a tuple or list of strings")
            if any(not isinstance(ref, str) or not ref.strip() for ref in refs):
                raise AuditValidationError(f"{name} entries must be non-empty strings")

        if not isinstance(self.metadata, Mapping):
            raise AuditValidationError("metadata must be a mapping")
        _check_sensitive_keys(self.metadata)

        try:
            json.dumps(self.metadata, allow_nan=False)
        except (TypeError, ValueError) as exc:
            raise AuditValidationError("metadata must contain finite JSON-compatible values") from exc

    def to_dict(self) -> dict[str, Any]:
        """Return a validated JSON-compatible dictionary."""
        self.validate()
        result = asdict(self)
        result["input_refs"] = list(self.input_refs)
        result["output_refs"] = list(self.output_refs)
        result["metadata"] = deepcopy(dict(self.metadata))
        return result

    def to_stable_json(self) -> str:
        """Serialize deterministically for diffing, hashing, and audit storage."""
        return json.dumps(
            self.to_dict(),
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=False,
            allow_nan=False,
        )
