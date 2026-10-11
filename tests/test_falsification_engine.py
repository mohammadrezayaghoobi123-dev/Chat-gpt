import unittest

from master_brain.evidence_protocol import (
    ClaimRecord, EvidencePolarity, EvidenceRecord, ProtocolPolicy,
    ReviewStatus, SourceKind,
)
from master_brain.falsification_engine import (
    FalsificationPlan, FalsificationStatus, RivalHypothesis, TestObservation,
    review_falsification_plan,
)


class FalsificationEngineTests(unittest.TestCase):
    def setUp(self):
        self.claim = ClaimRecord(
            "claim-1", "The prototype can process 100 units per hour",
            operational_definition="Measured output >= 100 units in a 60-minute run",
        )
        self.plan = FalsificationPlan(
            claim=self.claim,
            rival_hypotheses=(
                RivalHypothesis("h-1", "Performance depends on a short warm-up"),
                RivalHypothesis("h-2", "The reported output excludes rejected units"),
            ),
            disconfirmation_criteria=(
                "Any repeatable run below 100 accepted units per hour",
                "Independent measurement differs by more than 5 percent",
            ),
            test_ids=("test-1", "test-2"),
        )
        self.policy = ProtocolPolicy(
            minimum_effective_weight=0.6,
            minimum_independent_groups=2,
            current_time="2026-10-11T12:00:00Z",
        )

    def evidence(self, evidence_id, group, polarity=EvidencePolarity.SUPPORTS,
                 kind=SourceKind.PRIMARY):
        return EvidenceRecord(
            evidence_id=evidence_id, claim_id=self.claim.claim_id,
            source_uri_or_reference=f"ref:{evidence_id}", source_group=group,
            source_kind=kind, polarity=polarity, reliability=1.0, relevance=1.0,
            is_directly_verified=True,
        )

    def test_no_counterexample_does_not_mean_proven(self):
        result = review_falsification_plan(
            self.plan,
            [
                TestObservation("test-1", True, "pass", "Run yielded 103 accepted units", ("e1",)),
                TestObservation("test-2", True, "pass", "Independent run yielded 101 units", ("e2",)),
            ],
            [
                self.evidence("e1", "machine-log"),
                self.evidence("e2", "independent-inspector"),
            ],
            self.policy,
        )
        self.assertEqual(result.status, FalsificationStatus.SURVIVED_TESTS_PROVISIONALLY)
        self.assertFalse(result.truth_established)
        self.assertTrue(any("not proof" in reason for reason in result.reasons))

    def test_counterevidence_keeps_claim_contested(self):
        result = review_falsification_plan(
            self.plan,
            [
                TestObservation("test-1", True, "pass", "Run yielded 103 units", ("e1",)),
                TestObservation("test-2", True, "contradiction", "Independent run yielded 72 units", ("e2",)),
            ],
            [
                self.evidence("e1", "machine-log"),
                self.evidence("e2", "independent-inspector", EvidencePolarity.COUNTERS),
            ],
            self.policy,
        )
        self.assertEqual(result.status, FalsificationStatus.COUNTEREXAMPLE_FOUND)
        self.assertEqual(result.counterexample_evidence_ids, ("e2",))
        self.assertFalse(result.truth_established)

    def test_unexecuted_test_evidence_is_excluded(self):
        result = review_falsification_plan(
            self.plan,
            [
                TestObservation("test-1", False, "not_run", "", ("e1",)),
                TestObservation("test-2", True, "pass", "Run yielded 103 units", ("e2",)),
            ],
            [self.evidence("e1", "unexecuted-test"), self.evidence("e2", "executed-test")],
            self.policy,
        )
        self.assertEqual(result.status, FalsificationStatus.TESTS_INCOMPLETE)
        self.assertEqual(result.evidence_assessment.status, ReviewStatus.INSUFFICIENT_INDEPENDENCE)
        self.assertEqual(result.evidence_assessment.supporting_evidence_ids, ("e2",))

    def test_missing_test_is_not_silently_assumed_passed(self):
        result = review_falsification_plan(
            self.plan,
            [TestObservation("test-1", True, "pass", "Run yielded 103 units")],
            [],
            self.policy,
        )
        self.assertEqual(result.status, FalsificationStatus.TESTS_INCOMPLETE)
        self.assertEqual(result.missing_test_ids, ("test-2",))

    def test_duplicate_observations_are_rejected(self):
        with self.assertRaisesRegex(ValueError, "observation test IDs"):
            review_falsification_plan(
                self.plan,
                [
                    TestObservation("test-1", True, "pass", "result A"),
                    TestObservation("test-1", True, "pass", "result B"),
                ],
                [],
                self.policy,
            )

    def test_duplicate_evidence_ids_are_rejected(self):
        item = self.evidence("e1", "source")
        with self.assertRaisesRegex(ValueError, "evidence IDs"):
            review_falsification_plan(
                self.plan,
                [TestObservation("test-1", True, "pass", "result", ("e1",))],
                [item, item],
                self.policy,
            )

    def test_evidence_for_another_claim_is_rejected(self):
        item = EvidenceRecord(
            evidence_id="wrong", claim_id="other",
            source_uri_or_reference="ref", source_group="source",
            source_kind=SourceKind.PRIMARY, polarity=EvidencePolarity.SUPPORTS,
        )
        with self.assertRaisesRegex(ValueError, "reviewed claim"):
            review_falsification_plan(self.plan, [], [item], self.policy)


if __name__ == "__main__":
    unittest.main()
