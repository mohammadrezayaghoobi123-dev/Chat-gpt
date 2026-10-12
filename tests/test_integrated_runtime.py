import json
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

        objective = "Compare factory production capacity, market price and cash flow"
        run = execute_mission(
            Mission(objective, success_criteria=("show evidence and conflicts",), risk_tier="medium"),
            executors={"industrial": industrial, "accounting": accounting},
        )

        self.assertIn(("industrial", objective), calls)
        self.assertIn(("accounting", objective), calls)
        self.assertEqual({result.island_id for result in run.results}, {"industrial", "accounting"})
        self.assertEqual(len(run.contradictions), 1)
        self.assertEqual(run.status, "needs_review")
        self.assertIn("supplier quotation", run.provenance)
        self.assertEqual(run.plan.original_objective, objective)

        self.assertEqual(len(run.ctp_cases), 1)
        self.assertEqual(run.ctp_cases[0].claim_ids, ("capacity-a", "capacity-b"))
        self.assertTrue(run.ctp_cases[0].validate() == ())
        self.assertEqual(run.ctp_cases[0].tests[0].status.value, "not_run")

        records = run.audit_records
        self.assertTrue(any(record.event_type == "mission_run" and record.status == run.status for record in records))
        self.assertTrue(any(record.event_type == "claim_review" and record.output_refs == ("capacity-a",) for record in records))
        self.assertTrue(any(
            record.event_type == "contradiction_detected"
            and set(record.input_refs) == {"capacity-a", "capacity-b"}
            for record in records
        ))
        self.assertTrue(any(
            record.event_type == "ctp_case_planned"
            and record.status == "planned_not_run"
            for record in records
        ))
        self.assertTrue(all(objective not in record.to_stable_json() for record in records))
        self.assertTrue(all(json.loads(record.to_stable_json())["schema_version"] == 1 for record in records))

    def test_audit_review_status_stays_attached_to_its_claim_when_an_id_is_blank(self):
        def science(mission):
            return IslandResult(
                island_id="science_research",
                summary="Synthetic fixture with one malformed reference.",
                claims=(
                    Claim("", "polymer", "safe", "unknown"),
                    Claim("claim-valid", "polymer", "safe", "yes"),
                ),
                evidence=(Evidence("evidence-valid", "fixture", "claim-valid", True),),
            )

        run = execute_mission(
            Mission("Research scientific evidence for a polymer material", risk_tier="low"),
            executors={"science_research": science},
        )
        by_ref = {
            record.output_refs[0]: record.status
            for record in run.audit_records
            if record.event_type == "claim_review" and record.output_refs
        }
        self.assertEqual(by_ref["claim-valid"], "supported_by_recorded_evidence")

    def test_unresolved_planning_gaps_prevent_false_completed_status(self):
        run = execute_mission(
            Mission("hello there", risk_tier="low"),
            executors={},
        )
        self.assertNotEqual(run.status, "completed_with_recorded_results")
        self.assertTrue(run.unresolved_issues)
        self.assertTrue(any("specialist" in issue.lower() or "context" in issue.lower()
                            for issue in run.unresolved_issues))

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
        self.assertEqual(run.audit_records[0].event_type, "mission_run")
        self.assertEqual(run.audit_records[0].status, "approval_required")

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
