import unittest

from master_brain.core import Claim, ClaimImportance, Evidence
from master_brain.ctp import TestStatus
from master_brain.proof_plane import review_proof


class ProofPlaneTests(unittest.TestCase):
    def test_conflict_is_preserved_and_generates_unexecuted_ctp_plan(self):
        claims = (
            Claim("a", "line", "capacity", "1 ton/day", "site", "2026", "output"),
            Claim("b", "line", "capacity", "700 kg/day", "site", "2026", "output"),
        )
        report = review_proof(claims, (
            Evidence("e1", "supplier quote", "a", True, independent_group="supplier"),
            Evidence("e2", "inspection", "b", True, independent_group="inspector"),
        ))
        self.assertEqual(len(report.contradictions), 1)
        self.assertTrue(report.unresolved_issues)

        self.assertEqual(len(report.ctp_cases), 1)
        case = report.ctp_cases[0]
        self.assertEqual(case.claim_ids, ("a", "b"))
        self.assertEqual(len(case.hypotheses), 2)
        self.assertEqual(len(case.falsifiers), 2)
        self.assertEqual(case.validate(), ())
        self.assertEqual(case.tests[0].status, TestStatus.NOT_RUN)
        self.assertEqual(len(case.unresolved_test_ids), 1)
        self.assertFalse(case.has_executed_evidence)
        self.assertIn("has been run", " ".join(case.notes).lower())

    def test_high_importance_claim_gets_ctp_plan_without_a_detected_conflict(self):
        claim = Claim(
            "critical-claim", "reactor", "maximum_temperature", "180 C",
            "production", "2026", "degrees Celsius", importance=ClaimImportance.CRITICAL,
        )
        report = review_proof((claim,), ())

        self.assertEqual(report.contradictions, ())
        self.assertEqual(len(report.ctp_cases), 1)
        case = report.ctp_cases[0]
        self.assertEqual(case.claim_ids, ("critical-claim",))
        self.assertEqual(len(case.hypotheses), 2)
        self.assertEqual(len(case.falsifiers), 2)
        self.assertEqual(case.tests[0].status, TestStatus.NOT_RUN)
        self.assertFalse(case.has_executed_evidence)
        self.assertEqual(case.validate(), ())

    def test_generator_evidence_is_preserved_for_claim_review(self):
        claim = Claim("generator-claim", "plant", "output", "100")
        evidence = (
            Evidence("generator-e1", "source-a", "generator-claim", True, independent_group="group-a"),
            Evidence("generator-e2", "source-b", "generator-claim", True, independent_group="group-b"),
        )

        report = review_proof((claim,), (item for item in evidence))

        self.assertEqual(len(report.claim_reviews), 1)
        self.assertEqual(report.claim_reviews[0].supporting_evidence, ("generator-e1", "generator-e2"))
        self.assertTrue(report.claim_reviews[0].independent_support_demonstrated)

    def test_duplicate_evidence_ids_cannot_manufacture_independent_support(self):
        claim = Claim("duplicate-evidence-claim", "plant", "output", "100")
        evidence = (
            Evidence("duplicate-id", "source-a", "duplicate-evidence-claim", True, independent_group="group-a"),
            Evidence("duplicate-id", "source-b", "duplicate-evidence-claim", True, independent_group="group-b"),
        )

        report = review_proof((claim,), evidence)

        self.assertTrue(any("Duplicate evidence ID" in issue for issue in report.unresolved_issues))
        decision = report.claim_reviews[0]
        self.assertFalse(decision.independent_support_demonstrated)
        self.assertEqual(decision.independent_supporting_group_count, 0)
        self.assertEqual(decision.supporting_evidence, ())

    def test_claim_with_unhashable_importance_is_reported_without_crashing(self):
        claim = Claim("claim-importance", "plant", "output", "100", importance=[])
        report = review_proof((claim,), ())

        self.assertTrue(any("unrecognized importance" in issue.lower()
                            for issue in report.unresolved_issues))
        self.assertEqual(report.ctp_cases, ())

    def test_claim_with_invalid_identifier_is_excluded_safely(self):
        claim = Claim(None, "plant", "output", "100")
        report = review_proof((claim,), ())

        self.assertEqual(report.claim_reviews, ())
        self.assertTrue(any("invalid claim id" in issue.lower()
                            for issue in report.unresolved_issues))

    def test_conflicting_duplicate_claim_ids_are_excluded_from_review(self):
        claims = (
            Claim("ambiguous-claim", "plant", "output", "100"),
            Claim("ambiguous-claim", "plant", "output", "200"),
        )
        evidence = (
            Evidence("ambiguous-evidence", "sensor", "ambiguous-claim", True, independent_group="sensor"),
        )

        report = review_proof(claims, evidence)

        self.assertTrue(any("Duplicate claim ID with different content" in issue
                            for issue in report.unresolved_issues))
        self.assertEqual(report.claim_reviews, ())
        self.assertTrue(any("not linked to a known claim" in issue
                            for issue in report.unresolved_issues))

    def test_non_evidence_objects_are_reported_and_excluded(self):
        from types import SimpleNamespace

        claim = Claim("claim-a", "plant", "output", "100")
        malformed = SimpleNamespace(evidence_id="e-1", claim_id="claim-a")
        report = review_proof((claim,), (malformed,))

        self.assertEqual(report.claim_reviews[0].status, "unverified")
        self.assertTrue(any("invalid evidence record" in issue.lower()
                            for issue in report.unresolved_issues))

    def test_malformed_orphan_evidence_id_is_reported_without_crashing(self):
        report = review_proof((), (Evidence(None, "untrusted source", "unknown", True),))

        self.assertTrue(any("invalid evidence id" in issue.lower()
                            for issue in report.unresolved_issues))
        self.assertTrue(any("not linked to a known claim" in issue.lower()
                            for issue in report.unresolved_issues))
        self.assertEqual(report.claim_reviews, ())

    def test_orphan_evidence_is_reported(self):
        report = review_proof((), (Evidence("e1", "report", "unknown-claim", True),))
        self.assertTrue(report.unresolved_issues)
        self.assertEqual(report.ctp_cases, ())


    def test_model_agreement_with_one_shared_group_is_not_independent_support(self):
        claim = Claim("c-models", "market", "demand", "high", "region", "2026", "survey")
        evidence = (
            Evidence("m1", "model-a", "c-models", True, independent_group="same-training-corpus"),
            Evidence("m2", "model-b", "c-models", True, independent_group="same-training-corpus"),
            Evidence("m3", "model-c", "c-models", True, independent_group="same-training-corpus"),
        )

        decision = review_proof((claim,), evidence).claim_reviews[0]

        self.assertEqual(decision.status, "supported_by_recorded_evidence")
        self.assertEqual(decision.independent_supporting_group_count, 1)
        self.assertFalse(decision.independent_support_demonstrated)
        self.assertTrue(any("independent" in issue.lower() for issue in decision.unresolved_questions))

    def test_independent_support_requires_two_distinct_supporting_groups(self):
        claim = Claim("c-independent", "plant", "output", "1 ton/day", "line-a", "2026", "measured")
        evidence = (
            Evidence("e1", "calibrated sensor", "c-independent", True, independent_group="sensor-run"),
            Evidence("e2", "independent inspector", "c-independent", True, independent_group="inspector-run"),
        )

        decision = review_proof((claim,), evidence).claim_reviews[0]

        self.assertEqual(decision.independent_supporting_group_count, 2)
        self.assertTrue(decision.independent_support_demonstrated)


    def test_counterevidence_group_does_not_inflate_independent_support_count(self):
        claim = Claim("c-mixed", "reactor", "temperature", "180 C", "line-a", "2026", "calibrated")
        evidence = (
            Evidence("support-1", "sensor", "c-mixed", True, independent_group="supporting-run"),
            Evidence("counter-1", "inspection", "c-mixed", False, independent_group="counter-run"),
        )

        decision = review_proof((claim,), evidence).claim_reviews[0]

        self.assertEqual(decision.status, "contested")
        self.assertEqual(decision.independent_supporting_group_count, 1)
        self.assertFalse(decision.independent_support_demonstrated)


if __name__ == "__main__":
    unittest.main()
