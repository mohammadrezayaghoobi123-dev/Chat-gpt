"""SQLite-backed local idempotency registry prototype.

This is a single-host coordination primitive, not exactly-once external execution.
"""
from __future__ import annotations

from contextlib import closing
from dataclasses import dataclass
from enum import Enum
import math
import sqlite3


class RegistryError(RuntimeError): pass
class IdempotencyConflict(RegistryError): pass
class InvalidTransition(RegistryError): pass


class State(str, Enum):
    PENDING = "PENDING"
    RUNNING = "RUNNING"
    SUCCEEDED = "SUCCEEDED"
    FAILED = "FAILED"
    OUTCOME_UNKNOWN = "OUTCOME_UNKNOWN"
    RECONCILIATION_REQUIRED = "RECONCILIATION_REQUIRED"


_ALLOWED = {
    State.PENDING: {State.RUNNING, State.FAILED},
    State.RUNNING: {State.SUCCEEDED, State.OUTCOME_UNKNOWN},
    State.OUTCOME_UNKNOWN: {State.RECONCILIATION_REQUIRED},
    State.RECONCILIATION_REQUIRED: {State.SUCCEEDED, State.OUTCOME_UNKNOWN},
    State.SUCCEEDED: set(), State.FAILED: set(),
}


@dataclass(frozen=True)
class Record:
    key: str
    mission_id: str
    contract_digest: str
    payload_digest: str
    state: State
    version: int
    created_at: str
    updated_at: str


class SQLiteExecutionRegistry:
    """Atomic per-key reservations and compare-and-swap transitions."""

    def __init__(self, path: str, timeout: float = 5.0):
        if isinstance(timeout, bool) or not isinstance(timeout, (int, float)):
            raise ValueError("timeout must be a finite non-negative number")
        if not math.isfinite(timeout) or timeout < 0:
            raise ValueError("timeout must be a finite non-negative number")
        self.path, self.timeout = path, float(timeout)
        with closing(self._db()) as db, db:
            db.execute("""CREATE TABLE IF NOT EXISTS executions (
                key TEXT PRIMARY KEY, mission_id TEXT NOT NULL,
                contract_digest TEXT NOT NULL, payload_digest TEXT NOT NULL,
                state TEXT NOT NULL, version INTEGER NOT NULL,
                created_at TEXT NOT NULL, updated_at TEXT NOT NULL)""")
            db.execute("PRAGMA journal_mode=WAL")

    def _db(self):
        db = sqlite3.connect(self.path, timeout=self.timeout, isolation_level=None)
        db.row_factory = sqlite3.Row
        # PRAGMA busy_timeout is in milliseconds and overrides the connection setting.
        db.execute(f"PRAGMA busy_timeout={int(self.timeout * 1000)}")
        return db

    @staticmethod
    def _record(row):
        try:
            return Record(row["key"], row["mission_id"], row["contract_digest"],
                          row["payload_digest"], State(row["state"]), row["version"],
                          row["created_at"], row["updated_at"])
        except (ValueError, TypeError, KeyError) as exc:
            raise RegistryError("invalid registry record") from exc

    @staticmethod
    def _required(**values):
        for name, value in values.items():
            if not isinstance(value, str) or not value.strip():
                raise ValueError(f"{name} must be a non-empty string")

    def reserve(self, *, key: str, mission_id: str, contract_digest: str,
                payload_digest: str, recorded_at: str) -> tuple[Record, bool]:
        """Return (record, created); identical duplicate requests never reclaim RUNNING."""
        self._required(key=key, mission_id=mission_id, contract_digest=contract_digest,
                       payload_digest=payload_digest, recorded_at=recorded_at)
        try:
            with closing(self._db()) as db, db:
                db.execute("BEGIN IMMEDIATE")
                row = db.execute("SELECT * FROM executions WHERE key=?", (key,)).fetchone()
                if row:
                    record = self._record(row)
                    if (record.mission_id, record.contract_digest, record.payload_digest) != (
                        mission_id, contract_digest, payload_digest
                    ):
                        raise IdempotencyConflict("key reused with different request digests")
                    db.commit()
                    return record, False
                db.execute("INSERT INTO executions VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                           (key, mission_id, contract_digest, payload_digest,
                            State.PENDING.value, 0, recorded_at, recorded_at))
                row = db.execute("SELECT * FROM executions WHERE key=?", (key,)).fetchone()
                db.commit()
                return self._record(row), True
        except (IdempotencyConflict, RegistryError):
            raise
        except sqlite3.Error as exc:
            raise RegistryError("reservation failed") from exc

    def get(self, key: str) -> Record | None:
        self._required(key=key)
        try:
            with closing(self._db()) as db:
                row = db.execute("SELECT * FROM executions WHERE key=?", (key,)).fetchone()
                return None if row is None else self._record(row)
        except sqlite3.Error as exc:
            raise RegistryError("registry read failed") from exc

    def list_recovery_candidates(self) -> list[Record]:
        """List executions needing inspection; never dispatch or mutate them.

        RUNNING can mean the worker died before or after an external side effect.
        OUTCOME_UNKNOWN and RECONCILIATION_REQUIRED also require evidence-based
        review. Listing candidates is deliberately read-only and does not infer
        success or failure from age, process death, or a missing local receipt.
        """
        candidate_states = {
            State.RUNNING,
            State.OUTCOME_UNKNOWN,
            State.RECONCILIATION_REQUIRED,
        }
        try:
            with closing(self._db()) as db:
                # Validate every persisted row before filtering. A query that
                # selects only known states would silently hide corrupt/unknown
                # state values and make the recovery inventory incomplete.
                rows = db.execute(
                    "SELECT * FROM executions ORDER BY updated_at ASC, key ASC"
                ).fetchall()
                records = [self._record(row) for row in rows]
                return [record for record in records if record.state in candidate_states]
        except RegistryError:
            raise
        except sqlite3.Error as exc:
            raise RegistryError("recovery candidate listing failed") from exc

    def transition(self, *, key: str, expected_version: int, target: State,
                   recorded_at: str) -> Record:
        """Atomically enforce state-machine edges and reject stale writers.

        FAILED is only reachable from PENDING in this prototype. Once RUNNING,
        a possible external side effect makes failure a claim that needs trusted
        evidence; this generic transition API does not accept such evidence.
        """
        self._required(key=key, recorded_at=recorded_at)
        if not isinstance(target, State):
            raise TypeError("target must be a State")
        try:
            with closing(self._db()) as db, db:
                db.execute("BEGIN IMMEDIATE")
                row = db.execute("SELECT * FROM executions WHERE key=?", (key,)).fetchone()
                if row is None:
                    raise InvalidTransition("unknown execution key")
                current = self._record(row)
                if current.version != expected_version:
                    raise InvalidTransition("stale execution version")
                # This prototype has no provider-specific evidence verifier yet.
                # Fail closed rather than let callers assert success by changing state.
                if target is State.SUCCEEDED:
                    raise InvalidTransition("SUCCEEDED requires verified completion evidence; API not implemented")
                if target not in _ALLOWED[current.state]:
                    raise InvalidTransition(f"disallowed transition {current.state.value}->{target.value}")
                cur = db.execute("""UPDATE executions SET state=?, version=version+1, updated_at=?
                    WHERE key=? AND version=?""",
                    (target.value, recorded_at, key, expected_version))
                if cur.rowcount != 1:
                    raise InvalidTransition("concurrent state change")
                row = db.execute("SELECT * FROM executions WHERE key=?", (key,)).fetchone()
                db.commit()
                return self._record(row)
        except (InvalidTransition, RegistryError):
            raise
        except sqlite3.Error as exc:
            raise RegistryError("transition failed") from exc
