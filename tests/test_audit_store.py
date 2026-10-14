import json
import tempfile
import unittest
from pathlib import Path

from master_brain.audit_store import AuditStore, AuditStoreError


class AuditStoreTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tempdir.cleanup)
        self.path = Path(self.tempdir.name) / "audit" / "events.jsonl"
        self.store = AuditStore(self.path)

    def append(self, event_id, payload=None):
        return self.store.append(
            event_id=event_id,
            event_type="claim.reviewed",
            recorded_at="2026-10-11T12:00:00Z",
            actor="unit-test",
            subject_ref="claim:c-1",
            payload=payload or {"status": "contested"},
        )

    def test_append_and_reload_persist_chain(self):
        first = self.append("e-1")
        second = self.append("e-2", {"status": "provisionally_supported"})
        loaded = self.store.read_all()
        self.assertEqual([event.event_id for event in loaded], ["e-1", "e-2"])
        self.assertEqual(loaded[0].event_hash, first.event_hash)
        self.assertEqual(loaded[1].previous_hash, first.event_hash)
        self.assertEqual(loaded[1].event_hash, second.event_hash)

    def test_missing_store_is_empty(self):
        self.assertEqual(self.store.read_all(), ())

    def test_duplicate_event_id_is_rejected(self):
        self.append("e-1")
        with self.assertRaisesRegex(AuditStoreError, "duplicate event_id"):
            self.append("e-1")

    def test_payload_tampering_fails_closed(self):
        self.append("e-1")
        rows = self.path.read_text(encoding="utf-8").splitlines()
        raw = json.loads(rows[0])
        raw["payload"]["status"] = "rewritten"
        self.path.write_text(json.dumps(raw) + "\n", encoding="utf-8")
        with self.assertRaisesRegex(AuditStoreError, "verification failed"):
            self.store.read_all()
        with self.assertRaises(AuditStoreError):
            self.append("e-2")

    def test_malformed_trailing_record_is_not_silently_repaired(self):
        self.append("e-1")
        with self.path.open("a", encoding="utf-8") as handle:
            handle.write("{broken\n")
        with self.assertRaisesRegex(AuditStoreError, "invalid audit record"):
            self.store.read_all()

    def test_non_object_json_record_fails_closed(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text('["not", "an", "event"]\n', encoding="utf-8")
        with self.assertRaisesRegex(AuditStoreError, "invalid audit record"):
            self.store.read_all()

    def test_record_with_wrong_field_types_fails_closed(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text(
            json.dumps({
                "event_id": 7,
                "event_type": "claim.reviewed",
                "recorded_at": "2026-10-11T12:00:00Z",
                "actor": "unit-test",
                "subject_ref": "claim:c-1",
                "payload": {"status": "contested"},
                "previous_hash": "0" * 64,
                "event_hash": "0" * 64,
            }) + "\n",
            encoding="utf-8",
        )
        with self.assertRaisesRegex(AuditStoreError, "invalid audit record"):
            self.store.read_all()

    def test_blank_lines_are_rejected(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text("\n", encoding="utf-8")
        with self.assertRaisesRegex(AuditStoreError, "blank audit record"):
            self.store.read_all()

    def _append_one(self, store, index):
        store.append(
            event_id=f"concurrent-{index}", event_type="unit_test",
            recorded_at="2026-10-14T00:00:00Z", actor="unit-test",
            subject_ref="claim:c-1", payload={"i": index},
        )

    def test_concurrent_threads_cannot_fork_the_hash_chain(self):
        # Regression for finding AUD (unserialized read-modify-append): before
        # the lock, 8 barrier-synchronized writers corrupted the chain 5/5 runs.
        import threading
        workers = 8
        barrier = threading.Barrier(workers)
        errors = []

        def run(index):
            barrier.wait()
            try:
                self._append_one(self.store, index)
            except Exception as exc:  # pragma: no cover - failure path
                errors.append(exc)

        threads = [threading.Thread(target=run, args=(i,)) for i in range(workers)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        self.assertEqual(errors, [])
        self.assertEqual(len(self.store.read_all()), workers)  # also verifies chain

    def test_concurrent_processes_cannot_fork_the_hash_chain(self):
        import subprocess
        import sys
        code = (
            "import sys; from master_brain.audit_store import AuditStore; "
            "AuditStore(sys.argv[1]).append(event_id=sys.argv[2], event_type='unit_test', "
            "recorded_at='2026-10-14T00:00:00Z', actor='p', subject_ref='s', payload={})"
        )
        env = {**__import__("os").environ, "PYTHONPATH": str(Path(__file__).resolve().parents[1] / "src")}
        procs = [
            subprocess.Popen([sys.executable, "-c", code, str(self.path), f"proc-{i}"], env=env)
            for i in range(6)
        ]
        self.assertEqual([p.wait() for p in procs], [0] * 6)
        self.assertEqual(len(self.store.read_all()), 6)


if __name__ == "__main__":
    unittest.main()
