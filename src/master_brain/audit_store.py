"""Append-only JSONL persistence for Master Brain audit events.

Appends are serialized with an exclusive advisory file lock on a sidecar
``<path>.lock`` file, so concurrent writers (threads or processes on the same
host) cannot fork the hash chain. The lock is advisory and local: it does not
protect against non-cooperating writers or network filesystems without lock
support. Hashes detect changes in stored history, but cannot detect a complete
rewrite unless a checkpoint is retained elsewhere.

A head anchor sidecar ``<path>.head`` records ``{count, head_hash}`` after every
append. ``read_all`` fails closed if the log is shorter than the anchor or the
event at ``count`` no longer has ``head_hash`` (tail truncation / rollback).
Limits: the anchor sits beside the log, so an attacker who rewrites BOTH files
consistently, or deletes the anchor of a non-empty log (treated as a legacy log
and re-anchored on the next append), is not detected. Defeating that needs an
anchor held elsewhere (external copy or signature), which is a key-custody decision.
"""
from __future__ import annotations

from contextlib import contextmanager
from dataclasses import asdict
import json
import os
from pathlib import Path
from typing import Any, Callable

from master_brain.audit_ledger import GENESIS_HASH, AuditEvent, create_event, verify_chain


class AuditStoreError(RuntimeError):
    """Raised when the audit store cannot safely be read or extended."""


class AuditPreconditionError(AuditStoreError):
    """Raised when an append's precondition rejects the current verified history."""


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
                    if not line.endswith("\n"):
                        raise AuditStoreError(f"unterminated audit record at line {number}")
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
        self._verify_anchor(events)
        return tuple(events)

    @property
    def anchor_path(self) -> Path:
        return self.path.with_name(self.path.name + ".head")

    def _verify_anchor(self, events: list[AuditEvent]) -> None:
        anchor = self.anchor_path
        if not anchor.exists():
            return  # legacy / never-anchored log; anchored on next append
        try:
            raw = json.loads(anchor.read_text(encoding="utf-8"))
            count, head = raw["count"], raw["head_hash"]
            if isinstance(count, bool) or not isinstance(count, int) or count < 0 \
                    or not isinstance(head, str):
                raise TypeError("bad anchor fields")
        except (OSError, ValueError, TypeError, KeyError) as exc:
            raise AuditStoreError("audit head anchor is unreadable") from exc
        if len(events) < count:
            raise AuditStoreError(
                f"audit log truncated: anchor records {count} events, found {len(events)}"
            )
        actual = events[count - 1].event_hash if count else GENESIS_HASH
        if actual != head:
            raise AuditStoreError("audit log does not match its head anchor")

    def _write_anchor(self, events_count: int, head_hash: str) -> None:
        tmp = self.anchor_path.with_name(self.anchor_path.name + ".tmp")
        try:
            with tmp.open("w", encoding="utf-8", newline="") as handle:
                handle.write(json.dumps({"count": events_count, "head_hash": head_hash},
                                        sort_keys=True, separators=(",", ":")))
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(tmp, self.anchor_path)
        except OSError as exc:
            raise AuditStoreError("failed to write audit head anchor") from exc

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
        precondition: Callable[[tuple[AuditEvent, ...]], str | None] | None = None,
    ) -> AuditEvent:
        """Append one event. ``precondition`` is evaluated on the verified history
        while the exclusive lock is held (atomic check-and-append); a returned
        string rejects the append with AuditPreconditionError."""
        with self._exclusive_lock():
            return self._append_locked(
                event_id=event_id, event_type=event_type, recorded_at=recorded_at,
                actor=actor, subject_ref=subject_ref, payload=payload,
                precondition=precondition,
            )

    def _append_locked(
        self, *, event_id: str, event_type: str, recorded_at: str, actor: str,
        subject_ref: str, payload: dict[str, Any],
        precondition: Callable[[tuple[AuditEvent, ...]], str | None] | None = None,
    ) -> AuditEvent:
        history = self.read_all()
        if precondition is not None:
            reason = precondition(history)
            if reason:
                raise AuditPreconditionError(reason)
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
        self._write_anchor(len(history) + 1, event.event_hash)
        return event
