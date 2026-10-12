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

    def test_orphan_evidence_is_reported(self):
        report = review_proof((), (Evidence("e1", "report", "unknown-claim", True),))
        self.assertTrue(report.unresolved_issues)
        self.assertEqual(report.ctp_cases, ())


if __name__ == "__main__":
    unittest.main()
