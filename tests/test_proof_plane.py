import unittest
from master_brain.core import Claim, Evidence
from master_brain.proof_plane import review_proof

class ProofPlaneTests(unittest.TestCase):
    def test_conflict_is_preserved(self):
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

    def test_orphan_evidence_is_reported(self):
        report = review_proof((), (Evidence("e1", "report", "unknown-claim", True),))
        self.assertTrue(report.unresolved_issues)

if __name__ == "__main__":
    unittest.main()
