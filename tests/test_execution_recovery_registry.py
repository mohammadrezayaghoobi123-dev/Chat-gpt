"""Regression tests for read-only execution recovery discovery."""
import sqlite3
import tempfile
import threading
import unittest
from unittest.mock import patch
from pathlib import Path

from master_brain.execution_registry import SQLiteExecutionRegistry, State


class RecoveryCandidateTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.registry = SQLiteExecutionRegistry(
            str(Path(self.tmp.name) / "registry.sqlite3"), timeout=0.25
        )

    def reserve(self, key, timestamp):
        return self.registry.reserve(
            key=key, mission_id=f"mission-{key}", contract_digest="contract",
            payload_digest="payload", recorded_at=timestamp,
        )[0]

    def transition(self, record, target, timestamp):
        return self.registry.transition(
            key=record.key, expected_version=record.version,
            target=target, recorded_at=timestamp,
        )

    def test_begin_immediate_retries_only_transient_sqlite_lock_errors(self):
        class FlakyConnection:
            def __init__(self):
                self.calls = 0

            def execute(self, statement):
                self.calls += 1
                if self.calls < 3:
                    error = sqlite3.OperationalError("database is locked")
                    error.sqlite_errorcode = sqlite3.SQLITE_BUSY
                    raise error
                return "transaction-started"

        connection = FlakyConnection()
        with patch("master_brain.execution_registry.time.sleep") as sleep:
            self.registry._begin_immediate_with_retry(connection)
        self.assertEqual(connection.calls, 3)
        self.assertEqual([call.args[0] for call in sleep.call_args_list], [0.01, 0.025])

    def test_begin_immediate_does_not_retry_non_lock_sqlite_errors(self):
        class BrokenConnection:
            def __init__(self):
                self.calls = 0

            def execute(self, statement):
                self.calls += 1
                error = sqlite3.OperationalError("disk I/O error")
                error.sqlite_errorcode = sqlite3.SQLITE_IOERR
                raise error

        connection = BrokenConnection()
        with patch("master_brain.execution_registry.time.sleep") as sleep:
            with self.assertRaisesRegex(sqlite3.OperationalError, "disk I/O error"):
                self.registry._begin_immediate_with_retry(connection)
        self.assertEqual(connection.calls, 1)
        sleep.assert_not_called()

    def test_constructor_rejects_non_persistent_database_paths(self):
        for path in ("", "   ", ":memory:"):
            with self.subTest(path=path):
                with self.assertRaisesRegex(ValueError, "file-backed database path"):
                    SQLiteExecutionRegistry(path)

    def test_constructor_rejects_timeouts_that_overflow_sqlite_busy_timeout(self):
        for timeout in (1e308, 10 ** 1000):
            with self.subTest(timeout_type=type(timeout).__name__):
                with self.assertRaisesRegex(ValueError, "timeout"):
                    SQLiteExecutionRegistry(
                        str(Path(self.tmp.name) / "invalid-timeout.sqlite3"),
                        timeout=timeout,
                    )

    def test_lists_only_uncertain_nonterminal_states_without_mutating_them(self):
        pending = self.reserve("pending", "2026-10-12T00:00:00Z")

        running = self.reserve("running", "2026-10-12T00:00:01Z")
        running = self.transition(running, State.RUNNING, "2026-10-12T00:00:02Z")

        unknown = self.reserve("unknown", "2026-10-12T00:00:03Z")
        unknown = self.transition(unknown, State.RUNNING, "2026-10-12T00:00:04Z")
        unknown = self.transition(unknown, State.OUTCOME_UNKNOWN, "2026-10-12T00:00:05Z")

        reconciliation = self.reserve("reconciliation", "2026-10-12T00:00:06Z")
        reconciliation = self.transition(reconciliation, State.RUNNING, "2026-10-12T00:00:07Z")
        reconciliation = self.transition(
            reconciliation, State.OUTCOME_UNKNOWN, "2026-10-12T00:00:08Z"
        )
        reconciliation = self.transition(
            reconciliation, State.RECONCILIATION_REQUIRED, "2026-10-12T00:00:09Z"
        )

        failed = self.reserve("failed", "2026-10-12T00:00:10Z")
        failed = self.transition(failed, State.FAILED, "2026-10-12T00:00:11Z")

        before = {key: self.registry.get(key) for key in
                  ("pending", "running", "unknown", "reconciliation", "failed")}
        candidates = self.registry.list_recovery_candidates()
        after = {key: self.registry.get(key) for key in before}

        self.assertEqual(
            {record.key for record in candidates},
            {"running", "unknown", "reconciliation"},
        )
        self.assertEqual(
            [record.key for record in candidates],
            ["running", "unknown", "reconciliation"],
        )
        self.assertEqual(before, after)
        self.assertEqual(self.registry.get(pending.key).state, State.PENDING)
        self.assertEqual(self.registry.get(failed.key).state, State.FAILED)

    def test_corrupt_negative_version_is_rejected_by_record_reader(self):
        from master_brain.execution_registry import RegistryError

        record = self.reserve("corrupt-version", "2026-10-12T00:00:00Z")
        with sqlite3.connect(self.registry.path) as db:
            db.execute("UPDATE executions SET version=-1 WHERE key=?", (record.key,))
        with self.assertRaisesRegex(RegistryError, "invalid registry record"):
            self.registry.get(record.key)

    def test_corrupt_unknown_state_blocks_recovery_inventory(self):
        from master_brain.execution_registry import RegistryError
        self.reserve("valid-running", "2026-10-12T00:00:00Z")
        with sqlite3.connect(self.registry.path) as db:
            db.execute(
                "UPDATE executions SET state='MAGIC_SUCCESS' WHERE key=?",
                ("valid-running",),
            )
        with self.assertRaises(RegistryError):
            self.registry.list_recovery_candidates()


    def test_transition_rejects_boolean_expected_version(self):
        running = self.reserve("boolean-version", "2026-10-12T00:00:00Z")
        running = self.transition(running, State.RUNNING, "2026-10-12T00:00:01Z")
        from master_brain.execution_registry import InvalidTransition

        with self.assertRaisesRegex(ValueError, "expected_version must be a non-negative integer"):
            self.registry.transition(
                key=running.key, expected_version=True,
                target=State.OUTCOME_UNKNOWN, recorded_at="2026-10-12T00:00:02Z",
            )
        self.assertEqual(self.registry.get(running.key), running)

    def test_succeeded_is_blocked_without_verified_evidence_from_uncertain_states(self):
        from master_brain.execution_registry import InvalidTransition

        running = self.reserve("blocked-running", "2026-10-12T00:00:00Z")
        running = self.transition(running, State.RUNNING, "2026-10-12T00:00:01Z")

        unknown = self.reserve("blocked-unknown", "2026-10-12T00:00:02Z")
        unknown = self.transition(unknown, State.RUNNING, "2026-10-12T00:00:03Z")
        unknown = self.transition(unknown, State.OUTCOME_UNKNOWN, "2026-10-12T00:00:04Z")

        reconciliation = self.reserve("blocked-reconciliation", "2026-10-12T00:00:05Z")
        reconciliation = self.transition(
            reconciliation, State.RUNNING, "2026-10-12T00:00:06Z"
        )
        reconciliation = self.transition(
            reconciliation, State.OUTCOME_UNKNOWN, "2026-10-12T00:00:07Z"
        )
        reconciliation = self.transition(
            reconciliation, State.RECONCILIATION_REQUIRED, "2026-10-12T00:00:08Z"
        )

        for record in (running, unknown, reconciliation):
            with self.subTest(key=record.key):
                with self.assertRaisesRegex(
                    InvalidTransition, "verified completion evidence"
                ):
                    self.transition(record, State.SUCCEEDED, "2026-10-12T00:00:09Z")
                self.assertEqual(self.registry.get(record.key), record)

    def test_unverified_failure_transition_is_blocked_after_dispatch_boundary(self):
        from master_brain.execution_registry import InvalidTransition

        running = self.reserve("no-false-failure-running", "2026-10-12T00:00:00Z")
        running = self.transition(running, State.RUNNING, "2026-10-12T00:00:01Z")
        unknown = self.reserve("no-false-failure-reconciliation", "2026-10-12T00:00:02Z")
        unknown = self.transition(unknown, State.RUNNING, "2026-10-12T00:00:03Z")
        unknown = self.transition(unknown, State.OUTCOME_UNKNOWN, "2026-10-12T00:00:04Z")
        unknown = self.transition(unknown, State.RECONCILIATION_REQUIRED, "2026-10-12T00:00:05Z")

        for record in (running, unknown):
            with self.subTest(key=record.key):
                with self.assertRaises(InvalidTransition):
                    self.transition(record, State.FAILED, "2026-10-12T00:00:06Z")
                self.assertEqual(self.registry.get(record.key), record)

    def test_concurrent_identical_reservations_create_exactly_one_record(self):
        barrier = threading.Barrier(2)
        results = []
        errors = []

        def reserve_from_thread():
            try:
                barrier.wait(timeout=2)
                results.append(self.registry.reserve(
                    key="concurrent-key",
                    mission_id="mission-concurrent",
                    contract_digest="contract",
                    payload_digest="payload",
                    recorded_at="2026-10-12T00:00:10Z",
                ))
            except Exception as exc:
                errors.append(exc)

        workers = [
            threading.Thread(target=reserve_from_thread),
            threading.Thread(target=reserve_from_thread),
        ]
        for worker in workers:
            worker.start()
        for worker in workers:
            worker.join(timeout=5)

        self.assertTrue(all(not worker.is_alive() for worker in workers))
        if errors:
            details = [
                {
                    "type": type(exc).__name__,
                    "message": str(exc),
                    "cause_type": type(exc.__cause__).__name__ if exc.__cause__ else None,
                    "cause_message": str(exc.__cause__) if exc.__cause__ else None,
                    "sqlite_errorcode": getattr(exc.__cause__, "sqlite_errorcode", None),
                    "sqlite_errorname": getattr(exc.__cause__, "sqlite_errorname", None),
                }
                for exc in errors
            ]
            self.fail(f"concurrent reservation errors (including chained SQLite causes): {details!r}")
        self.assertEqual(len(results), 2)
        self.assertEqual(sum(1 for _, created in results if created), 1)
        self.assertEqual(sum(1 for _, created in results if not created), 1)
        self.assertEqual(self.registry.get("concurrent-key").version, 0)
        self.assertEqual(self.registry.get("concurrent-key").state, State.PENDING)


    def test_concurrent_reservations_across_registry_instances_are_idempotent(self):
        # Separate instances model independent callers sharing the same SQLite file.
        path = str(Path(self.tmp.name) / "shared-registry.sqlite3")
        registries = [SQLiteExecutionRegistry(path, timeout=2.0) for _ in range(8)]
        barrier = threading.Barrier(len(registries))
        results = []
        errors = []
        lock = threading.Lock()

        def reserve_from_instance(registry):
            try:
                barrier.wait(timeout=3)
                result = registry.reserve(
                    key="shared-concurrent-key",
                    mission_id="mission-shared",
                    contract_digest="contract",
                    payload_digest="payload",
                    recorded_at="2026-10-12T00:00:10Z",
                )
                with lock:
                    results.append(result)
            except Exception as exc:
                with lock:
                    errors.append(exc)

        workers = [
            threading.Thread(target=reserve_from_instance, args=(registry,))
            for registry in registries
        ]
        for worker in workers:
            worker.start()
        for worker in workers:
            worker.join(timeout=5)

        self.assertTrue(all(not worker.is_alive() for worker in workers))
        self.assertEqual(errors, [])
        self.assertEqual(len(results), len(registries))
        self.assertEqual(sum(1 for _, created in results if created), 1)
        self.assertEqual(sum(1 for _, created in results if not created), len(registries) - 1)
        self.assertEqual(registries[0].get("shared-concurrent-key").state, State.PENDING)

    def test_same_registry_concurrent_reservations_stress_with_sqlite_cause(self):
        # Reproduce the original 0.25s timeout / shared-instance scenario repeatedly.
        # If SQLite contention escapes the busy timeout, preserve the chained cause.
        for iteration in range(1000):
            barrier = threading.Barrier(2)
            results = []
            errors = []
            lock = threading.Lock()
            key = f"stress-concurrent-{iteration}"

            def reserve_from_thread():
                try:
                    barrier.wait(timeout=2)
                    result = self.registry.reserve(
                        key=key,
                        mission_id=f"mission-{key}",
                        contract_digest="contract",
                        payload_digest="payload",
                        recorded_at="2026-10-12T00:00:10Z",
                    )
                    with lock:
                        results.append(result)
                except Exception as exc:
                    with lock:
                        errors.append(exc)

            workers = [threading.Thread(target=reserve_from_thread) for _ in range(2)]
            for worker in workers:
                worker.start()
            for worker in workers:
                worker.join(timeout=5)

            self.assertTrue(
                all(not worker.is_alive() for worker in workers),
                f"iteration {iteration}: a reservation thread did not finish",
            )
            if errors:
                details = [
                    {
                        "type": type(exc).__name__,
                        "message": str(exc),
                        "cause_type": type(exc.__cause__).__name__ if exc.__cause__ else None,
                        "cause_message": str(exc.__cause__) if exc.__cause__ else None,
                        "sqlite_errorcode": getattr(exc.__cause__, "sqlite_errorcode", None),
                        "sqlite_errorname": getattr(exc.__cause__, "sqlite_errorname", None),
                    }
                    for exc in errors
                ]
                self.fail(f"iteration {iteration}: concurrent reservation errors: {details!r}")
            self.assertEqual(len(results), 2, f"iteration {iteration}")
            self.assertEqual(sum(1 for _, created in results if created), 1, f"iteration {iteration}")
            self.assertEqual(sum(1 for _, created in results if not created), 1, f"iteration {iteration}")
            self.assertEqual(self.registry.get(key).state, State.PENDING)

    def test_concurrent_transitions_use_compare_and_swap_across_instances(self):
        from master_brain.execution_registry import InvalidTransition, RegistryError

        path = str(Path(self.tmp.name) / "shared-transition.sqlite3")
        registries = [SQLiteExecutionRegistry(path, timeout=0.25) for _ in range(6)]
        pending = registries[0].reserve(
            key="transition-race", mission_id="mission-transition-race",
            contract_digest="contract", payload_digest="payload",
            recorded_at="2026-10-12T00:00:00Z",
        )[0]
        barrier = threading.Barrier(len(registries))
        successes = []
        errors = []
        lock = threading.Lock()

        def transition_from_instance(registry):
            try:
                barrier.wait(timeout=3)
                result = registry.transition(
                    key=pending.key, expected_version=pending.version,
                    target=State.RUNNING, recorded_at="2026-10-12T00:00:01Z",
                )
                with lock:
                    successes.append(result)
            except Exception as exc:
                with lock:
                    errors.append(exc)

        workers = [
            threading.Thread(target=transition_from_instance, args=(registry,))
            for registry in registries
        ]
        for worker in workers:
            worker.start()
        for worker in workers:
            worker.join(timeout=5)

        self.assertTrue(all(not worker.is_alive() for worker in workers))
        self.assertEqual(len(successes), 1)
        self.assertEqual(len(errors), len(registries) - 1)
        self.assertTrue(all(isinstance(exc, InvalidTransition) for exc in errors), errors)
        self.assertFalse(any(isinstance(exc, RegistryError) and not isinstance(exc, InvalidTransition)
                             for exc in errors), errors)
        persisted = registries[0].get(pending.key)
        self.assertEqual(persisted.state, State.RUNNING)
        self.assertEqual(persisted.version, pending.version + 1)

    def test_dispatch_boundary_cannot_be_entered_after_execution_becomes_uncertain(self):
        from master_brain.execution_registry import InvalidTransition

        pending = self.reserve("late-dispatch", "2026-10-12T00:00:00Z")
        running = self.transition(pending, State.RUNNING, "2026-10-12T00:00:01Z")
        attempt = self.registry.reserve_attempt(
            key=running.key, expected_version=running.version,
            integration_id="integration", adapter_version="v1",
            provider_id="provider", recorded_at="2026-10-12T00:00:02Z",
        )
        self.transition(running, State.OUTCOME_UNKNOWN, "2026-10-12T00:00:03Z")

        with self.assertRaisesRegex(InvalidTransition, "execution must remain RUNNING"):
            self.registry.mark_attempt_dispatch_boundary(
                attempt_id=attempt.attempt_id, recorded_at="2026-10-12T00:00:04Z"
            )
        self.assertFalse(self.registry.get_attempt(attempt.attempt_id).dispatch_boundary_entered)

    def test_concurrent_attempt_reservation_and_dispatch_mark_are_safe(self):
        from master_brain.execution_registry import InvalidTransition, RegistryError

        path = str(Path(self.tmp.name) / "shared-attempts.sqlite3")
        registries = [SQLiteExecutionRegistry(path, timeout=0.25) for _ in range(6)]
        pending = registries[0].reserve(
            key="attempt-race", mission_id="mission-attempt-race",
            contract_digest="contract", payload_digest="payload",
            recorded_at="2026-10-12T00:00:00Z",
        )[0]
        running = registries[0].transition(
            key=pending.key, expected_version=pending.version,
            target=State.RUNNING, recorded_at="2026-10-12T00:00:01Z",
        )
        barrier = threading.Barrier(len(registries))
        attempts = []
        errors = []
        lock = threading.Lock()

        def reserve_attempt_from_instance(registry):
            try:
                barrier.wait(timeout=3)
                attempt = registry.reserve_attempt(
                    key=running.key, expected_version=running.version,
                    integration_id="integration", adapter_version="v1",
                    provider_id="provider", recorded_at="2026-10-12T00:00:02Z",
                )
                with lock:
                    attempts.append(attempt)
            except Exception as exc:
                with lock:
                    errors.append(exc)

        workers = [
            threading.Thread(target=reserve_attempt_from_instance, args=(registry,))
            for registry in registries
        ]
        for worker in workers:
            worker.start()
        for worker in workers:
            worker.join(timeout=5)

        self.assertTrue(all(not worker.is_alive() for worker in workers))
        self.assertEqual(len(attempts), 1)
        self.assertEqual(len(errors), len(registries) - 1)
        self.assertTrue(all(isinstance(exc, InvalidTransition) for exc in errors), errors)
        self.assertFalse(any(isinstance(exc, RegistryError) and not isinstance(exc, InvalidTransition)
                             for exc in errors), errors)
        attempt_id = attempts[0].attempt_id

        # Concurrent repeated marking is intentionally idempotent.
        barrier = threading.Barrier(len(registries))
        marked = []
        errors = []

        def mark_from_instance(registry):
            try:
                barrier.wait(timeout=3)
                result = registry.mark_attempt_dispatch_boundary(
                    attempt_id=attempt_id, recorded_at="2026-10-12T00:00:03Z"
                )
                with lock:
                    marked.append(result)
            except Exception as exc:
                with lock:
                    errors.append(exc)

        workers = [
            threading.Thread(target=mark_from_instance, args=(registry,))
            for registry in registries
        ]
        for worker in workers:
            worker.start()
        for worker in workers:
            worker.join(timeout=5)

        self.assertTrue(all(not worker.is_alive() for worker in workers))
        self.assertEqual(errors, [])
        self.assertEqual(len(marked), len(registries))
        self.assertTrue(all(item.dispatch_boundary_entered for item in marked))
        persisted_attempt = registries[0].get_attempt(attempt_id)
        self.assertTrue(persisted_attempt.dispatch_boundary_entered)

    def test_empty_registry_returns_empty_candidates(self):
        self.assertEqual(self.registry.list_recovery_candidates(), [])


    def test_attempt_is_durably_reserved_before_dispatch_and_unique(self):
        running = self.reserve("attempt-owner", "2026-10-12T00:00:00Z")
        running = self.transition(running, State.RUNNING, "2026-10-12T00:00:01Z")

        first = self.registry.reserve_attempt(
            key=running.key, expected_version=running.version,
            integration_id="integration-a", adapter_version="v1",
            provider_id="provider-a", recorded_at="2026-10-12T00:00:02Z",
        )
        self.assertTrue(first.attempt_id)
        self.assertEqual(first.key, running.key)
        self.assertEqual(first.attempt_number, 1)
        self.assertFalse(first.dispatch_boundary_entered)

        from master_brain.execution_registry import InvalidTransition
        with self.assertRaisesRegex(InvalidTransition, "reconcile before any retry"):
            self.registry.reserve_attempt(
                key=running.key, expected_version=running.version,
                integration_id="integration-a", adapter_version="v1",
                provider_id="provider-a", recorded_at="2026-10-12T00:00:03Z",
            )
        self.assertFalse(self.registry.get_attempt(first.attempt_id).dispatch_boundary_entered)

    def test_attempt_reservation_rejects_non_running_execution(self):
        from master_brain.execution_registry import InvalidTransition
        pending = self.reserve("attempt-pending", "2026-10-12T00:00:00Z")
        with self.assertRaises(InvalidTransition):
            self.registry.reserve_attempt(
                key=pending.key, expected_version=pending.version,
                integration_id="integration-a", adapter_version="v1",
                provider_id="provider-a", recorded_at="2026-10-12T00:00:01Z",
            )

    def test_dispatch_boundary_marker_is_idempotent_and_version_checked(self):
        running = self.reserve("attempt-boundary", "2026-10-12T00:00:00Z")
        running = self.transition(running, State.RUNNING, "2026-10-12T00:00:01Z")
        attempt = self.registry.reserve_attempt(
            key=running.key, expected_version=running.version,
            integration_id="integration-a", adapter_version="v1",
            provider_id="provider-a", recorded_at="2026-10-12T00:00:02Z",
        )
        marked = self.registry.mark_attempt_dispatch_boundary(
            attempt_id=attempt.attempt_id, recorded_at="2026-10-12T00:00:03Z"
        )
        self.assertTrue(marked.dispatch_boundary_entered)
        repeated = self.registry.mark_attempt_dispatch_boundary(
            attempt_id=attempt.attempt_id, recorded_at="2026-10-12T00:00:04Z"
        )
        self.assertEqual(repeated, marked)


    def _create_legacy_attempt_table(self, db):
        db.execute("""CREATE TABLE execution_attempts (
            attempt_id TEXT PRIMARY KEY,
            execution_key TEXT NOT NULL,
            attempt_number INTEGER NOT NULL,
            integration_id TEXT NOT NULL,
            adapter_version TEXT NOT NULL,
            provider_id TEXT NOT NULL,
            dispatch_boundary_entered INTEGER NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )""")

    def test_legacy_attempt_table_without_duplicates_gets_unique_index(self):
        path = str(Path(self.tmp.name) / "legacy-unique.sqlite3")
        with sqlite3.connect(path) as db:
            self._create_legacy_attempt_table(db)
            db.execute(
                "INSERT INTO execution_attempts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                ("a1", "exec-1", 1, "int", "v1", "provider", 0, "t", "t"),
            )

        SQLiteExecutionRegistry(path)
        with sqlite3.connect(path) as db:
            indexes = db.execute("PRAGMA index_list(execution_attempts)").fetchall()
            unique_indexes = {row[1] for row in indexes if row[2] == 1}
            self.assertIn("idx_attempts_one_per_execution", unique_indexes)
            with self.assertRaises(sqlite3.IntegrityError):
                db.execute(
                    "INSERT INTO execution_attempts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    ("a2", "exec-1", 2, "int", "v1", "provider", 0, "t2", "t2"),
                )

    def test_legacy_duplicate_attempts_fail_closed_and_preserve_rows(self):
        from master_brain.execution_registry import RegistryError

        path = str(Path(self.tmp.name) / "legacy-duplicates.sqlite3")
        with sqlite3.connect(path) as db:
            self._create_legacy_attempt_table(db)
            for attempt_id in ("a1", "a2"):
                db.execute(
                    "INSERT INTO execution_attempts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (attempt_id, "exec-duplicate", 1, "int", "v1", "provider", 0, "t", "t"),
                )

        with self.assertRaisesRegex(RegistryError, "legacy execution_attempts contains duplicate"):
            SQLiteExecutionRegistry(path)
        with sqlite3.connect(path) as db:
            rows = db.execute(
                "SELECT attempt_id FROM execution_attempts ORDER BY attempt_id"
            ).fetchall()
            self.assertEqual(rows, [("a1",), ("a2",)])

if __name__ == "__main__":
    unittest.main()
