"""Tamper-evident security log (Gate 2c-4, SAFE-002, OPS-001): who signed in, who was refused, who changed
which account — kept in its OWN hash-chained log, apart from the mission audit.

Design decisions (each has a test):

* Same engine as the mission audit (``AuditStore``): hash chain, head anchor, lock, no backdating,
  key allow-list and secret screening. Passwords, tokens and cookies can never be written.
* **Fail closed for what grants power**: a sign-in or an account change whose event cannot be written
  is refused (the event is written BEFORE the effect). A crash in between leaves an event for a change
  that did not apply — over-reporting, the safe direction for an audit.
* **Best effort for what only records refusals** (failed sign-ins, throttling): these can be produced by
  anyone, so they are capped per window; the excess is counted and summarised in one
  ``security.events_suppressed`` event instead of letting an attacker fill the disk or slow the log.
* Attacker-chosen text is never stored raw: an attempted account name is kept only if it is a valid
  subject, otherwise recorded as ``invalid``.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import threading
import time
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any, Callable

from master_brain.audit_store import NOW, AuditStore
from master_brain.identity import KNOWN_ROLES

LOGIN_SUCCEEDED = "security.login_succeeded"
LOGIN_FAILED = "security.login_failed"
LOGIN_THROTTLED = "security.login_throttled"
LOGOUT = "security.logout"
ACCOUNT_CHANGED = "security.account_changed"
EVENTS_SUPPRESSED = "security.events_suppressed"

ACCOUNT_CHANGES = frozenset({"created", "roles_set", "disabled", "enabled", "password_changed"})
THROTTLE_SCOPES = frozenset({"address", "account"})
FAILURE_REASONS = frozenset({"bad_credentials"})
_SUBJECT = re.compile(r"[A-Za-z0-9._:@-]{1,128}")
_ADDRESS = re.compile(r"[0-9A-Fa-f:.%a-zA-Z-]{1,64}")


class SecurityLogError(RuntimeError):
    """The security log could not be written (callers treat this as 'refuse')."""


def attempted_subject_ref(subject: object) -> str:
    """``account:<subject>`` for a syntactically valid subject, else ``account:invalid`` (never raw text)."""
    if isinstance(subject, str) and _SUBJECT.fullmatch(subject):
        return f"account:{subject}"
    return "account:invalid"


def clean_address(address: object) -> str:
    return address if isinstance(address, str) and _ADDRESS.fullmatch(address) else "unknown"


def _validate(event_type: str, payload: dict[str, Any]) -> None:
    """The vocabulary is CLOSED: a value outside it is a bug (or an attempt), never something to store."""
    address = payload.get("address")
    if address is not None and not (isinstance(address, str) and _ADDRESS.fullmatch(address)):
        raise SecurityLogError("invalid address")
    if event_type == ACCOUNT_CHANGED:
        roles = payload.get("roles")
        if payload.get("change") not in ACCOUNT_CHANGES or not (
                roles is None or (isinstance(roles, list) and all(r in KNOWN_ROLES for r in roles))):
            raise SecurityLogError("invalid account change")
    elif event_type == LOGIN_THROTTLED and payload.get("scope") not in THROTTLE_SCOPES:
        raise SecurityLogError("invalid throttle scope")
    elif event_type == LOGIN_FAILED and payload.get("reason") not in FAILURE_REASONS:
        raise SecurityLogError("invalid failure reason")


class SecurityLog:
    def __init__(self, path: str | Path, *, clock: Callable[[], datetime] | None = None,
                 monotonic: Callable[[], float] = time.monotonic, window_seconds: float = 60.0,
                 max_best_effort_per_window: int = 60) -> None:
        if not (window_seconds > 0 and max_best_effort_per_window >= 1):
            raise ValueError("window_seconds must be > 0 and max_best_effort_per_window >= 1")
        self.store = AuditStore(path, clock=clock)
        self.path = self.store.path
        self._monotonic = monotonic
        self._window = float(window_seconds)
        self._cap = int(max_best_effort_per_window)
        self._lock = threading.Lock()
        self._window_start = monotonic()
        self._used = 0
        self._suppressed = 0

    # -------------------------------------------------------------- writing
    def critical(self, event_type: str, *, actor: str, subject_ref: str, payload: dict[str, Any]) -> None:
        """Write or raise ``SecurityLogError``; never suppressed."""
        try:
            _validate(event_type, payload)
            self.store.append(event_id="sec-" + uuid.uuid4().hex, event_type=event_type, recorded_at=NOW,
                              actor=actor, subject_ref=subject_ref, payload=payload)
        except Exception as exc:
            raise SecurityLogError("security log unavailable") from exc

    def best_effort(self, event_type: str, *, actor: str, subject_ref: str, payload: dict[str, Any]) -> bool:
        """Write unless over the per-window cap or the log is unavailable; never raises. True = written."""
        with self._lock:
            now = self._monotonic()
            if now - self._window_start >= self._window or now < self._window_start:
                carried, self._suppressed = self._suppressed, 0
                self._window_start, self._used = now, 0
                if carried:
                    self._write_quietly(EVENTS_SUPPRESSED, "system:security-log", "log:security",
                                        {"count": carried, "window_seconds": int(self._window)})
            if self._used >= self._cap:
                self._suppressed += 1
                return False
            self._used += 1
        return self._write_quietly(event_type, actor, subject_ref, payload)

    def _write_quietly(self, event_type: str, actor: str, subject_ref: str, payload: dict[str, Any]) -> bool:
        try:
            self.critical(event_type, actor=actor, subject_ref=subject_ref, payload=payload)
            return True
        except SecurityLogError:
            return False

    # -------------------------------------------------------------- reading
    def read_all(self):
        return self.store.read_all()


def _positive(text: str) -> int:
    value = int(text)
    if value < 1:
        raise argparse.ArgumentTypeError("must be >= 1")
    return value


def _main(argv: list[str] | None = None) -> int:
    """Operator tool: verify the hash chain/anchor, or print the newest events (only if the log verifies)."""
    parser = argparse.ArgumentParser(prog="python -m master_brain.security_log",
                                     description="Verify or read the Master Brain security log.")
    parser.add_argument("--path", required=True, help="path of the security log (JSONL)")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("verify", help="check the hash chain and head anchor; exit 1 if anything is wrong")
    tail = sub.add_parser("tail", help="print the newest events (after verifying the whole log)")
    tail.add_argument("--count", type=_positive, default=20)
    args = parser.parse_args(argv)
    path = Path(args.path)
    if not path.is_file():
        print("error: no such log", file=sys.stderr)
        return 1
    try:
        events = AuditStore(path).read_all()  # verifies chain + anchor; raises on any inconsistency
    except Exception as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    if args.command == "verify":
        print(f"ok: {len(events)} events, head {events[-1].event_hash if events else '-'}")
        return 0
    for e in events[-args.count:]:
        print(f"{e.recorded_at} {e.event_type} {e.actor} {e.subject_ref} "
              f"{json.dumps(dict(e.payload), sort_keys=True, ensure_ascii=True)}")
    return 0


if __name__ == "__main__":
    sys.exit(_main())

__all__ = ["ACCOUNT_CHANGED", "ACCOUNT_CHANGES", "EVENTS_SUPPRESSED", "FAILURE_REASONS", "LOGIN_FAILED",
           "LOGIN_SUCCEEDED", "LOGIN_THROTTLED", "LOGOUT", "SecurityLog", "SecurityLogError",
           "THROTTLE_SCOPES", "attempted_subject_ref", "clean_address"]
