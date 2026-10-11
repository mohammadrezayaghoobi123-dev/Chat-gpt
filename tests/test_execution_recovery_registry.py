"""Regression tests for read-only execution recovery discovery."""
import sqlite3
import tempfile
import threading
import unittest
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
        self.assertEqual(errors, [])
        self.assertEqual(len(results), 2)
        self.assertEqual(sum(1 for _, created in results if created), 1)
        self.assertEqual(sum(1 for _, created in results if not created), 1)
        self.assertEqual(self.registry.get("concurrent-key").version, 0)
        self.assertEqual(self.registry.get("concurrent-key").state, State.PENDING)

    def test_empty_registry_returns_empty_candidates(self):
        self.assertEqual(self.registry.list_recovery_candidates(), [])


if __name__ == "__main__":
    unittest.main()
