import tempfile
import unittest
from pathlib import Path

from master_brain.audit_policy import PAYLOAD_KEY_ALLOWLIST
from master_brain.audit_store import AuditPayloadError, AuditStore, AuditStoreError


class AuditPayloadPolicyTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name) / "a.jsonl"
        self.store = AuditStore(self.path)
        self.n = 0

    def append(self, payload, event_type="claim.reviewed", store=None):
        self.n += 1
        return (store or self.store).append(
            event_id=f"e-{self.n}", event_type=event_type, recorded_at="2026-10-12T00:00:00Z",
            actor="a", subject_ref="s", payload=payload,
        )

    def test_secret_keys_are_rejected_anywhere(self):
        for payload in (
            {"api_key": "x"}, {"nested": {"password": "x"}}, {"a": [{"client_secret": "x"}]},
            {"token": "x"}, {"Authorization": "x"}, {"private-key": "x"}, {"Ｓecret": "x"},
        ):
            with self.subTest(payload=payload), self.assertRaises(AuditPayloadError):
                self.append(payload)

    def test_credential_shaped_values_are_rejected(self):
        for value in (
            "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abcdefgh.ijklmnop",
            "use sk-ant-api03-AAAAAAAAAAAAAAAAAAAA now",
            "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
            "github_pat_11AAAAAAAAAAAAAAAAAAAA",
            "-----BEGIN PRIVATE KEY-----\nMIIE",
            "AKIAABCDEFGHIJKLMNOP",
            "xoxb-1234567890-abcdefghij",
            "postgres://user:hunter2@db.example/x",
            "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.sig_abc",
        ):
            with self.subTest(value=value[:20]), self.assertRaises(AuditPayloadError):
                self.append({"note": value})
        with self.assertRaises(AuditPayloadError):
            self.append({"list": ["fine", {"deep": "ghp_abcdefghijklmnopqrstuvwxyz0123456789"}]})

    def test_rejected_payload_writes_nothing(self):
        self.append({"ok": 1})
        before = self.path.read_bytes()
        with self.assertRaises(AuditPayloadError):
            self.append({"api_key": "sk-live-1234567890abcdef"})
        self.assertEqual(self.path.read_bytes(), before)

    def test_benign_payload_and_digests_are_accepted(self):
        self.append({"mission_id": "m-1", "digest": "a" * 64, "reason": "adapter_timeout",
                     "tokens_used": 12, "note": "ordinary sentence about the sky is blue"})

    def test_registered_event_type_rejects_unknown_top_level_key(self):
        with self.assertRaisesRegex(AuditPayloadError, "allow-list"):
            self.append({"mission_id": "m", "integration_id": "i", "attempt_id": "a",
                         "dispatch_status": "ok", "reason": "", "external_effect_confirmed": False,
                         "raw_response": "anything"}, event_type="mission.dispatch_finished")
        self.append({"mission_id": "m", "integration_id": "i", "attempt_id": "a",
                     "dispatch_status": "ok", "reason": "", "external_effect_confirmed": False},
                    event_type="mission.dispatch_finished")

    def test_strict_mode_rejects_unregistered_event_types(self):
        strict = AuditStore(Path(self.tmp.name) / "s.jsonl", strict_event_types=True)
        with self.assertRaisesRegex(AuditStoreError, "not registered"):
            self.append({"a": 1}, event_type="made.up", store=strict)

    def test_allow_list_covers_every_key_production_code_emits(self):
        """Drift guard: real payloads must fit their registered allow-list."""
        from tests.test_mission_execution import PipelineFixture, Adapter  # noqa: F401
        fixture = PipelineFixture("run")
        fixture.setUp()
        try:
            receipt = fixture.approve()
            fixture.execute(Adapter(), receipt)
            events = fixture.store.read_all()
        finally:
            fixture.doCleanups()
        seen = {e.event_type for e in events}
        self.assertTrue({"mission.approval_granted", "mission.dispatch_started",
                         "mission.dispatch_finished"} <= seen)
        for event in events:
            self.assertLessEqual(set(event.payload), PAYLOAD_KEY_ALLOWLIST[event.event_type])


if __name__ == "__main__":
    unittest.main()
