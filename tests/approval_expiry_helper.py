"""Shared helper: an approval expiry safely inside the allowed window."""
from datetime import datetime, timedelta, timezone


def soon(hours: float = 1.0) -> str:
    """ISO-8601 UTC timestamp ``hours`` from now (real clock)."""
    return (datetime.now(timezone.utc) + timedelta(hours=hours)).isoformat().replace("+00:00", "Z")
