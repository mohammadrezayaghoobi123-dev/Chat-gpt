import unittest

from master_brain.meta_intelligence import (
    IslandProfile,
    Mission,
    ReviewLevel,
    plan_coordination,
)


class MetaIntelligenceTests(unittest.TestCase):
    def test_cross_domain_request_selects_multiple_islands(self):
        plan = plan_coordination(Mission(
            "Compare factory production machines, market demand, investment and cash flow",
            success_criteria=("costed comparison",),
            risk_tier="high",
        ))
        selected = {s.island_id for s in plan.selections}
        self.assertIn("industrial", selected)
        self.assertIn("economics", selected)
        self.assertIn("accounting", selected)
        self.assertEqual(plan.review_level, ReviewLevel.STRICT)

    def test_irreversible_mission_requires_human_gate(self):
        plan = plan_coordination(Mission(
            "Plan and evaluate a supplier contract decision",
            irreversible_action=True,
        ))
        self.assertEqual(plan.review_level, ReviewLevel.HUMAN_GATED)
        self.assertTrue(any("approval" in step.lower() for step in plan.verification_steps))

    def test_keyword_matching_does_not_match_inside_unrelated_words(self):
        plan = plan_coordination(Mission("I need a comfortable chair for my office"))
        self.assertNotIn("software_ai", {selection.island_id for selection in plan.selections})

    def test_empty_objective_requests_clarification(self):
        plan = plan_coordination(Mission(""))
        self.assertTrue(plan.clarification_questions)
        self.assertTrue(plan.unknowns)

    def test_disabled_island_is_not_selected(self):
        plan = plan_coordination(Mission("factory production machine planning"), profiles=(
            IslandProfile("industrial", ("factory",), enabled=False),
            IslandProfile("general", ("planning",)),
        ))
        self.assertNotIn("industrial", {s.island_id for s in plan.selections})
        self.assertTrue(plan.capability_gaps)

    def test_budget_and_deadline_are_bounded(self):
        plan = plan_coordination(Mission("Plan a strategy for software architecture", budget_units=-2, deadline_seconds=0))
        self.assertEqual(plan.budget_units, 0)
        self.assertEqual(plan.deadline_seconds, 1)

    def test_original_objective_is_preserved(self):
        objective = "  Analyze market demand  "
        plan = plan_coordination(Mission(objective))
        self.assertEqual(plan.original_objective, objective)

    def test_unrecognized_risk_tier_is_flagged(self):
        plan = plan_coordination(Mission("Plan a market analysis project", risk_tier="unknown"))
        self.assertTrue(any("risk tier" in item.lower() for item in plan.unknowns))


if __name__ == "__main__":
    unittest.main()
