import json
import unittest

from master_brain.audit import AuditRecord, AuditValidationError


class AuditRecordTests(unittest.TestCase):
    def make_record(self, **overrides):
        values = {
            "event_id": "evt-001",
            "event_type": "claim_review",
            "occurred_at": "2026-10-12T09:30:00Z",
            "component": "proof_plane",
            "status": "completed",
            "input_refs": ("claim-1",),
            "output_refs": ("decision-1",),
            "metadata": {"risk_tier": "medium", "count": 2, "label": "آزمون"},
        }
        values.update(overrides)
        return AuditRecord(**values)

    def test_stable_json_is_deterministic_and_unicode_safe(self):
        first = self.make_record().to_stable_json()
        second = self.make_record().to_stable_json()
        self.assertEqual(first, second)
        self.assertIn("آزمون", first)
        self.assertEqual(json.loads(first)["input_refs"], ["claim-1"])

    def test_rejects_missing_required_text(self):
        with self.assertRaisesRegex(AuditValidationError, "event_id"):
            self.make_record(event_id=" ")

    def test_rejects_timestamp_without_timezone(self):
        with self.assertRaisesRegex(AuditValidationError, "timezone"):
            self.make_record(occurred_at="2026-10-12T09:30:00")

    def test_rejects_secret_like_metadata_keys_recursively(self):
        with self.assertRaisesRegex(AuditValidationError, "sensitive field"):
            self.make_record(metadata={"integration": {"api_key": "must-not-be-logged"}})

    def test_rejects_non_json_and_non_finite_metadata(self):
        with self.assertRaisesRegex(AuditValidationError, "JSON-compatible"):
            self.make_record(metadata={"score": float("nan")})

    def test_rejects_blank_references(self):
        with self.assertRaisesRegex(AuditValidationError, "entries"):
            self.make_record(input_refs=("claim-1", " "))

    def test_rejects_unsupported_schema_version(self):
        with self.assertRaisesRegex(AuditValidationError, "schema_version"):
            self.make_record(schema_version=2)


if __name__ == "__main__":
    unittest.main()
