import unittest

from master_brain.core import (
    Claim, Evidence, Opportunity, RiskTier, Task,
    assess_contradictions, evaluate_claim, route_task, score_opportunity,
)


class RoutingTests(unittest.TestCase):
    def test_high_risk_requires_approval(self):
        route = route_task(Task("research and verify supplier", risk=RiskTier.HIGH))
        self.assertTrue(route.requires_approval)
        self.assertEqual(route.specialist, "research_and_proof")

    def test_opportunity_routes_to_opportunity_engine(self):
        route = route_task(Task("prioritize business opportunities"))
        self.assertEqual(route.specialist, "opportunity_engine")


class ContradictionTests(unittest.TestCase):
    def test_same_scope_different_values_flagged(self):
        claims = [
            Claim("c1", "material", "density", "0.20", "batch-A", "2026-Q3", "g/cm3"),
            Claim("c2", "material", "density", "0.25", "batch-A", "2026-Q3", "g/cm3"),
        ]
        self.assertEqual(len(assess_contradictions(claims)), 1)

    def test_different_time_scope_not_flagged(self):
        claims = [
            Claim("c1", "material", "density", "0.20", "batch-A", "2026-Q2", "g/cm3"),
            Claim("c2", "material", "density", "0.25", "batch-A", "2026-Q3", "g/cm3"),
        ]
        self.assertEqual(assess_contradictions(claims), [])


class EvidenceTests(unittest.TestCase):
    def test_support_and_counterevidence_remain_visible(self):
        claim = Claim("c1", "plant", "capacity", "1 ton/day")
        evidence = [
            Evidence("e1", "supplier quote", "c1", True, independent_group="supplier"),
            Evidence("e2", "site measurement", "c1", False, independent_group="site"),
        ]
        result = evaluate_claim(claim, evidence)
        self.assertEqual(result.status, "contested")
        self.assertEqual(result.supporting_evidence, ("e1",))
        self.assertEqual(result.counterevidence, ("e2",))

    def test_duplicate_evidence_ids_cannot_inflate_direct_claim_review(self):
        claim = Claim("c-duplicate", "plant", "output", "100")
        evidence = (
            Evidence("same-id", "source-a", "c-duplicate", True, independent_group="group-a"),
            Evidence("same-id", "source-b", "c-duplicate", True, independent_group="group-b"),
        )

        result = evaluate_claim(claim, evidence)

        self.assertEqual(result.supporting_evidence, ())
        self.assertEqual(result.independent_supporting_group_count, 0)
        self.assertFalse(result.independent_support_demonstrated)
        self.assertTrue(any("duplicate evidence id" in issue.lower()
                            for issue in result.unresolved_questions))

    def test_non_evidence_objects_are_excluded_from_direct_claim_review(self):
        from types import SimpleNamespace

        claim = Claim("c-invalid", "plant", "output", "100")
        result = evaluate_claim(
            claim, (SimpleNamespace(evidence_id="e1", claim_id="c-invalid"),)
        )
        self.assertEqual(result.status, "unverified")
        self.assertTrue(any("invalid evidence record" in issue.lower()
                            for issue in result.unresolved_questions))

    def test_no_evidence_is_unverified(self):
        claim = Claim("c1", "claim", "predicate", "value")
        self.assertEqual(evaluate_claim(claim, []).status, "unverified")


class OpportunityTests(unittest.TestCase):
    def test_score_clamps_large_finite_integer_inputs(self):
        item = Opportunity("large-integer", 10 ** 1000, 0.5, 0.5, 0.5, 0.5)
        score = score_opportunity(item)
        self.assertGreaterEqual(score, 0.0)
        self.assertLessEqual(score, 1.0)

    def test_score_rejects_non_finite_inputs(self):
        item = Opportunity("invalid", float("nan"), 0.5, 0.5, 0.5, 0.5)
        with self.assertRaisesRegex(ValueError, "finite numbers"):
            score_opportunity(item)

    def test_score_is_bounded(self):
        item = Opportunity("option", 1.5, -1, 0.5, 0.5, 0.5, 2)
        score = score_opportunity(item)
        self.assertGreaterEqual(score, 0.0)
        self.assertLessEqual(score, 1.0)


if __name__ == "__main__":
    unittest.main()
