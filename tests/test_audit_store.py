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
        self.path.write_text(json.dumps(raw) + "\\n", encoding="utf-8")
        with self.assertRaisesRegex(AuditStoreError, "verification failed"):
            self.store.read_all()
        with self.assertRaises(AuditStoreError):
            self.append("e-2")

    def test_malformed_trailing_record_is_not_silently_repaired(self):
        self.append("e-1")
        with self.path.open("a", encoding="utf-8") as handle:
            handle.write("{broken\\n")
        with self.assertRaisesRegex(AuditStoreError, "invalid audit record"):
            self.store.read_all()

    def test_blank_lines_are_rejected(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text("\\n", encoding="utf-8")
        with self.assertRaisesRegex(AuditStoreError, "blank audit record"):
            self.store.read_all()


if __name__ == "__main__":
    unittest.main()
