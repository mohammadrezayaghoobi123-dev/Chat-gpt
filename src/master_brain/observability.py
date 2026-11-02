"""Optional Langfuse tracing with privacy-conscious defaults.

Tracing is disabled unless both project API keys are configured and the optional
SDK is installed. Instrumentation failures must not change mission outcomes.
"""
from __future__ import annotations

import os
from contextlib import contextmanager
from typing import Any, Iterator, Mapping


class _SafeObservation:
    """Keep telemetry update failures from breaking application execution."""

    def __init__(self, observation: Any) -> None:
        self._observation = observation

    def update(self, **kwargs: Any) -> None:
        try:
            self._observation.update(**kwargs)
        except Exception:
            # Observability is best-effort; business logic remains authoritative.
            return


@contextmanager
def observation(
    *,
    name: str,
    as_type: str,
    input_data: Mapping[str, Any],
    metadata: Mapping[str, Any] | None = None,
) -> Iterator[_SafeObservation | None]:
    """Start a nested Langfuse observation when explicitly configured.

    Raw mission objectives, prompts, evidence text, and executor outputs are
    deliberately excluded by callers. Missing configuration/SDK is a no-op.
    """
    if not (os.getenv("LANGFUSE_PUBLIC_KEY") and os.getenv("LANGFUSE_SECRET_KEY")):
        yield None
        return

    try:
        from langfuse import get_client
        manager = get_client().start_as_current_observation(as_type=as_type, name=name)
        raw_observation = manager.__enter__()
    except Exception:
        # Includes missing SDK, invalid configuration, and span-start failures.
        yield None
        return

    safe_observation = _SafeObservation(raw_observation)
    safe_observation.update(input=dict(input_data), metadata=dict(metadata or {}))
    try:
        yield safe_observation
    except BaseException as exc:
        safe_observation.update(level="ERROR", status_message=type(exc).__name__)
        try:
            manager.__exit__(type(exc), exc, exc.__traceback__)
        except Exception:
            pass
        raise
    else:
        try:
            manager.__exit__(None, None, None)
        except Exception:
            # Export/close failures must not change a successful mission result.
            pass
