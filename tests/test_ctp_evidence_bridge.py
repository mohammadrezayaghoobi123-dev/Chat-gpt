import unittest

from master_brain.ctp import (
    CTPCase, DiscriminatingTest, Falsifier, RivalHypothesis, TestStatus,
)
from master_brain.ctp_evidence_bridge import review_ctp_evidence
from master_brain.evidence_protocol import (
    ClaimRecord, EvidencePolarity, EvidenceRecord, ProtocolPolicy, ReviewStatus, SourceKind,
)


class CTPEvidenceBridgeTests(unittest.TestCase):
    def setUp(self):
        self.claim_a = ClaimRecord("claim-a", "Capacity reaches 1,000 kg per day")
        self.claim_b = ClaimRecord("claim-b", "Capacity is limited to 700 kg per day")
        self.claims = {"claim-a": self.claim_a, "claim-b": self.claim_b}
        self.policy = ProtocolPolicy(
            minimum_effective_weight=0.6,
            minimum_independent_groups=2,
            current_time="2026-10-11T12:00:00Z",
        )

    def case(self, status=TestStatus.NOT_RUN, result="", evidence_ids=()):
        return CTPCase(
            case_id="ctp-capacity",
            question="Which capacity claim is supported by a controlled run?",
            claim_ids=("claim-a", "claim-b"),
            hypotheses=(
                RivalHypothesis("h-a", "Sustained capacity is 1,000 kg/day"),
                RivalHypothesis("h-b", "Sustained capacity is 700 kg/day"),
            ),
            falsifiers=(
                Falsifier("h-a", "Repeated controlled runs fail to reach 1,000 kg/day"),
                Falsifier("h-b", "Repeated controlled runs sustain 1,000 kg/day"),
            ),
            tests=(
                DiscriminatingTest(
                    "test-run-1", "Measure a full shift",
                    "Record good output, rejects, and downtime for a defined full shift",
                    (("h-a", "At least 1,000 kg/day"), ("h-b", "Near 700 kg/day")),
                    status=status, observed_result=result, evidence_ids=evidence_ids,
                ),
            ),
        )

    def evidence(self, evidence_id, claim_id, source_group, polarity=EvidencePolarity.SUPPORTS):
        return EvidenceRecord(
            evidence_id=evidence_id,
            claim_id=claim_id,
            source_uri_or_reference=f"ref:{evidence_id}",
            source_group=source_group,
            source_kind=SourceKind.PRIMARY,
            polarity=polarity,
            relevance=1.0,
            reliability=1.0,
            observed_at="2026-10-11T10:00:00Z",
            is_directly_verified=True,
        )

    def test_not_run_test_cannot_supply_evidence_to_claim_assessment(self):
        case = self.case(evidence_ids=("e1",))
        review = review_ctp_evidence(
            case, self.claims, [self.evidence("e1", "claim-a", "inspection")]
        )
        self.assertTrue(any("NOT_RUN" in issue for issue in review.structural_issues))
        self.assertEqual(review.claim_assessments[0].status, ReviewStatus.UNVERIFIED)
        self.assertFalse(review.truth_established)
        self.assertFalse(review.ready_for_human_review)

    def test_missing_evidence_reference_is_reported(self):
        case = self.case(TestStatus.PASS, "Observed 1,020 kg/day", ("missing-e",))
        review = review_ctp_evidence(case, self.claims, [])
        self.assertEqual(review.missing_evidence_ids, ("missing-e",))
        self.assertFalse(review.ready_for_human_review)

    def test_executed_evidence_is_assessed_but_not_called_proof(self):
        case = self.case(TestStatus.PASS, "Observed 1,020 kg/day", ("e1", "e2"))
        records = [
            self.evidence("e1", "claim-a", "calibrated-scale-log"),
            self.evidence("e2", "claim-a", "independent-witness"),
        ]
        review = review_ctp_evidence(case, self.claims, records, self.policy)
        self.assertEqual(review.claim_assessments[0].status, ReviewStatus.PROVISIONALLY_SUPPORTED)
        self.assertFalse(review.truth_established)
        self.assertFalse(review.claim_assessments[0].truth_established)
        self.assertEqual(review.unresolved_test_ids, ())

    def test_evidence_for_claim_outside_case_is_orphaned(self):
        case = self.case(TestStatus.PASS, "Observed result", ("e1",))
        wrong = self.evidence("e1", "claim-outside-case", "source")
        review = review_ctp_evidence(case, self.claims, [wrong])
        self.assertEqual(review.orphan_evidence_ids, ("e1",))
        self.assertTrue(any("outside CTP case" in issue for issue in review.structural_issues))

    def test_unresolved_test_is_preserved(self):
        review = review_ctp_evidence(self.case(), self.claims, [])
        self.assertEqual(review.unresolved_test_ids, ("test-run-1",))
        self.assertFalse(review.ready_for_human_review)

    def test_duplicate_evidence_ids_are_reported(self):
        case = self.case(TestStatus.PASS, "Observed result", ("e1",))
        record = self.evidence("e1", "claim-a", "source")
        review = review_ctp_evidence(case, self.claims, [record, record])
        self.assertTrue(any("duplicate evidence IDs" in issue for issue in review.structural_issues))

    def test_missing_claim_record_is_reported(self):
        case = self.case()
        review = review_ctp_evidence(case, {"claim-a": self.claim_a}, [])
        self.assertEqual(review.missing_claim_ids, ("claim-b",))


if __name__ == "__main__":
    unittest.main()
