"""SQLite-backed local idempotency registry prototype.

This is a single-host coordination primitive, not exactly-once external execution.
"""
from __future__ import annotations

from contextlib import closing
from dataclasses import dataclass
from enum import Enum
import math
import sqlite3
import time
import uuid


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
class ExecutionAttempt:
    attempt_id: str
    key: str
    attempt_number: int
    integration_id: str
    adapter_version: str
    provider_id: str
    dispatch_boundary_entered: bool
    created_at: str
    updated_at: str


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
            db.execute("""CREATE TABLE IF NOT EXISTS execution_attempts (
                attempt_id TEXT PRIMARY KEY,
                execution_key TEXT NOT NULL,
                attempt_number INTEGER NOT NULL,
                integration_id TEXT NOT NULL,
                adapter_version TEXT NOT NULL,
                provider_id TEXT NOT NULL,
                dispatch_boundary_entered INTEGER NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                UNIQUE(execution_key))""")
            # Retrofit the one-attempt invariant onto databases created before
            # the table-level UNIQUE constraint existed. If legacy duplicates
            # exist, index creation fails closed; never delete or merge attempts.
            try:
                db.execute(
                    "CREATE UNIQUE INDEX IF NOT EXISTS idx_attempts_one_per_execution "
                    "ON execution_attempts(execution_key)"
                )
            except sqlite3.IntegrityError as exc:
                raise RegistryError(
                    "legacy execution_attempts contains duplicate execution keys; "
                    "manual evidence-based reconciliation is required"
                ) from exc
            db.execute("""CREATE TABLE IF NOT EXISTS completion_receipts (
                execution_key TEXT PRIMARY KEY,
                attempt_id TEXT NOT NULL UNIQUE,
                evidence_digest TEXT NOT NULL,
                verifier_id TEXT NOT NULL,
                verifier_version TEXT NOT NULL,
                evidence_type TEXT NOT NULL,
                observed_at TEXT NOT NULL,
                recorded_at TEXT NOT NULL
            )""")
            db.execute("CREATE INDEX IF NOT EXISTS idx_attempts_execution ON execution_attempts(execution_key, attempt_number)")
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

    def _begin_immediate_with_retry(self, db: sqlite3.Connection) -> None:
        """Retry only transient SQLite BUSY/LOCKED failures before writes begin."""
        delays = (0.01, 0.025, 0.05, 0.1)
        for delay in (*delays, None):
            try:
                db.execute("BEGIN IMMEDIATE")
                return
            except sqlite3.OperationalError as exc:
                code = getattr(exc, "sqlite_errorcode", None)
                primary_code = (code & 0xFF) if isinstance(code, int) else None
                if primary_code not in (sqlite3.SQLITE_BUSY, sqlite3.SQLITE_LOCKED) or delay is None:
                    raise
                time.sleep(delay)

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

    @staticmethod
    def _attempt(row):
        try:
            # SQLite stores this flag as an integer. Do not coerce arbitrary
            # non-zero/corrupt values to True: that could turn a damaged row
            # into false evidence that the external dispatch boundary was entered.
            boundary = row["dispatch_boundary_entered"]
            if type(boundary) is not int or boundary not in (0, 1):
                raise RegistryError("invalid execution attempt record")
            attempt_number = row["attempt_number"]
            if type(attempt_number) is not int or attempt_number < 1:
                raise RegistryError("invalid execution attempt record")
            values = (
                row["attempt_id"], row["execution_key"], row["integration_id"],
                row["adapter_version"], row["provider_id"], row["created_at"],
                row["updated_at"],
            )
            if any(not isinstance(value, str) or not value.strip() for value in values):
                raise RegistryError("invalid execution attempt record")
            return ExecutionAttempt(
                row["attempt_id"], row["execution_key"], attempt_number,
                row["integration_id"], row["adapter_version"], row["provider_id"],
                boundary == 1, row["created_at"], row["updated_at"],
            )
        except (ValueError, TypeError, KeyError) as exc:
            raise RegistryError("invalid execution attempt record") from exc

    def reserve_attempt(
        self, *, key: str, expected_version: int, integration_id: str,
        adapter_version: str, provider_id: str, recorded_at: str,
    ) -> ExecutionAttempt:
        """Durably create a unique attempt before entering the external-call boundary.

        The parent execution must already be RUNNING at the supplied version.
        This is a local durable record, not proof that a provider was contacted.
        """
        self._required(
            key=key, integration_id=integration_id,
            adapter_version=adapter_version, provider_id=provider_id,
            recorded_at=recorded_at,
        )
        if isinstance(expected_version, bool) or not isinstance(expected_version, int) or expected_version < 0:
            raise ValueError("expected_version must be a non-negative integer")
        from datetime import datetime
        try:
            attempt_created_dt = datetime.fromisoformat(
                recorded_at.strip().replace("Z", "+00:00")
            )
        except (AttributeError, ValueError) as exc:
            raise InvalidTransition(
                "attempt timestamp must be timezone-aware ISO-8601"
            ) from exc
        if attempt_created_dt.tzinfo is None or attempt_created_dt.utcoffset() is None:
            raise InvalidTransition("attempt timestamp must be timezone-aware ISO-8601")
        try:
            with closing(self._db()) as db, db:
                db.execute("BEGIN IMMEDIATE")
                row = db.execute("SELECT * FROM executions WHERE key=?", (key,)).fetchone()
                if row is None:
                    raise InvalidTransition("unknown execution key")
                execution = self._record(row)
                if execution.version != expected_version:
                    raise InvalidTransition("stale execution version")
                if execution.state is not State.RUNNING:
                    raise InvalidTransition("attempt requires RUNNING execution")
                try:
                    execution_updated_dt = datetime.fromisoformat(
                        execution.updated_at.strip().replace("Z", "+00:00")
                    )
                except (AttributeError, ValueError) as exc:
                    raise RegistryError("execution update timestamp is invalid") from exc
                if (
                    execution_updated_dt.tzinfo is None
                    or execution_updated_dt.utcoffset() is None
                ):
                    raise RegistryError("execution update timestamp is invalid")
                if attempt_created_dt < execution_updated_dt:
                    raise InvalidTransition(
                        "attempt timestamp predates execution update"
                    )
                existing = db.execute(
                    "SELECT attempt_id FROM execution_attempts WHERE execution_key=?", (key,)
                ).fetchone()
                if existing is not None:
                    raise InvalidTransition("an attempt already exists; reconcile before any retry")
                number = 1
                attempt_id = uuid.uuid4().hex
                db.execute(
                    """INSERT INTO execution_attempts
                    (attempt_id, execution_key, attempt_number, integration_id,
                     adapter_version, provider_id, dispatch_boundary_entered, created_at, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)""",
                    (attempt_id, key, number, integration_id, adapter_version,
                     provider_id, recorded_at, recorded_at),
                )
                row = db.execute(
                    "SELECT * FROM execution_attempts WHERE attempt_id=?", (attempt_id,)
                ).fetchone()
                db.commit()
                return self._attempt(row)
        except (InvalidTransition, RegistryError):
            raise
        except sqlite3.Error as exc:
            raise RegistryError("attempt reservation failed") from exc

    def get_attempt(self, attempt_id: str) -> ExecutionAttempt | None:
        self._required(attempt_id=attempt_id)
        try:
            with closing(self._db()) as db:
                row = db.execute(
                    "SELECT * FROM execution_attempts WHERE attempt_id=?", (attempt_id,)
                ).fetchone()
                return None if row is None else self._attempt(row)
        except sqlite3.Error as exc:
            raise RegistryError("attempt read failed") from exc

    def get_attempt_for_execution(self, key: str) -> ExecutionAttempt | None:
        """Return the unique durable attempt associated with an execution key.

        Recovery inventories start from execution records, so callers must be
        able to inspect the attempt and its dispatch-boundary marker without
        knowing or guessing the attempt ID. The lookup is read-only.
        """
        self._required(key=key)
        try:
            with closing(self._db()) as db:
                row = db.execute(
                    "SELECT * FROM execution_attempts WHERE execution_key=?",
                    (key,),
                ).fetchone()
                return None if row is None else self._attempt(row)
        except RegistryError:
            raise
        except sqlite3.Error as exc:
            raise RegistryError("attempt lookup by execution failed") from exc

    def mark_attempt_dispatch_boundary(
        self, *, attempt_id: str, recorded_at: str
    ) -> ExecutionAttempt:
        """Durably mark conservative entry into the dispatch boundary, idempotently."""
        self._required(attempt_id=attempt_id, recorded_at=recorded_at)
        from datetime import datetime
        try:
            boundary_dt = datetime.fromisoformat(
                recorded_at.strip().replace("Z", "+00:00")
            )
        except (AttributeError, ValueError) as exc:
            raise InvalidTransition(
                "dispatch boundary timestamp must be timezone-aware ISO-8601"
            ) from exc
        if boundary_dt.tzinfo is None or boundary_dt.utcoffset() is None:
            raise InvalidTransition(
                "dispatch boundary timestamp must be timezone-aware ISO-8601"
            )
        try:
            with closing(self._db()) as db, db:
                db.execute("BEGIN IMMEDIATE")
                row = db.execute(
                    "SELECT * FROM execution_attempts WHERE attempt_id=?", (attempt_id,)
                ).fetchone()
                if row is None:
                    raise InvalidTransition("unknown attempt ID")
                attempt = self._attempt(row)
                if attempt.dispatch_boundary_entered:
                    db.commit()
                    return attempt
                try:
                    created_dt = datetime.fromisoformat(
                        attempt.created_at.strip().replace("Z", "+00:00")
                    )
                except (AttributeError, ValueError) as exc:
                    raise RegistryError(
                        "attempt creation timestamp is invalid"
                    ) from exc
                if created_dt.tzinfo is None or created_dt.utcoffset() is None:
                    raise RegistryError("attempt creation timestamp is invalid")
                if boundary_dt < created_dt:
                    raise InvalidTransition(
                        "dispatch boundary timestamp predates attempt creation"
                    )
                db.execute(
                    """UPDATE execution_attempts SET dispatch_boundary_entered=1, updated_at=?
                    WHERE attempt_id=? AND dispatch_boundary_entered=0""",
                    (recorded_at, attempt_id),
                )
                row = db.execute(
                    "SELECT * FROM execution_attempts WHERE attempt_id=?", (attempt_id,)
                ).fetchone()
                db.commit()
                return self._attempt(row)
        except (InvalidTransition, RegistryError):
            raise
        except sqlite3.Error as exc:
            raise RegistryError("attempt boundary update failed") from exc

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

    def complete_with_verified_evidence(
        self, *, key: str, expected_version: int, attempt_id: str,
        evidence: object, verifier_id: str, verifier_version: str,
        verifier_registry: object, recorded_at: str,
    ) -> Record:
        """Atomically persist trusted completion evidence and mark an uncertain execution successful.

        Provider verification runs before acquiring the SQLite writer lock. Inside
        the transaction, the execution version/state and full attempt snapshot are
        re-read and compared, then the receipt and SUCCEEDED transition commit
        together. The generic transition API intentionally cannot bypass this path.
        """
        from datetime import datetime
        from master_brain.completion_evidence import (
            CompletionEvidence, EvidenceValidationError, evidence_digest,
            validate_registered_completion_evidence,
        )

        self._required(
            key=key, attempt_id=attempt_id, verifier_id=verifier_id,
            verifier_version=verifier_version, recorded_at=recorded_at,
        )
        if isinstance(expected_version, bool) or not isinstance(expected_version, int) or expected_version < 0:
            raise ValueError("expected_version must be a non-negative integer")
        if not isinstance(evidence, CompletionEvidence):
            raise EvidenceValidationError("evidence must be a CompletionEvidence record")
        try:
            recorded_dt = datetime.fromisoformat(
                recorded_at.strip().replace("Z", "+00:00")
            )
        except (AttributeError, ValueError) as exc:
            raise ValueError("recorded_at must be timezone-aware ISO-8601") from exc
        if recorded_dt.tzinfo is None or recorded_dt.utcoffset() is None:
            raise ValueError("recorded_at must be timezone-aware ISO-8601")
        if evidence.attempt_id != attempt_id or evidence.execution_key != key:
            raise EvidenceValidationError("evidence does not match requested execution and attempt")

        # A previously committed exact receipt makes a retry safe even though
        # normal evidence validation correctly rejects terminal SUCCEEDED records.
        current = self.get(key)
        if current is None:
            raise InvalidTransition("unknown execution key")
        if current.state is State.SUCCEEDED:
            try:
                with closing(self._db()) as db:
                    receipt = db.execute(
                        "SELECT * FROM completion_receipts WHERE execution_key=?", (key,)
                    ).fetchone()
            except sqlite3.Error as exc:
                raise RegistryError("completion receipt read failed") from exc
            if (
                receipt is not None
                and receipt["attempt_id"] == attempt_id
                and receipt["evidence_digest"] == evidence_digest(evidence)
                and receipt["verifier_id"] == verifier_id
                and receipt["verifier_version"] == verifier_version
            ):
                return current
            raise InvalidTransition("execution already succeeded with different or missing completion evidence")
        if current.version != expected_version:
            raise InvalidTransition("stale execution version")

        attempt = self.get_attempt(attempt_id)
        if attempt is None:
            raise InvalidTransition("unknown attempt ID")
        if attempt.key != key:
            raise InvalidTransition("attempt does not belong to execution")

        # Enforce chronology here as well as binding: this branch may be used
        # before the separate completion-evidence hardening branch is integrated.
        def parse_aware_timestamp(name: str, value: object):
            if not isinstance(value, str) or not value.strip():
                raise EvidenceValidationError(f"{name} must be timezone-aware ISO-8601")
            normalized = value.strip()
            if normalized.endswith("Z"):
                normalized = normalized[:-1] + "+00:00"
            try:
                parsed = datetime.fromisoformat(normalized)
            except ValueError as exc:
                raise EvidenceValidationError(f"{name} must be timezone-aware ISO-8601") from exc
            if parsed.tzinfo is None or parsed.utcoffset() is None:
                raise EvidenceValidationError(f"{name} must be timezone-aware ISO-8601")
            return parsed

        observed_at = parse_aware_timestamp("observed_at", evidence.observed_at)
        attempt_created_at = parse_aware_timestamp("attempt creation timestamp", attempt.created_at)
        dispatch_boundary_at = parse_aware_timestamp("dispatch boundary timestamp", attempt.updated_at)
        if not attempt.dispatch_boundary_entered:
            raise EvidenceValidationError("dispatch boundary was not entered")
        if dispatch_boundary_at < attempt_created_at:
            raise EvidenceValidationError("dispatch boundary predates attempt creation")
        if observed_at < dispatch_boundary_at:
            raise EvidenceValidationError("observed_at predates dispatch boundary")
        if recorded_dt < observed_at:
            raise EvidenceValidationError("recorded_at predates evidence observation")
        execution_updated_at = parse_aware_timestamp("execution update timestamp", current.updated_at)
        if recorded_dt < execution_updated_at:
            raise EvidenceValidationError("recorded_at predates current execution state")

        verified = validate_registered_completion_evidence(
            execution=current,
            attempt=attempt,
            evidence=evidence,
            verifier_id=verifier_id,
            verifier_version=verifier_version,
            registry=verifier_registry,
        )

        stage = "begin_immediate"
        try:
            with closing(self._db()) as db, db:
                self._begin_immediate_with_retry(db)
                stage = "recheck_execution"
                row = db.execute("SELECT * FROM executions WHERE key=?", (key,)).fetchone()
                if row is None:
                    raise InvalidTransition("unknown execution key")
                persisted = self._record(row)
                attempt_row = db.execute(
                    "SELECT * FROM execution_attempts WHERE attempt_id=?", (attempt_id,)
                ).fetchone()
                if attempt_row is None:
                    raise InvalidTransition("unknown attempt ID")
                persisted_attempt = self._attempt(attempt_row)

                # Handle a racing exact retry after another caller committed.
                if persisted.state is State.SUCCEEDED:
                    receipt = db.execute(
                        "SELECT * FROM completion_receipts WHERE execution_key=?", (key,)
                    ).fetchone()
                    if (
                        receipt is not None
                        and receipt["attempt_id"] == attempt_id
                        and receipt["evidence_digest"] == verified.evidence_digest
                        and receipt["verifier_id"] == verified.verifier_id
                        and receipt["verifier_version"] == verified.verifier_version
                    ):
                        db.commit()
                        return persisted
                    raise InvalidTransition("execution already succeeded with different or missing completion evidence")
                if persisted.version != expected_version or persisted != current:
                    raise InvalidTransition("execution changed during evidence verification")
                if persisted.state not in {State.OUTCOME_UNKNOWN, State.RECONCILIATION_REQUIRED}:
                    raise InvalidTransition("execution is not awaiting evidence reconciliation")
                if persisted_attempt != attempt:
                    raise InvalidTransition("attempt changed during evidence verification")
                if not persisted_attempt.dispatch_boundary_entered:
                    raise InvalidTransition("dispatch boundary was not entered")

                stage = "insert_completion_receipt"
                db.execute(
                    """INSERT INTO completion_receipts
                    (execution_key, attempt_id, evidence_digest, verifier_id,
                     verifier_version, evidence_type, observed_at, recorded_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                    (
                        key, attempt_id, verified.evidence_digest, verified.verifier_id,
                        verified.verifier_version, verified.evidence_type,
                        evidence.observed_at, recorded_at,
                    ),
                )
                stage = "update_execution"
                changed = db.execute(
                    """UPDATE executions SET state=?, version=version+1, updated_at=?
                    WHERE key=? AND version=? AND state IN (?, ?)""",
                    (
                        State.SUCCEEDED.value, recorded_at, key, expected_version,
                        State.OUTCOME_UNKNOWN.value, State.RECONCILIATION_REQUIRED.value,
                    ),
                )
                if changed.rowcount != 1:
                    raise InvalidTransition("concurrent state change")
                stage = "read_completed_execution"
                row = db.execute("SELECT * FROM executions WHERE key=?", (key,)).fetchone()
                result = self._record(row)
                db.commit()
                return result
        except (InvalidTransition, RegistryError, EvidenceValidationError):
            raise
        except sqlite3.Error as exc:
            raise RegistryError(f"evidence-authorized completion failed during {stage}") from exc

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
        from datetime import datetime
        try:
            transition_dt = datetime.fromisoformat(
                recorded_at.strip().replace("Z", "+00:00")
            )
        except (AttributeError, ValueError) as exc:
            raise InvalidTransition(
                "transition timestamp must be timezone-aware ISO-8601"
            ) from exc
        if transition_dt.tzinfo is None or transition_dt.utcoffset() is None:
            raise InvalidTransition(
                "transition timestamp must be timezone-aware ISO-8601"
            )
        try:
            with closing(self._db()) as db, db:
                db.execute("BEGIN IMMEDIATE")
                row = db.execute("SELECT * FROM executions WHERE key=?", (key,)).fetchone()
                if row is None:
                    raise InvalidTransition("unknown execution key")
                current = self._record(row)
                try:
                    current_updated_dt = datetime.fromisoformat(
                        current.updated_at.strip().replace("Z", "+00:00")
                    )
                except (AttributeError, ValueError) as exc:
                    raise RegistryError(
                        "current execution timestamp is invalid"
                    ) from exc
                if (
                    current_updated_dt.tzinfo is None
                    or current_updated_dt.utcoffset() is None
                ):
                    raise RegistryError("current execution timestamp is invalid")
                if transition_dt < current_updated_dt:
                    raise InvalidTransition(
                        "transition timestamp predates current execution update"
                    )
                if current.version != expected_version:
                    raise InvalidTransition("stale execution version")
                # This prototype has no provider-specific evidence verifier yet.
                # Fail closed rather than let callers assert success by changing state.
                if target is State.SUCCEEDED:
                    raise InvalidTransition("SUCCEEDED requires verified completion evidence; use complete_with_verified_evidence")
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
