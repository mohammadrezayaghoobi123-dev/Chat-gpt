import unittest
from dataclasses import replace

from master_brain.audit_ledger import (
    GENESIS_HASH,
    build_chain,
    create_event,
    verify_chain,
)


class AuditLedgerTests(unittest.TestCase):
    def raw_events(self):
        return [
            {
                "event_id": "ev-1",
                "event_type": "claim.created",
                "recorded_at": "2026-10-11T12:00:00Z",
                "actor": "test",
                "subject_ref": "claim:c-1",
                "payload": {"statement": "Capacity is 1 t/day", "revision": 1},
            },
            {
                "event_id": "ev-2",
                "event_type": "evidence.added",
                "recorded_at": "2026-10-11T12:01:00Z",
                "actor": "test",
                "subject_ref": "claim:c-1",
                "payload": {"evidence_id": "e-1", "polarity": "supports"},
            },
        ]

    def test_build_and_verify_chain(self):
        events = build_chain(self.raw_events())
        result = verify_chain(events)
        self.assertTrue(result.valid)
        self.assertEqual(result.checked_events, 2)
        self.assertEqual(events[0].previous_hash, GENESIS_HASH)
        self.assertEqual(events[1].previous_hash, events[0].event_hash)

    def test_payload_tampering_is_detected(self):
        events = build_chain(self.raw_events())
        tampered = (events[0], replace(events[1], payload={"changed": True}))
        result = verify_chain(tampered)
        self.assertFalse(result.valid)
        self.assertEqual(result.failing_event_id, "ev-2")
        self.assertEqual(result.reason, "event_hash_mismatch")

    def test_reordering_is_detected(self):
        events = build_chain(self.raw_events())
        result = verify_chain(tuple(reversed(events)))
        self.assertFalse(result.valid)
        self.assertEqual(result.reason, "previous_hash_mismatch")

    def test_duplicate_event_ids_are_rejected_on_build(self):
        rows = self.raw_events()
        rows[1]["event_id"] = rows[0]["event_id"]
        with self.assertRaises(ValueError):
            build_chain(rows)

    def test_timezone_is_required(self):
        with self.assertRaises(ValueError):
            create_event(
                event_id="ev",
                event_type="test",
                recorded_at="2026-10-11T12:00:00",
                actor="test",
                subject_ref="ref",
                payload={},
            )

    def test_audit_event_rejects_malformed_field_types(self):
        with self.assertRaisesRegex(TypeError, "event_id must be a string"):
            create_event(
                event_id=None,
                event_type="test",
                recorded_at="2026-10-11T12:00:00Z",
                actor="test",
                subject_ref="ref",
                payload={},
            )
        with self.assertRaisesRegex(TypeError, "payload must be a dictionary"):
            create_event(
                event_id="ev",
                event_type="test",
                recorded_at="2026-10-11T12:00:00Z",
                actor="test",
                subject_ref="ref",
                payload=[],
            )

    def test_build_chain_rejects_non_string_identity_fields(self):
        rows = self.raw_events()
        rows[0]["event_id"] = 7
        with self.assertRaisesRegex(TypeError, "event_id must be a string"):
            build_chain(rows)

        rows = self.raw_events()
        rows[0]["actor"] = ["not", "a", "string"]
        with self.assertRaisesRegex(TypeError, "actor must be a string"):
            build_chain(rows)

    def test_non_finite_json_numbers_are_rejected(self):
        with self.assertRaises(ValueError):
            create_event(
                event_id="ev",
                event_type="test",
                recorded_at="2026-10-11T12:00:00Z",
                actor="test",
                subject_ref="ref",
                payload={"score": float("nan")},
            )

    def test_empty_chain_is_valid(self):
        result = verify_chain(())
        self.assertTrue(result.valid)
        self.assertEqual(result.checked_events, 0)


if __name__ == "__main__":
    unittest.main()
