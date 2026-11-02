import unittest

from master_brain.evidence_protocol import (
    ClaimRecord, EvidencePolarity, EvidenceRecord, ProtocolPolicy, SourceKind,
)
from master_brain.falsification_engine import (
    FalsificationPlan, FalsificationStatus, TestObservation,
    review_falsification_plan,
)


class MissingDisconfirmationCriteriaRegressionTests(unittest.TestCase):
    def test_all_passes_cannot_override_missing_disconfirmation_criteria(self):
        claim = ClaimRecord(
            "claim-no-criteria",
            "The prototype can process 100 units per hour",
            operational_definition="Measured output >= 100 units in a 60-minute run",
        )
        plan = FalsificationPlan(
            claim=claim,
            rival_hypotheses=(),
            disconfirmation_criteria=(),
            test_ids=("test-1", "test-2"),
        )
        observations = (
            TestObservation("test-1", True, "pass", "Measured 103 units", ("e1",)),
            TestObservation("test-2", True, "pass", "Measured 101 units", ("e2",)),
        )
        evidence = (
            EvidenceRecord(
                evidence_id="e1", claim_id=claim.claim_id,
                source_uri_or_reference="ref:e1", source_group="machine-log",
                source_kind=SourceKind.PRIMARY, polarity=EvidencePolarity.SUPPORTS,
                reliability=1.0, relevance=1.0, is_directly_verified=True,
            ),
            EvidenceRecord(
                evidence_id="e2", claim_id=claim.claim_id,
                source_uri_or_reference="ref:e2", source_group="independent-inspector",
                source_kind=SourceKind.PRIMARY, polarity=EvidencePolarity.SUPPORTS,
                reliability=1.0, relevance=1.0, is_directly_verified=True,
            ),
        )
        result = review_falsification_plan(
            plan, observations, evidence,
            ProtocolPolicy(
                minimum_effective_weight=0.6,
                minimum_independent_groups=2,
                current_time="2026-10-11T12:00:00Z",
            ),
        )
        self.assertEqual(result.status, FalsificationStatus.NOT_DESIGNED)
        self.assertFalse(result.truth_established)


if __name__ == "__main__":
    unittest.main()
