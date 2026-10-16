import unittest

from master_brain.core import (
    Claim, Evidence, Maturity, Opportunity, RiskTier, Task,
    assess_contradictions, evaluate_claim, route_task, score_opportunity,
)


class RoutingTests(unittest.TestCase):
    def test_high_risk_requires_approval(self):
        route = route_task(Task("research and verify supplier", risk=RiskTier.HIGH))
        self.assertTrue(route.requires_approval)
        self.assertEqual(route.specialist, "research_and_proof")

    def test_malformed_external_action_flag_fails_closed_for_approval(self):
        task = Task(
            "ordinary planning request",
            risk=RiskTier.LOW,
            requires_external_action=1,
        )
        self.assertTrue(route_task(task).requires_approval)

    def test_unknown_risk_fails_closed_for_approval(self):
        route = route_task(Task("help with a plan", risk="unrecognized"))
        self.assertTrue(route.requires_approval)

    def test_keyword_matching_uses_word_boundaries(self):
        route = route_task(Task("I am reinvesting in a factory"))
        self.assertNotEqual(route.specialist, "opportunity_engine")

    def test_opportunity_routes_to_opportunity_engine(self):
        route = route_task(Task("prioritize business opportunities"))
        self.assertEqual(route.specialist, "opportunity_engine")


class ContradictionTests(unittest.TestCase):
    def test_contradiction_assessment_rejects_malformed_claim_inputs(self):
        with self.assertRaisesRegex(ValueError, "claims must be a sequence of Claim instances"):
            assess_contradictions(None)
        with self.assertRaisesRegex(ValueError, "claims must contain only Claim instances"):
            assess_contradictions((None,))

        malformed = Claim("claim-x", "plant", "output", None)
        with self.assertRaisesRegex(ValueError, "claim value must be a string"):
            assess_contradictions((malformed,))

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

    def test_claim_without_matching_evidence_is_not_marked_tested(self):
        """Finding (TESTED without evidence): every decision, even 'unverified', was TESTED."""
        claim = Claim("c1", "plant", "capacity", "1 ton/day")
        cases = {
            "no evidence": [],
            "evidence for another claim": [Evidence("x", "src", "other", True)],
            "invalid record only": [object()],
            "blank source": [Evidence("e1", "  ", "c1", True)],
        }
        for label, evidence in cases.items():
            with self.subTest(label=label):
                result = evaluate_claim(claim, evidence)
                self.assertEqual(result.status, "unverified")
                self.assertEqual(result.maturity, Maturity.PROPOSED)

    def test_claim_with_matching_evidence_is_marked_tested_in_every_status(self):
        claim = Claim("c1", "plant", "capacity", "1 ton/day")
        for label, evidence, status in (
            ("support", [Evidence("e1", "s", "c1", True)], "supported_by_recorded_evidence"),
            ("oppose", [Evidence("e1", "s", "c1", False)], "challenged_by_recorded_evidence"),
            ("both", [Evidence("e1", "s", "c1", True), Evidence("e2", "s2", "c1", False)], "contested"),
        ):
            with self.subTest(label=label):
                result = evaluate_claim(claim, evidence)
                self.assertEqual(result.status, status)
                self.assertEqual(result.maturity, Maturity.TESTED)

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

    def test_invalid_evidence_polarity_cannot_be_counted_as_support(self):
        claim = Claim("c-invalid-polarity", "plant", "output", "100")
        malformed = Evidence("e-invalid", "measurement", "c-invalid-polarity", "yes")
        result = evaluate_claim(claim, (malformed,))
        self.assertEqual(result.status, "unverified")
        self.assertTrue(any("invalid evidence record" in issue.lower()
                            for issue in result.unresolved_questions))

    def test_direct_claim_review_rejects_invalid_claim_contract(self):
        with self.assertRaisesRegex(ValueError, "claim must be a Claim instance"):
            evaluate_claim(None, ())

        malformed = Claim(None, "plant", "output", "100")
        with self.assertRaisesRegex(ValueError, "claim_id must be a non-empty string"):
            evaluate_claim(malformed, ())

    def test_direct_claim_review_rejects_non_iterable_evidence_cleanly(self):
        claim = Claim("claim-evidence-input", "plant", "output", "100")
        with self.assertRaisesRegex(ValueError, "evidence must be iterable"):
            evaluate_claim(claim, None)

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
