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
        self.store = AuditStore(self.path, strict_event_types=False)
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
        default = AuditStore(Path(self.tmp.name) / "s.jsonl")  # secure by default
        self.assertTrue(default.strict_event_types)
        with self.assertRaisesRegex(AuditStoreError, "not registered"):
            self.append({"a": 1}, event_type="made.up", store=default)
        self.assertFalse(Path(self.tmp.name, "s.jsonl").exists())

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


EXPECTED_ALLOW_LIST = {
    "audit.tail_recovered": {"discarded_bytes", "complete_events", "fragment_sha256"},
    "security.login_succeeded": {"address"},
    "security.login_failed": {"address", "reason"},
    "security.login_throttled": {"address", "scope"},
    "security.logout": {"address"},
    "security.account_changed": {"change", "roles"},
    "security.events_suppressed": {"count", "window_seconds"},
    "mission.approval_granted": {
        "approval_schema_version", "decision", "mission_id", "contract_schema_version",
        "contract_digest", "approver_subject", "authentication_method", "scope",
        "identity_verified_by_this_module", "action_digest", "expires_at",
        "signature", "signing_key_id", "signature_alg"},
    "mission.approval_challenged": {
        "mission_id", "contract_digest", "approval_event_id", "signing_key_id",
        "signature_alg", "expires_at", "action_digest"},
    "mission.contract_registered": {
        "mission_id", "contract_schema_version", "contract_digest", "contract"},
    "mission.result_recorded": {
        "mission_id", "attempt_id", "integration_id", "output_digest", "output"},
    "mission.dispatch_reconciled": {
        "mission_id", "attempt_id", "resolution", "evidence_ref"},
    "mission.dispatch_started": {
        "mission_id", "contract_digest", "integration_id", "attempt_id", "approval_event_id",
        "estimated_cost"},  # reviewed 2026-10-24: the exact per-attempt charge the budget gate sums
    "mission.dispatch_finished": {
        "mission_id", "integration_id", "attempt_id", "dispatch_status", "reason",
        "external_effect_confirmed"},
    "falsification.reviewed": {
        "schema_version", "outcome_mapping_version", "claim_id", "mission_context", "status",
        "previous_decision", "decision_changed", "decision_change_reason", "truth_established",
        "evidence_assessment", "tests", "rival_hypothesis_ids", "disconfirmation_criteria",
        "counterexample_evidence_ids", "evidence_records", "reasons"},
}
SENSITIVE_PARTS = ("apikey", "secret", "password", "passwd", "authorization", "credential",
                   "privatekey", "accesstoken", "refreshtoken", "bearer", "cookie", "sessiontoken")
SENSITIVE_EXACT = ("token", "auth", "pwd", "pass", "sessionid", "jwt")
# (label, minimal secret, same shape one character short)
VALUE_BOUNDARIES = (
    ("bearer", "Bearer " + "a" * 16, "Bearer " + "a" * 15),
    ("sk", "sk-" + "a" * 16, "sk-" + "a" * 15),
    ("ghp", "ghp_" + "a" * 30, "ghp_" + "a" * 29),
    ("github_pat", "github_pat_" + "a" * 20, "github_pat_" + "a" * 19),
    ("akia", "AKIA" + "A" * 16, "AKIA" + "A" * 15),
    ("asia", "ASIA" + "A" * 16, "ASIA" + "A" * 15),
    ("slack", "xoxb-" + "1" * 10, "xoxb-" + "1" * 9),
    ("google", "AIza" + "a" * 35, "AIza" + "a" * 34),
    ("jwt", "eyJ" + "a" * 8 + "." + "b" * 8 + "." + "c" * 4, "eyJ" + "a" * 7 + "." + "b" * 8 + "." + "c" * 4),
    ("jwt2", "eyJ" + "a" * 8 + "." + "b" * 8 + "." + "c" * 4, "eyJ" + "a" * 8 + "." + "b" * 7 + "." + "c" * 4),
    ("jwt3", "eyJ" + "a" * 8 + "." + "b" * 8 + "." + "c" * 4, "eyJ" + "a" * 8 + "." + "b" * 8 + "." + "c" * 3),
    ("url", "https://user:pw@host/x", "https://host/x"),
    ("pem", "-----BEGIN RSA PRIVATE KEY-----", "-----BEGIN PUBLIC KEY-----"),
)


class AuditPolicyMutationHardeningTests(unittest.TestCase):
    """Pins each policy element so removing or weakening one is detected (mutation testing)."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.store = AuditStore(Path(self.tmp.name) / "a.jsonl", strict_event_types=False)
        self.n = 0

    def append(self, payload, event_type="unit.test"):
        self.n += 1
        return self.store.append(event_id=f"e-{self.n}", event_type=event_type,
                                 recorded_at="2026-10-12T00:00:00Z", actor="a",
                                 subject_ref="s", payload=payload)

    def test_registry_equals_reviewed_expectation(self):
        self.assertEqual({k: set(v) for k, v in PAYLOAD_KEY_ALLOWLIST.items()}, EXPECTED_ALLOW_LIST)

    def test_every_allowed_key_is_accepted_and_an_extra_key_is_not(self):
        for event_type, keys in EXPECTED_ALLOW_LIST.items():
            for key in sorted(keys):
                with self.subTest(event_type=event_type, key=key):
                    self.append({key: 1}, event_type)
            with self.subTest(event_type=event_type, extra=True), self.assertRaises(AuditPayloadError):
                self.append({"zz_unlisted": 1}, event_type)

    def test_every_sensitive_key_part_is_rejected(self):
        for part in SENSITIVE_PARTS:
            with self.subTest(part=part), self.assertRaises(AuditPayloadError):
                self.append({f"x_{part}_v": 1})

    def test_exact_sensitive_keys_are_rejected_but_lookalikes_are_not(self):
        for key in SENSITIVE_EXACT:
            with self.subTest(key=key), self.assertRaises(AuditPayloadError):
                self.append({key: 1})
        for ok in ("author", "passenger", "compass", "tokens_used", "authentication_method", "jwtless"):
            with self.subTest(ok=ok):
                self.append({ok: 1})

    def test_every_value_pattern_triggers_at_minimum_length_and_not_one_short(self):
        for label, secret, short in VALUE_BOUNDARIES:
            with self.subTest(label=label, case="secret"), self.assertRaises(AuditPayloadError):
                self.append({"note": secret})
            with self.subTest(label=label, case="short"):
                self.append({"note": short})

    def test_nesting_depth_boundary(self):
        def nest(levels):
            value = "leaf"
            for _ in range(levels):
                value = [value]
            return {"a": value}
        self.append(nest(39))
        with self.assertRaisesRegex(AuditPayloadError, "too deep"):
            self.append(nest(40))

    def test_cyclic_payloads_are_rejected_cleanly(self):
        loop = {}
        loop["self"] = loop
        with self.assertRaisesRegex(AuditPayloadError, "cyclic"):
            self.append(loop)
        ring = []
        ring.append(ring)
        with self.assertRaisesRegex(AuditPayloadError, "cyclic"):
            self.append({"ring": ring})

    def test_shared_non_cyclic_reference_is_accepted(self):
        shared = [1, 2]
        self.append({"a": shared, "b": shared})

    def test_non_string_keys_and_non_mapping_payloads_are_rejected(self):
        with self.assertRaisesRegex(AuditPayloadError, "keys must be strings"):
            self.append({1: "x"})
        for bad in (["x"], "x", None, 5):
            with self.subTest(bad=bad), self.assertRaisesRegex(AuditPayloadError, "mapping"):
                self.append(bad)

    def test_tuples_are_scanned_and_secret_in_a_key_name_is_rejected(self):
        with self.assertRaises(AuditPayloadError):
            self.append({"t": ("ghp_" + "a" * 30,)})
        with self.assertRaisesRegex(AuditPayloadError, "<key>"):
            self.append({"ghp_" + "a" * 30: 1})

    def test_policy_function_is_strict_by_default(self):
        from master_brain.audit_policy import AuditPayloadRejected, enforce_payload_policy
        with self.assertRaisesRegex(AuditPayloadRejected, "not registered"):
            enforce_payload_policy("made.up", {})
        enforce_payload_policy("made.up", {}, strict_event_types=False)

    def test_store_applies_policy_before_writing(self):
        before = self.store.path.exists()
        with self.assertRaises(AuditPayloadError):
            self.append({"api_key": "x"})
        self.assertEqual(self.store.path.exists(), before)

    def test_action_bound_pipeline_payloads_fit_the_allow_list(self):
        """Drift guard for the action-bound / single-use path (action_digest, approval_event_id)."""
        from master_brain.mission_approval import action_digest, record_mission_approval
        from tests.test_mission_execution import PipelineFixture, Adapter
        from tests.approval_expiry_helper import soon
        fixture = PipelineFixture("run")
        fixture.setUp()
        try:
            receipt = record_mission_approval(
                fixture.store, fixture.contract, event_id="approval-guard",
                recorded_at="2026-10-12T00:00:00Z", approver_subject="user:reviewer",
                authentication_method="upstream-session",
                action_digest=action_digest("test-model", fixture.payload), expires_at=soon())
            fixture.execute(Adapter(), receipt)
            events = fixture.store.read_all()
        finally:
            fixture.doCleanups()
        keys_seen = set()
        for event in events:
            self.assertLessEqual(set(event.payload), PAYLOAD_KEY_ALLOWLIST[event.event_type])
            keys_seen |= set(event.payload)
        self.assertLessEqual({"action_digest", "approval_event_id"}, keys_seen)


if __name__ == "__main__":
    unittest.main()
