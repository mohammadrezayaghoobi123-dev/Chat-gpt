"""Additional migration and concurrency tests for execution attempts."""
import sqlite3
import tempfile
import threading
import unittest
from pathlib import Path

from master_brain.execution_registry import (
    InvalidTransition,
    SQLiteExecutionRegistry,
    State,
)


class AttemptSchemaMigrationExtraTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = str(Path(self.tmp.name) / "registry.sqlite3")
        self.registry = SQLiteExecutionRegistry(self.path)

    def test_reopening_migrated_database_is_idempotent(self):
        SQLiteExecutionRegistry(self.path)
        SQLiteExecutionRegistry(self.path)
        with sqlite3.connect(self.path) as db:
            indexes = db.execute("PRAGMA index_list(execution_attempts)").fetchall()
        self.assertEqual(
            sum(1 for row in indexes if row[1] == "idx_attempts_one_per_execution"),
            1,
        )

    def test_concurrent_attempt_reservations_commit_at_most_one_attempt(self):
        record, _ = self.registry.reserve(
            key="concurrent-attempt",
            mission_id="mission-concurrent-attempt",
            contract_digest="contract",
            payload_digest="payload",
            recorded_at="2026-10-12T00:00:00Z",
        )
        running = self.registry.transition(
            key=record.key,
            expected_version=record.version,
            target=State.RUNNING,
            recorded_at="2026-10-12T00:00:01Z",
        )
        barrier = threading.Barrier(2)
        successes = []
        errors = []

        def reserve_attempt():
            try:
                barrier.wait(timeout=2)
                successes.append(self.registry.reserve_attempt(
                    key=running.key,
                    expected_version=running.version,
                    integration_id="integration-a",
                    adapter_version="v1",
                    provider_id="provider-a",
                    recorded_at="2026-10-12T00:00:02Z",
                ))
            except (InvalidTransition, Exception) as exc:
                errors.append(exc)

        workers = [threading.Thread(target=reserve_attempt) for _ in range(2)]
        for worker in workers:
            worker.start()
        for worker in workers:
            worker.join(timeout=5)

        self.assertTrue(all(not worker.is_alive() for worker in workers))
        self.assertEqual(len(successes), 1)
        self.assertEqual(len(errors), 1)
        with sqlite3.connect(self.path) as db:
            count = db.execute(
                "SELECT COUNT(*) FROM execution_attempts WHERE execution_key=?",
                (running.key,),
            ).fetchone()[0]
        self.assertEqual(count, 1)


if __name__ == "__main__":
    unittest.main()
