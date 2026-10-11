import tempfile
import unittest
from pathlib import Path

from master_brain.audit_store import AuditStore
from master_brain.evidence_protocol import (
    ClaimRecord, EvidencePolarity, EvidenceRecord, ProtocolPolicy, SourceKind,
)
from master_brain.falsification_engine import (
    FalsificationPlan, RivalHypothesis, TestObservation, review_falsification_plan,
)
from master_brain.falsification_audit import (
    falsification_review_payload, record_falsification_review,
    run_and_record_falsification_review,
)


class FalsificationAuditTests(unittest.TestCase):
    def setUp(self):
        self.claim = ClaimRecord(
            "claim-1", "The device meets its throughput target",
            operational_definition="At least 100 accepted units in one hour",
        )
        self.plan = FalsificationPlan(
            claim=self.claim,
            rival_hypotheses=(RivalHypothesis("rival-1", "Warm-up distorts throughput"),),
            disconfirmation_criteria=("A verified run below 100 accepted units",),
            test_ids=("test-1", "test-2"),
        )
        self.policy = ProtocolPolicy(
            minimum_effective_weight=0.6,
            minimum_independent_groups=2,
            current_time="2026-10-11T12:00:00Z",
        )
        self.evidence = [
            EvidenceRecord(
                evidence_id="support-1", claim_id="claim-1",
                source_uri_or_reference="machine-log", source_group="machine-log",
                source_kind=SourceKind.PRIMARY, polarity=EvidencePolarity.SUPPORTS,
                reliability=1, relevance=1, is_directly_verified=True,
            ),
            EvidenceRecord(
                evidence_id="counter-1", claim_id="claim-1",
                source_uri_or_reference="independent-inspector", source_group="inspector",
                source_kind=SourceKind.PRIMARY, polarity=EvidencePolarity.COUNTERS,
                reliability=1, relevance=1, is_directly_verified=True,
            ),
        ]
        self.review = review_falsification_plan(
            self.plan,
            [
                TestObservation("test-1", True, "pass", "Machine log: 103 units", ("support-1",)),
                TestObservation("test-2", True, "contradiction", "Independent count: 72 units", ("counter-1",)),
            ],
            self.evidence,
            self.policy,
        )

    def test_payload_preserves_counterevidence_tests_and_provisionality(self):
        payload = falsification_review_payload(self.review)
        self.assertFalse(payload["truth_established"])
        self.assertEqual(payload["counterexample_evidence_ids"], ["counter-1"])
        self.assertEqual(payload["evidence_assessment"]["counterevidence_ids"], ["counter-1"])
        self.assertEqual(payload["tests"]["executed"][1]["observed_result"], "Independent count: 72 units")
        self.assertEqual(payload["rival_hypothesis_ids"], ["rival-1"])
        counter_record = next(
            item for item in payload["evidence_records"]
            if item["evidence_id"] == "counter-1"
        )
        self.assertEqual(counter_record["source_uri_or_reference"], "independent-inspector")
        self.assertEqual(counter_record["polarity"], "counters")
        self.assertTrue(counter_record["attached_to_executed_test"])

    def test_audit_preserves_raw_and_normalized_unknown_outcome(self):
        raw_outcome = "operator_says_probably_ok"
        review = review_falsification_plan(
            self.plan,
            [
                TestObservation("test-1", True, raw_outcome, "Unmapped runner status"),
                TestObservation("test-2", True, "pass", "Machine log: 103 units"),
            ],
            self.evidence,
            self.policy,
        )
        payload = falsification_review_payload(review)
        self.assertEqual(payload["outcome_mapping_version"], "1.0")
        recorded = next(item for item in payload["tests"]["executed"] if item["test_id"] == "test-1")
        self.assertEqual(recorded["outcome"], raw_outcome)
        self.assertEqual(recorded["outcome_kind"], "unknown")
        self.assertEqual(recorded["outcome_mapping_version"], "1.0")
        self.assertEqual(review.status.value, "tests_incomplete")
        self.assertFalse(review.truth_established)

    def test_decision_change_requires_explanation(self):
        with self.assertRaisesRegex(ValueError, "decision_change_reason is required"):
            falsification_review_payload(
                self.review, previous_decision="survived_tests_provisionally"
            )
        payload = falsification_review_payload(
            self.review,
            previous_decision="survived_tests_provisionally",
            decision_change_reason="Independent measurement found a repeatable shortfall",
        )
        self.assertTrue(payload["decision_changed"])
        self.assertEqual(
            payload["decision_change_reason"],
            "Independent measurement found a repeatable shortfall",
        )


    def test_end_to_end_operation_reviews_then_persists(self):
        with tempfile.TemporaryDirectory() as directory:
            store = AuditStore(Path(directory) / "events.jsonl")
            review, event = run_and_record_falsification_review(
                store,
                self.plan,
                [
                    TestObservation("test-1", True, "pass", "Machine log: 103 units", ("support-1",)),
                    TestObservation("test-2", True, "contradiction", "Independent count: 72 units", ("counter-1",)),
                ],
                self.evidence,
                event_id="audit-e2e",
                recorded_at="2026-10-11T12:45:00Z",
                actor="master-brain-test",
                policy=self.policy,
            )
            self.assertEqual(review.status.value, event.payload["status"])
            self.assertEqual(len(store.read_all()), 1)
            counter_record = next(
                item for item in event.payload["evidence_records"]
                if item["evidence_id"] == "counter-1"
            )
            self.assertEqual(counter_record["polarity"], "counters")

    def test_review_is_appended_and_survives_reload(self):
        with tempfile.TemporaryDirectory() as directory:
            store = AuditStore(Path(directory) / "events.jsonl")
            event = record_falsification_review(
                store, self.review,
                event_id="audit-1",
                recorded_at="2026-10-11T12:30:00Z",
                actor="master-brain-test",
                previous_decision="survived_tests_provisionally",
                decision_change_reason="Independent measurement found a repeatable shortfall",
            )
            loaded = store.read_all()
            self.assertEqual(len(loaded), 1)
            self.assertEqual(loaded[0].event_hash, event.event_hash)
            self.assertEqual(loaded[0].event_type, "falsification.reviewed")
            self.assertEqual(loaded[0].subject_ref, "claim:claim-1")
            self.assertEqual(loaded[0].payload["status"], self.review.status.value)
            self.assertTrue(loaded[0].payload["decision_changed"])
            self.assertEqual(
                loaded[0].payload["counterexample_evidence_ids"], ["counter-1"]
            )


if __name__ == "__main__":
    unittest.main()
