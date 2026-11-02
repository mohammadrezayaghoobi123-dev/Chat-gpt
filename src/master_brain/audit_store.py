"""Append-only JSONL persistence for Master Brain audit events.

Appends are serialized with an exclusive advisory file lock on a sidecar
``<path>.lock`` file, so concurrent writers (threads or processes on the same
host) cannot fork the hash chain. The lock is advisory and local: it does not
protect against non-cooperating writers or network filesystems without lock
support. Hashes detect changes in stored history, but cannot detect a complete
rewrite unless a checkpoint is retained elsewhere.

Payloads pass ``audit_policy`` first: a top-level key allow-list for registered
event types (unregistered types are rejected unless ``strict_event_types=False``) and secret screening (key names and credential-shaped values) for all.

Appends reject a ``recorded_at`` earlier than the last stored event (backdating).
Values later than the store clock plus ``max_future_skew_seconds`` are rejected too,
so one future-dated event cannot lock the log against later legitimate events. The
clock is injectable; a trusted/attested time source can replace it later.

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
from datetime import datetime, timezone
import json
import os
import threading
import time
from pathlib import Path
from typing import Any, Callable

from master_brain.audit_ledger import GENESIS_HASH, AuditEvent, create_event, verify_chain
from master_brain.audit_policy import AuditPayloadRejected, enforce_payload_policy


_HELD = threading.local()  # lock-file paths this thread currently holds exclusively (re-entrancy)


class AuditStoreError(RuntimeError):
    """Raised when the audit store cannot safely be read or extended."""


class AuditPreconditionError(AuditStoreError):
    """Raised when an append's precondition rejects the current verified history."""


class AuditPayloadError(AuditStoreError):
    """Raised when a payload violates the audit key allow-list or contains a secret."""


class _NowType:
    """Sentinel: let the store stamp ``recorded_at`` from its clock *while holding the lock*.

    A timestamp taken before the lock can be older than an event another writer appended in the
    meantime, and the store (correctly) never backdates; stamping under the lock removes that race."""

    _instance = None

    def __new__(cls):
        if cls._instance is None:
            cls._instance = super().__new__(cls)
        return cls._instance

    def __repr__(self) -> str:
        return "NOW"


NOW = _NowType()


class AuditStore:
    """Fail-closed, single-writer JSONL audit store; never auto-repairs history."""

    def __init__(
        self, path: str | os.PathLike[str], *, strict_event_types: bool = True,
        clock: Callable[[], datetime] | None = None, max_future_skew_seconds: float = 300.0,
        full_verify_interval_seconds: float | None = None,
        monotonic: Callable[[], float] | None = None, require_anchor: bool = False,
    ) -> None:
        # ``require_anchor=True``: a NON-EMPTY log without its ``.head`` anchor is refused instead of being
        # treated as a legacy log. Without it, deleting the anchor together with the last records (or a
        # backup that forgot the anchor) would hide a truncation. Default False keeps legacy logs usable.
        self._require_anchor = bool(require_anchor)
        # ``full_verify_interval_seconds=None`` (default): every read re-verifies the whole
        # file. A number enables the verified-prefix cache: the first read and then one read
        # per interval verify everything; reads in between verify only bytes appended since
        # the last verification (chain link, hashes, ids, anchor). Tampering with an OLD
        # byte is then detected at the next full verification, at most one interval later.
        if full_verify_interval_seconds is not None and (
            isinstance(full_verify_interval_seconds, bool)
            or not isinstance(full_verify_interval_seconds, (int, float))
            or not 0 < full_verify_interval_seconds < float("inf")
        ):
            raise ValueError("full_verify_interval_seconds must be None or a finite number > 0")
        self._full_interval = full_verify_interval_seconds
        self._monotonic = monotonic or time.monotonic
        self._cache: dict[str, Any] | None = None
        self._cache_lock = threading.Lock()  # servers read from many threads
        if isinstance(max_future_skew_seconds, bool) or not isinstance(
            max_future_skew_seconds, (int, float)
        ) or not 0 <= max_future_skew_seconds < float("inf"):
            raise ValueError("max_future_skew_seconds must be a finite number >= 0")
        self.path = Path(path)
        self.strict_event_types = strict_event_types
        # Injectable time source: production uses the system clock; tests and a future
        # trusted-time service can supply their own without changing callers.
        self._clock = clock or (lambda: datetime.now(timezone.utc))
        self.max_future_skew_seconds = float(max_future_skew_seconds)

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
        """Verified history. Takes a SHARED lock so a record being appended is never seen half-written."""
        with self._shared_lock():
            return self._read_all_unlocked()

    def _read_all_unlocked(self) -> tuple[AuditEvent, ...]:
        if not self.path.exists():
            self._cache = None
            return ()
        if self._full_interval is None:
            return self._read_all_uncached()
        with self._cache_lock:
            return self._read_all_cached()

    def _read_all_uncached(self) -> tuple[AuditEvent, ...]:
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

    def _parse_chunk(self, data: bytes, first_line: int, previous: str, ids: set[str]):
        """Decode and chain-verify complete lines of ``data``; returns (events, new ids).

        Nothing is committed to the cache here: the caller does that only on success."""
        if not data:
            return [], set()
        if not data.endswith(b"\n"):
            raise AuditStoreError(f"unterminated audit record at line {first_line + data.count(chr(10).encode())}")
        try:
            text = data.decode("utf-8")
        except UnicodeDecodeError as exc:
            raise AuditStoreError("audit store is not valid UTF-8") from exc
        events: list[AuditEvent] = []
        new_ids: set[str] = set()
        for offset, line in enumerate(text.split("\n")[:-1]):
            number = first_line + offset
            if not line.strip():
                raise AuditStoreError(f"blank audit record at line {number}")
            events.append(self._decode(line + "\n", number))
        check = verify_chain(events, genesis_hash=previous)
        if not check.valid:
            raise AuditStoreError(
                f"audit chain verification failed at {check.failing_event_id}: {check.reason}"
            )
        for event in events:
            if event.event_id in ids or event.event_id in new_ids:
                raise AuditStoreError(
                    f"audit chain verification failed at {event.event_id}: duplicate_event_id"
                )
            new_ids.add(event.event_id)
        return events, new_ids

    def _read_all_cached(self) -> tuple[AuditEvent, ...]:
        try:
            st = os.stat(self.path)
        except OSError as exc:
            raise AuditStoreError("audit store is unreadable") from exc
        now = self._monotonic()
        c = self._cache
        if (c is not None and c["dev"] == st.st_dev and c["ino"] == st.st_ino
                and st.st_size >= c["size"] and 0 <= now - c["verified_at"] < self._full_interval):
            try:
                with self.path.open("rb") as handle:
                    handle.seek(c["size"])
                    tail = handle.read()
            except OSError as exc:
                raise AuditStoreError("audit store is unreadable") from exc
            events, new_ids = self._parse_chunk(
                tail, len(c["events"]) + 1,
                c["events"][-1].event_hash if c["events"] else GENESIS_HASH, c["ids"])
            merged = c["events"] + events if events else c["events"]
            self._verify_anchor(merged)
            if events:  # commit only after the tail AND the anchor agree
                c["events"] = merged
                c["ids"] |= new_ids
                c["size"] += len(tail)
            return tuple(c["events"])
        # first read, interval elapsed, file replaced or shrunk: verify everything
        self._cache = None
        try:
            with self.path.open("rb") as handle:
                fst = os.fstat(handle.fileno())
                data = handle.read()
        except OSError as exc:
            raise AuditStoreError("audit store is unreadable") from exc
        events, ids = self._parse_chunk(data, 1, GENESIS_HASH, set())
        self._verify_anchor(events)
        self._cache = {"dev": fst.st_dev, "ino": fst.st_ino, "size": len(data), "events": events,
                       "ids": ids, "verified_at": now}
        return tuple(events)

    @property
    def anchor_path(self) -> Path:
        return self.path.with_name(self.path.name + ".head")

    def _verify_anchor(self, events: list[AuditEvent]) -> None:
        anchor = self.anchor_path
        if not anchor.exists():
            if self._require_anchor and events:
                raise AuditStoreError(
                    "audit head anchor is missing for a non-empty log; restore the .head file from the backup "
                    "or, if this log never had one, adopt it explicitly (audit_recovery --adopt-anchor)")
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

    @property
    def _lock_path(self) -> Path:
        return self.path.with_name(self.path.name + ".lock")

    @contextmanager
    def _flock(self, *, shared: bool):
        handle = self._lock_path.open("a+b")
        try:
            try:
                if os.name == "nt":
                    import msvcrt
                    handle.seek(0)
                    msvcrt.locking(handle.fileno(), msvcrt.LK_LOCK, 1)  # no shared mode: exclusive
                else:
                    import fcntl
                    fcntl.flock(handle.fileno(), fcntl.LOCK_SH if shared else fcntl.LOCK_EX)
            except OSError as exc:
                raise AuditStoreError("failed to acquire audit store lock") from exc
            yield
        finally:
            handle.close()  # closing releases the lock

    @contextmanager
    def _exclusive_lock(self):
        """Hold an exclusive cross-process lock for one read-modify-append cycle."""
        self.path.parent.mkdir(parents=True, exist_ok=True)
        key = str(self._lock_path.resolve())
        held = getattr(_HELD, "paths", None)
        if held is None:
            held = _HELD.paths = {}
        if held.get(key):  # already exclusive in this thread: re-entering must not deadlock on ourselves
            held[key] += 1
            try:
                yield
            finally:
                held[key] -= 1
            return
        try:
            cm = self._flock(shared=False)
            cm.__enter__()
        except OSError as exc:
            raise AuditStoreError("failed to open audit store lock") from exc
        held[key] = 1
        try:
            yield
        finally:
            held[key] = 0
            cm.__exit__(None, None, None)

    @contextmanager
    def _shared_lock(self):
        """Readers wait for an in-progress append. A thread that already holds the exclusive lock reads freely.

        If the lock file cannot be opened (e.g. a read-only data directory with no writer) the read proceeds
        unlocked, exactly as before this lock existed."""
        held = getattr(_HELD, "paths", None) or {}
        try:
            skip = bool(held.get(str(self._lock_path.resolve()))) or not self.path.parent.is_dir()
        except OSError:
            skip = True  # the real read below reports an unreadable store with its own error
        if skip:
            yield
            return
        try:
            cm = self._flock(shared=True)
            cm.__enter__()
        except AuditStoreError:
            raise
        except OSError:
            yield
            return
        try:
            yield
        finally:
            cm.__exit__(None, None, None)

    def append(
        self, *, event_id: str, event_type: str, recorded_at: "str | _NowType", actor: str,
        subject_ref: str, payload: dict[str, Any],
        precondition: Callable[[tuple[AuditEvent, ...]], str | None] | None = None,
    ) -> AuditEvent:
        """Append one event. ``recorded_at=NOW`` stamps the store clock under the lock. ``precondition`` is evaluated on the verified history
        while the exclusive lock is held (atomic check-and-append); a returned
        string rejects the append with AuditPreconditionError. Payloads are checked
        against the audit allow-list / secret policy before anything is written."""
        try:
            enforce_payload_policy(event_type, payload, strict_event_types=self.strict_event_types)
        except AuditPayloadRejected as exc:
            raise AuditPayloadError(str(exc)) from exc
        with self._exclusive_lock():
            return self._append_locked(
                event_id=event_id, event_type=event_type, recorded_at=recorded_at,
                actor=actor, subject_ref=subject_ref, payload=payload,
                precondition=precondition,
            )

    def now(self) -> datetime:
        """Current time from the store's (injectable) clock; the single time seam."""
        return self._clock()

    def _check_not_in_future(self, recorded_at: str) -> None:
        try:
            at = datetime.fromisoformat(recorded_at.replace("Z", "+00:00"))
        except (ValueError, AttributeError):
            return  # malformed values are rejected by create_event
        if at.tzinfo is None:
            return
        now = self._clock()
        if (at - now).total_seconds() > self.max_future_skew_seconds:
            raise AuditStoreError(
                f"recorded_at {recorded_at} is in the future beyond the allowed skew"
            )

    def _append_locked(
        self, *, event_id: str, event_type: str, recorded_at: "str | _NowType", actor: str,
        subject_ref: str, payload: dict[str, Any],
        precondition: Callable[[tuple[AuditEvent, ...]], str | None] | None = None,
    ) -> AuditEvent:
        history = self._read_all_unlocked()
        if recorded_at is NOW:
            recorded_at = self.now().isoformat().replace("+00:00", "Z")
        if precondition is not None:
            reason = precondition(history)
            if reason:
                raise AuditPreconditionError(reason)
        if any(item.event_id == event_id for item in history):
            raise AuditStoreError(f"duplicate event_id: {event_id}")
        self._check_not_in_future(recorded_at)
        if history:
            try:
                new_at = datetime.fromisoformat(recorded_at.replace("Z", "+00:00"))
                last_at = datetime.fromisoformat(history[-1].recorded_at.replace("Z", "+00:00"))
                regressed = new_at.tzinfo is not None and last_at.tzinfo is not None and new_at < last_at
            except (ValueError, AttributeError):
                regressed = False  # malformed values are rejected by create_event below
            if regressed:
                raise AuditStoreError(
                    f"recorded_at {recorded_at} precedes the last event ({history[-1].recorded_at})"
                )
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
