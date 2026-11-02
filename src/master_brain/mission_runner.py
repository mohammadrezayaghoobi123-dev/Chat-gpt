"""A minimal deterministic mission runner for integration contract tests.

This runner coordinates only an injected handler. It does not call providers,
enforce network timeouts, persist audit events, or grant permissions. Those
remain responsibilities of the production dispatch boundary.
"""
from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from typing import Any, Callable, Mapping


class MissionStatus(str, Enum):
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    INVALID_RESULT = "invalid_result"


@dataclass(frozen=True)
class MissionResult:
    mission_id: str
    status: MissionStatus
    result: Mapping[str, Any] | None = None
    error_code: str | None = None


def run_mission(
    mission_id: str,
    payload: Mapping[str, Any],
    handler: Callable[[Mapping[str, Any]], Mapping[str, Any]],
) -> MissionResult:
    """Run an injected handler once and distinguish failures from success."""
    if not isinstance(mission_id, str) or not mission_id.strip():
        raise ValueError("mission_id must be a non-empty string")
    if not isinstance(payload, Mapping):
        raise TypeError("payload must be a mapping")
    import json
    try:
        # JSON round-trip validates the contract and isolates nested input values.
        safe_payload = json.loads(json.dumps(dict(payload), allow_nan=False))
    except (TypeError, ValueError, OverflowError):
        return MissionResult(mission_id, MissionStatus.INVALID_RESULT,
                             error_code="payload_not_json_compatible")
    try:
        result = handler(safe_payload)
    except Exception as exc:
        # Return exception type only; exception messages can leak secrets.
        return MissionResult(mission_id, MissionStatus.FAILED,
                             error_code=type(exc).__name__)
    if not isinstance(result, Mapping):
        return MissionResult(mission_id, MissionStatus.INVALID_RESULT,
                             error_code="result_not_mapping")
    try:
        # Detach returned nested data from handler-owned containers.
        safe_result = json.loads(json.dumps(dict(result), allow_nan=False))
    except (TypeError, ValueError, OverflowError):
        return MissionResult(mission_id, MissionStatus.INVALID_RESULT,
                             error_code="result_not_json_compatible")
    return MissionResult(mission_id, MissionStatus.SUCCEEDED, result=safe_result)
