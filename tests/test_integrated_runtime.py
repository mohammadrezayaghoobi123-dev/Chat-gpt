import unittest

from master_brain.core import Claim, Evidence
from master_brain.integrated_runtime import IslandResult, execute_mission
from master_brain.meta_intelligence import Mission, ReviewLevel


class IntegratedRuntimeTests(unittest.TestCase):
    def test_one_mission_runs_selected_islands_and_reviews_cross_island_evidence(self):
        calls = []

        def industrial(mission):
            calls.append(("industrial", mission.objective))
            claim = Claim("capacity-a", "line-A", "daily_capacity", "1 ton/day", "factory", "2026", "finished product")
            return IslandResult(
                island_id="industrial",
                summary="Supplier claims one ton/day.",
                claims=(claim,),
                evidence=(Evidence("quote", "supplier quote", "capacity-a", True, independent_group="supplier"),),
                provenance=("supplier quotation",),
            )

        def accounting(mission):
            calls.append(("accounting", mission.objective))
            claim = Claim("capacity-b", "line-A", "daily_capacity", "700 kg/day", "factory", "2026", "finished product")
            return IslandResult(
                island_id="accounting",
                summary="Independent cost review found a different capacity figure.",
                claims=(claim,),
                evidence=(Evidence("inspection", "independent inspection", "capacity-b", False, independent_group="inspector"),),
                provenance=("independent inspection report",),
            )

        run = execute_mission(
            Mission(
                "Compare factory production capacity, market price and cash flow",
                success_criteria=("show evidence and conflicts",),
                risk_tier="medium",
            ),
            executors={"industrial": industrial, "accounting": accounting},
        )

        self.assertIn(("industrial", "Compare factory production capacity, market price and cash flow"), calls)
        self.assertIn(("accounting", "Compare factory production capacity, market price and cash flow"), calls)
        self.assertEqual({result.island_id for result in run.results}, {"industrial", "accounting"})
        self.assertEqual(len(run.contradictions), 1)
        self.assertEqual(run.status, "needs_review")
        self.assertIn("supplier quotation", run.provenance)
        self.assertEqual(run.plan.original_objective, "Compare factory production capacity, market price and cash flow")

    def test_missing_executor_is_reported_not_claimed_as_executed(self):
        run = execute_mission(
            Mission("Research scientific evidence for factory materials", risk_tier="low"),
            executors={},
        )
        self.assertEqual(run.results, ())
        self.assertTrue(run.missing_islands)
        self.assertEqual(run.status, "incomplete")
        self.assertTrue(all("not executed" in item.lower() for item in run.missing_islands))

    def test_high_risk_mission_does_not_dispatch_without_digest_bound_approval(self):
        calls = []
        run = execute_mission(
            Mission("Compare supplier offers and commit to purchase", risk_tier="high"),
            executors={"general": lambda mission: calls.append(mission) or IslandResult("general", "done")},
        )
        self.assertEqual(calls, [])
        self.assertEqual(run.status, "approval_required")
        self.assertEqual(run.results, ())

    def test_unknown_risk_tier_fails_closed_before_dispatch(self):
        calls = []
        run = execute_mission(
            Mission("Research scientific evidence for this material", risk_tier="unknown"),
            executors={"science_research": lambda mission: calls.append(mission) or IslandResult("science_research", "done")},
        )
        self.assertEqual(calls, [])
        self.assertEqual(run.status, "needs_clarification")
        self.assertTrue(run.unresolved_issues)

    def test_executor_failure_is_recorded_as_partial_not_success(self):
        def broken(mission):
            raise TimeoutError("provider timeout")
        run = execute_mission(
            Mission("Research scientific evidence for factory materials", risk_tier="low"),
            executors={"science_research": broken},
        )
        self.assertTrue(run.execution_errors)
        self.assertEqual(run.status, "incomplete")
        self.assertFalse(run.results)

    def test_human_gated_mission_does_not_dispatch_without_approval(self):
        calls = []
        run = execute_mission(
            Mission("Execute irreversible supplier contract action", risk_tier="critical", irreversible_action=True),
            executors={"general": lambda mission: calls.append(mission) or IslandResult("general", "done")},
        )
        self.assertEqual(calls, [])
        self.assertEqual(run.status, "approval_required")
        self.assertEqual(run.results, ())
        self.assertEqual(run.plan.review_level, ReviewLevel.HUMAN_GATED)


if __name__ == "__main__":
    unittest.main()
