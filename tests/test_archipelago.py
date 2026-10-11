import unittest

from master_brain.archipelago import Island, plan_mission


class ArchipelagoPlanningTests(unittest.TestCase):
    def test_industrial_and_finance_mission_selects_multiple_islands(self):
        plan = plan_mission(
            "Compare factory production machines, market demand, investment, and cash flow"
        )
        selected = {assignment.island_id for assignment in plan.assignments}
        self.assertIn("general", selected)
        self.assertIn("industrial", selected)
        self.assertIn("economics", selected)
        self.assertIn("accounting", selected)

    def test_shared_foundations_are_always_present(self):
        plan = plan_mission("Write software and verify security")
        self.assertIn("proof_plane", plan.shared_foundations)
        self.assertIn("security_and_policy", plan.shared_foundations)

    def test_missing_general_is_reported_as_gap(self):
        plan = plan_mission("Investigate evidence", islands=[
            Island("science_research", "Research", ("evidence",), "Research")
        ])
        self.assertEqual(plan.capability_gaps, ("general",))

    def test_disabled_island_is_not_selected(self):
        plan = plan_mission("factory production", islands=[
            Island("general", "General", ("plan",), "General"),
            Island("industrial", "Industrial", ("factory",), "Industrial", enabled=False),
        ])
        self.assertNotIn("industrial", {a.island_id for a in plan.assignments})

    def test_empty_objective_is_non_destructive_and_flagged(self):
        plan = plan_mission("")
        self.assertTrue(any("empty" in note.lower() for note in plan.rationale))


if __ (name__) == "__main__":
    unittest.main()
