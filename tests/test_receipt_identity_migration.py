"""Backward-compatibility tests for scoped receipt identity schema migration."""
from __future__ import annotations

import sqlite3
import tempfile
import unittest
from pathlib import Path

from master_brain.execution_registry import SQLiteExecutionRegistry


class ReceiptIdentityMigrationTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp_dir.cleanup)
        self.db_path = str(Path(self.temp_dir.name) / "legacy.sqlite3")

    def _create_legacy_database(self):
        """Create the pre-scope schema and seed a historical successful receipt."""
        with sqlite3.connect(self.db_path) as db:
            db.executescript(
                """
                CREATE TABLE executions (
                    key TEXT PRIMARY KEY,
                    mission_id TEXT NOT NULL,
                    contract_digest TEXT NOT NULL,
                    payload_digest TEXT NOT NULL,
                    state TEXT NOT NULL,
                    version INTEGER NOT NULL,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE TABLE execution_attempts (
                    attempt_id TEXT PRIMARY KEY,
                    execution_key TEXT NOT NULL,
                    attempt_number INTEGER NOT NULL,
                    integration_id TEXT NOT NULL,
                    adapter_version TEXT NOT NULL,
                    provider_id TEXT NOT NULL,
                    dispatch_boundary_entered INTEGER NOT NULL,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE TABLE completion_receipts (
                    execution_key TEXT PRIMARY KEY,
                    attempt_id TEXT NOT NULL UNIQUE,
                    evidence_digest TEXT NOT NULL,
                    verifier_id TEXT NOT NULL,
                    verifier_version TEXT NOT NULL,
                    evidence_type TEXT NOT NULL,
                    observed_at TEXT NOT NULL,
                    recorded_at TEXT NOT NULL
                );
                INSERT INTO executions VALUES (
                    'legacy-exec', 'mission-1', 'contract-digest',
                    'payload-digest', 'SUCCEEDED', 2,
                    '2026-01-01T00:00:00+00:00',
                    '2026-01-01T00:00:02+00:00'
                );
                INSERT INTO execution_attempts VALUES (
                    'legacy-attempt', 'legacy-exec', 1, 'integration-x',
                    'adapter-1', 'provider-x', 1,
                    '2026-01-01T00:00:00+00:00',
                    '2026-01-01T00:00:01+00:00'
                );
                INSERT INTO completion_receipts VALUES (
                    'legacy-exec', 'legacy-attempt', 'evidence-digest',
                    'verifier-x', '1', 'operation-receipt',
                    '2026-01-01T00:00:01+00:00',
                    '2026-01-01T00:00:02+00:00'
                );
                """
            )

    def test_legacy_rows_are_preserved_and_remain_explicitly_unscoped(self):
        self._create_legacy_database()

        SQLiteExecutionRegistry(self.db_path)

        with sqlite3.connect(self.db_path) as db:
            execution = db.execute(
                "SELECT key, state, version FROM executions WHERE key='legacy-exec'"
            ).fetchone()
            attempt = db.execute(
                "SELECT attempt_id, provider_id, provider_scope, receipt_namespace "
                "FROM execution_attempts WHERE attempt_id='legacy-attempt'"
            ).fetchone()
            receipt = db.execute(
                "SELECT execution_key, attempt_id, evidence_digest, provider_id, "
                "provider_scope, receipt_namespace, provider_receipt_id, identity_version "
                "FROM completion_receipts WHERE execution_key='legacy-exec'"
            ).fetchone()

        self.assertEqual(execution, ("legacy-exec", "SUCCEEDED", 2))
        self.assertEqual(
            attempt,
            ("legacy-attempt", "provider-x", None, None),
        )
        self.assertEqual(
            receipt,
            (
                "legacy-exec", "legacy-attempt", "evidence-digest",
                None, None, None, None, None,
            ),
        )

    def test_migration_is_idempotent(self):
        self._create_legacy_database()

        SQLiteExecutionRegistry(self.db_path)
        SQLiteExecutionRegistry(self.db_path)

        with sqlite3.connect(self.db_path) as db:
            receipt_count = db.execute(
                "SELECT COUNT(*) FROM completion_receipts"
            ).fetchone()[0]
            attempt_count = db.execute(
                "SELECT COUNT(*) FROM execution_attempts"
            ).fetchone()[0]
            identity_index = db.execute(
                "SELECT sql FROM sqlite_master WHERE type='index' "
                "AND name='idx_completion_receipts_scoped_identity'"
            ).fetchone()

        self.assertEqual(receipt_count, 1)
        self.assertEqual(attempt_count, 1)
        self.assertIsNotNone(identity_index)
        self.assertIn("WHERE provider_id IS NOT NULL", identity_index[0])


if __name__ == "__main__":
    unittest.main()
