"""Append-only JSONL persistence for Master Brain audit events.

Appends are serialized with an exclusive advisory file lock on a sidecar
``<path>.lock`` file, so concurrent writers (threads or processes on the same
host) cannot fork the hash chain. The lock is advisory and local: it does not
protect against non-cooperating writers or network filesystems without lock
support. Hashes detect changes in stored history, but cannot detect a complete
rewrite unless a checkpoint is retained elsewhere.
"""
from __future__ import annotations

from contextlib import contextmanager
from dataclasses import asdict
import json
import os
from pathlib import Path
from typing import Any

from master_brain.audit_ledger import GENESIS_HASH, AuditEvent, create_event, verify_chain


class AuditStoreError(RuntimeError):
    """Raised when the audit store cannot safely be read or extended."""


class AuditStore:
    """Fail-closed, single-writer JSONL audit store; never auto-repairs history."""

    def __init__(self, path: str | os.PathLike[str]) -> None:
        self.path = Path(path)

    @staticmethod
    def _decode(line: str, number: int) -> AuditEvent:
        try:
            raw = json.loads(line)
            if not isinstance(raw, dict):
                raise TypeError("audit record must be a JSON object")
            return AuditEvent(
                event_id=raw["event_id"],
                event_type=raw["event_type"],
                recorded_at=raw["recorded_at"],
                actor=raw["actor"],
                subject_ref=raw["subject_ref"],
                payload=raw["payload"],
                previous_hash=raw["previous_hash"],
                event_hash=raw["event_hash"],
            )
        except (ValueError, TypeError, KeyError, json.JSONDecodeError) as exc:
            raise AuditStoreError(f"invalid audit record at line {number}") from exc

    def read_all(self) -> tuple[AuditEvent, ...]:
        if not self.path.exists():
            return ()
        events: list[AuditEvent] = []
        try:
            with self.path.open("r", encoding="utf-8") as handle:
                for number, line in enumerate(handle, start=1):
                    if not line.strip():
                        raise AuditStoreError(f"blank audit record at line {number}")
                    events.append(self._decode(line, number))
        except UnicodeDecodeError as exc:
            raise AuditStoreError("audit store is not valid UTF-8") from exc
        check = verify_chain(events)
        if not check.valid:
            raise AuditStoreError(
                f"audit chain verification failed at {check.failing_event_id}: {check.reason}"
            )
        return tuple(events)

    @contextmanager
    def _exclusive_lock(self):
        """Hold an exclusive cross-process lock for one read-modify-append cycle."""
        self.path.parent.mkdir(parents=True, exist_ok=True)
        lock_path = self.path.with_name(self.path.name + ".lock")
        try:
            handle = lock_path.open("a+b")
        except OSError as exc:
            raise AuditStoreError("failed to open audit store lock") from exc
        try:
            try:
                if os.name == "nt":
                    import msvcrt
                    handle.seek(0)
                    msvcrt.locking(handle.fileno(), msvcrt.LK_LOCK, 1)
                else:
                    import fcntl
                    fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
            except OSError as exc:
                raise AuditStoreError("failed to acquire audit store lock") from exc
            yield
        finally:
            handle.close()  # closing releases the lock

    def append(
        self, *, event_id: str, event_type: str, recorded_at: str, actor: str,
        subject_ref: str, payload: dict[str, Any],
    ) -> AuditEvent:
        with self._exclusive_lock():
            return self._append_locked(
                event_id=event_id, event_type=event_type, recorded_at=recorded_at,
                actor=actor, subject_ref=subject_ref, payload=payload,
            )

    def _append_locked(
        self, *, event_id: str, event_type: str, recorded_at: str, actor: str,
        subject_ref: str, payload: dict[str, Any],
    ) -> AuditEvent:
        history = self.read_all()
        if any(item.event_id == event_id for item in history):
            raise AuditStoreError(f"duplicate event_id: {event_id}")
        previous = history[-1].event_hash if history else GENESIS_HASH
        event = create_event(
            event_id=event_id, event_type=event_type, recorded_at=recorded_at,
            actor=actor, subject_ref=subject_ref, payload=payload,
            previous_hash=previous,
        )
        row = json.dumps(
            asdict(event), sort_keys=True, separators=(",", ":"),
            ensure_ascii=False, allow_nan=False,
        )
        self.path.parent.mkdir(parents=True, exist_ok=True)
        try:
            with self.path.open("a", encoding="utf-8", newline="") as handle:
                handle.write(row + "\n")
                handle.flush()
                os.fsync(handle.fileno())
        except (OSError, ValueError) as exc:
            raise AuditStoreError("failed to append audit event") from exc
        return event
