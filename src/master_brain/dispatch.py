"""Fail-closed, single-attempt dispatch boundary for injected integration adapters.

This module does not resolve credentials, create network clients, or provide
production identity/authorization. Callers must supply an adapter only after
their own trust and authorization checks have passed.
"""
from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
import json
import math
import threading
from typing import Any, Mapping, Protocol

from master_brain.integrations import (
    IntegrationDescriptor,
    IntegrationRequirement,
    assess_integration,
)


class DispatchStatus(str, Enum):
    SUCCEEDED = "succeeded"
    REJECTED = "rejected"
    ADAPTER_MISSING = "adapter_missing"
    ADAPTER_ERROR = "adapter_error"
    INVALID_OUTPUT = "invalid_output"
    TIMEOUT = "timeout"


@dataclass(frozen=True)
class DispatchResult:
    status: DispatchStatus
    integration_id: str
    output: Mapping[str, Any] | None = None
    reason: str = ""

    @property
    def successful(self) -> bool:
        return self.status is DispatchStatus.SUCCEEDED


class IntegrationAdapter(Protocol):
    def invoke(self, payload: Mapping[str, Any]) -> Mapping[str, Any]: ...


def _is_json_object(value: Any) -> bool:
    if not isinstance(value, Mapping):
        return False
    try:
        json.dumps(dict(value), allow_nan=False)
    except (TypeError, ValueError, OverflowError):
        return False
    return True


class _AdapterTimeout(Exception):
    """Internal: adapter did not return within the caller's wait budget."""


def _invoke_with_timeout(adapter: IntegrationAdapter, payload: Mapping[str, Any], timeout: float):
    box: dict[str, Any] = {}

    def run() -> None:
        try:
            box["output"] = adapter.invoke(payload)
        except BaseException as exc:  # re-raised in the caller's thread
            box["error"] = exc

    worker = threading.Thread(target=run, name="dispatch-adapter", daemon=True)
    worker.start()
    worker.join(timeout)
    if worker.is_alive():
        raise _AdapterTimeout
    if "error" in box:
        raise box["error"]
    return box["output"]


def dispatch_once(
    integration: IntegrationDescriptor,
    requirement: IntegrationRequirement,
    adapter: IntegrationAdapter | None,
    payload: Mapping[str, Any],
    *,
    timeout_seconds: float | None = None,
) -> DispatchResult:
    """Validate, assess, and invoke an eligible injected adapter at most once.

    ``timeout_seconds`` (default None = wait indefinitely, the legacy behavior)
    bounds how long the caller waits. A TIMEOUT result means the OUTCOME IS
    UNKNOWN, not that the adapter failed: Python cannot cancel the adapter
    thread, which may still finish and cause an external effect later. Its late
    return value is discarded. Callers must treat TIMEOUT like an adapter
    exception after the side-effect boundary (never retry blindly).

    Rejected inputs/candidates are never invoked. Exceptions are represented
    by type only to avoid copying potentially sensitive exception messages.
    A successful adapter return is not proof that a remote side effect was
    durably completed; provider-specific receipts remain the adapter's duty.
    """
    if not isinstance(integration, IntegrationDescriptor):
        return DispatchResult(DispatchStatus.REJECTED, "unknown", reason="integration_descriptor_invalid")
    if not isinstance(requirement, IntegrationRequirement):
        return DispatchResult(DispatchStatus.REJECTED, integration.integration_id, reason="integration_requirement_invalid")
    if not _is_json_object(payload):
        return DispatchResult(
            DispatchStatus.INVALID_OUTPUT,
            integration.integration_id,
            reason="input_not_json_compatible_object",
        )

    assessment = assess_integration(integration, requirement)
    if not assessment.eligible:
        return DispatchResult(
            DispatchStatus.REJECTED,
            integration.integration_id,
            reason="; ".join(assessment.reasons),
        )

    if timeout_seconds is not None and (
        isinstance(timeout_seconds, bool)
        or not isinstance(timeout_seconds, (int, float))
        or not math.isfinite(timeout_seconds)
        or timeout_seconds <= 0
    ):
        return DispatchResult(
            DispatchStatus.REJECTED, integration.integration_id,
            reason="timeout_seconds_must_be_positive_finite_number",
        )

    if adapter is None or not callable(getattr(adapter, "invoke", None)):
        return DispatchResult(
            DispatchStatus.ADAPTER_MISSING,
            integration.integration_id,
            reason="adapter_missing_or_invalid",
        )

    # Input preparation happens strictly BEFORE the adapter is invoked, outside the
    # try that covers invoke(): only here may a TypeError/ValueError mean "bad input".
    try:
        # JSON round-trip creates a detached copy, including nested containers.
        safe_payload = json.loads(json.dumps(dict(payload), allow_nan=False))
    except (TypeError, ValueError, OverflowError):
        return DispatchResult(
            DispatchStatus.INVALID_OUTPUT,
            integration.integration_id,
            reason="input_not_json_compatible_object",
        )

    # From here on the adapter may already have caused an external effect, so EVERY
    # exception it raises (including TypeError/ValueError/JSON/Unicode/Overflow
    # errors from its own response parsing) is an adapter error: outcome unknown.
    try:
        if timeout_seconds is None:
            output = adapter.invoke(safe_payload)
        else:
            output = _invoke_with_timeout(adapter, safe_payload, timeout_seconds)
    except _AdapterTimeout:
        return DispatchResult(
            DispatchStatus.TIMEOUT, integration.integration_id,
            reason="adapter_timeout_outcome_unknown",
        )
    except Exception as exc:
        return DispatchResult(
            DispatchStatus.ADAPTER_ERROR,
            integration.integration_id,
            reason=type(exc).__name__,
        )

    if not _is_json_object(output):
        return DispatchResult(
            DispatchStatus.INVALID_OUTPUT,
            integration.integration_id,
            reason="output_not_json_compatible_object",
        )

    try:
        # Detach the returned result from adapter-owned nested containers too.
        safe_output = json.loads(json.dumps(dict(output), allow_nan=False))
    except (TypeError, ValueError, OverflowError):
        return DispatchResult(
            DispatchStatus.INVALID_OUTPUT,
            integration.integration_id,
            reason="output_not_json_compatible_object",
        )

    return DispatchResult(
        DispatchStatus.SUCCEEDED,
        integration.integration_id,
        output=safe_output,
    )
